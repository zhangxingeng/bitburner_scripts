# Observation Bridge + Type Fix Plan

**Goal:** Fix TypeScript errors AND build the observation infrastructure so Claude can continuously monitor and optimize during live testing.

**Problem Statement:** The strategy engine (Wave 4) generates 100% of its monitoring data through port-based IPC and `ns.print()` — both are invisible to Claude via MCP. The only bridge-accessible data is game_agent's 5-second status snapshots (`/status/*.txt`). Without closing this gap, testing would be blind: Claude can deploy code but cannot observe whether it works.

---

## Part A: Fix TypeScript Errors (~15 min)

### A1. Fix `workMoneyGainRate` on Player type

**Root cause:** `src/monitor/game_agent.ts:100,228` references `player.workMoneyGainRate` which doesn't exist in the `Player` interface in `NetscriptDefinitions.d.ts`. This is a runtime property present in the game but missing from the type definitions.

**Fix:** Augment the `Player` interface in `src/types/ns-augment.d.ts`:

```typescript
declare module '@ns' {
    // ... existing NS augmentations ...
    interface Player {
        /** Money earned per second from current work action (crime, job, study). 0 if idle/hacking. */
        workMoneyGainRate?: number;
        /** Reputation earned per second from current work action. */
        workRepGainRate?: number;
    }
}
```

Then fix the two references in game_agent.ts to handle `undefined`:
- Line 100: Already has `?? 0` — keep as-is
- Line 228: Add `?? 0` fallback

---

## Part B: Build the Observation Bridge (~2-3 hours)

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                      CLAUDE                             │
│  MCP Tools: read_port, write_port, get_monitoring       │
└────────────┬────────────────────────────────────────────┘
             │ MCP (stdio)
┌────────────▼────────────────────────────────────────────┐
│              MCP Server (port 12526)                     │
│  Bridges: read_port → push cmd.json → read result.json  │
└────────────┬────────────────────────────────────────────┘
             │ WebSocket
┌────────────▼────────────────────────────────────────────┐
│              Game Bridge (port 12525)                    │
│  Proxies JSON-RPC to game: pushFile, readFile, etc.     │
└────────────┬────────────────────────────────────────────┘
             │ JSON-RPC (limited to file ops)
┌────────────▼────────────────────────────────────────────┐
│              Bitburner Game                              │
│                                                          │
│  game_agent.ts  ←── status/.cmd.json (file relay)       │
│  ├─ NEW: readPort cmd → ns.readPort(port) → result.json │
│  ├─ NEW: writePort cmd → ns.writePort(port, data)       │
│  ├─ Status snapshots: player.txt, ram.txt, processes.txt│
│  └─ NEW: Reads ports 3+4 → writes heartbeat.txt,        │
│           decisions.txt every cycle                      │
│                                                          │
│  strategy_agent.ts                                       │
│  ├─ Port 4: decision log (JSON)                         │
│  ├─ Port 3: heartbeat ("alive")                         │
│  └─ NEW: Also writes status/decisions.json (dual-write) │
│                                                          │
│  boot_agent.ts                                           │
│  ├─ Port 1: inbound commands                            │
│  ├─ Port 2: outbound results                            │
│  └─ Port 3: heartbeat monitor                           │
└─────────────────────────────────────────────────────────┘
```

### B1. Extend game_agent Command Relay with Port Operations (~30 min)

Add two new command methods to `game_agent.ts`:

```
case 'readPort': {
  const portNum = Number(cmd.port ?? 1);
  result.data = ns.readPort(portNum);
  result.success = true;
  break;
}

case 'writePort': {
  const portNum = Number(cmd.port ?? 1);
  const portData = cmd.data;
  if (portData === undefined) { result.error = 'Missing data'; break; }
  const written = ns.writePort(portNum, typeof portData === 'string' ? portData : JSON.stringify(portData));
  result.data = written;  // returns the port data if successful, null if full
  result.success = written !== null;
  break;
}
```

Also add `peekPort` (non-consuming read):
```
case 'peekPort': {
  const portNum = Number(cmd.port ?? 1);
  result.data = ns.peek(portNum);
  result.success = true;
  break;
}
```

Update the `GameCommand` interface to support the new methods:
```
method: 'run' | 'exec' | 'kill' | 'killall' | 'ps' | 'getPlayer' | 'getServer' | 'readPort' | 'writePort' | 'peekPort';
port?: number;
data?: unknown;
```

### B2. Add status/decisions.json Dual-Write to strategy_agent (~20 min)

Currently, strategy_agent writes decisions ONLY to port 4. Add a file-based fallback:

```typescript
// In writeDecisionLog():
const logStr = JSON.stringify(entry);
ns.writePort(PORT_DECISION, logStr);

// NEW: Also write to file for MCP access
try {
  const existing = ns.fileExists(STATUS_DECISIONS_FILE) ? ns.read(STATUS_DECISIONS_FILE) : '[]';
  const decisions = JSON.parse(existing || '[]');
  decisions.push(entry);
  // Keep last 1000 entries to avoid unbounded growth
  if (decisions.length > 1000) decisions.splice(0, decisions.length - 1000);
  ns.write(STATUS_DECISIONS_FILE, JSON.stringify(decisions), 'w');
} catch { /* file write is best-effort */ }
```

Add constant: `STATUS_DECISIONS_FILE = '/status/decisions.json'`

### B3. Add Port Monitor to game_agent (Optional Enhancement) (~30 min)

Add optional periodic port reading to game_agent's status cycle:

```typescript
// In writeStatusFiles() or a new function called each cycle:
function writePortStatus(ns: NS): void {
  // Peek the heartbeat port (port 3) to check strategy agent liveness
  const heartbeat = ns.peek(3);
  if (heartbeat !== null && typeof heartbeat === 'string') {
    writeJson(ns, '/status/heartbeat.txt', { 
      alive: heartbeat === 'alive', 
      lastSeen: Date.now() 
    });
  }
  
  // Read all entries from decision port (port 4)
  const decisions: unknown[] = [];
  let entry = ns.readPort(4);
  while (entry !== null && entry !== 'NULL PORT DATA') {
    try { decisions.push(typeof entry === 'string' ? JSON.parse(entry) : entry); } 
    catch { decisions.push(entry); }
    entry = ns.readPort(4);
  }
  if (decisions.length > 0) {
    writeJson(ns, '/status/decisions_port.txt', decisions);
  }
}
```

This makes port data available as files, bypassing the need for port MCP tools entirely. **This is the simplest path — no MCP tool changes needed.**

### B4. Add MCP Port Tools (~30 min)

Add `read_port` and `write_port` MCP tools to `build/game-bridge-mcp/src/index.ts`.

These use the game_agent command relay:
1. Write a command to `status/.cmd.json` via the bridge RPC
2. Poll for `status/.result.json` (up to 5 seconds timeout)
3. Return the result

```typescript
// Tool: read_port
// Tool: write_port  
// Both: write command file, poll for result file, return data
```

However: **B3 (port monitor in game_agent) is simpler and more reliable** because it avoids the polling/timing issues of the command relay. The MCP tools are useful for write_port (sending commands to boot_agent), but for reads, the file-based approach is preferred.

**Decision: Prioritize B3 (file-based port mirror). Add MCP port tools only if needed for write operations.**

### B5. Add Unified Monitoring MCP Tool (~30 min)

Add `get_monitoring` tool to the MCP server that reads all status files in one call:

```typescript
server.registerTool("get_monitoring", {
  title: "Get Game Monitoring Snapshot",
  description: "Reads all monitoring data (player, RAM, processes, decisions, heartbeat) in one call.",
  // No input params needed
}, async () => {
  const player = await readGameFile('status/player.txt');
  const ram = await readGameFile('status/ram.txt');
  const processes = await readGameFile('status/processes.txt');
  const decisions = await readGameFile('status/decisions.json');
  const heartbeat = await readGameFile('status/heartbeat.txt');
  
  return {
    player: player ? JSON.parse(player) : null,
    ram: ram ? JSON.parse(ram) : null,
    processes: processes ? JSON.parse(processes) : null,
    decisions: decisions ? JSON.parse(decisions) : null,
    heartbeat: heartbeat ? JSON.parse(heartbeat) : null,
    snapshot_ts: Date.now(),
  };
});
```

This is the **single MCP call** Claude uses to understand everything about the game state.

---

## Implementation Order

| Step | What | Depends On | Time |
|---|---|---|---|
| **F1** | Fix Player type augmentation + game_agent.ts TS errors | Nothing | 15min |
| **F2** | Add port commands to game_agent relay (readPort, writePort, peekPort) | F1 | 20min |
| **F3** | Add decisions.json dual-write to strategy_agent | Nothing (different file) | 20min |
| **F4** | Add port monitor to game_agent (ports → files) | F2 | 30min |
| **F5** | Add get_monitoring MCP tool | F4 (files must exist) | 30min |
| **F6** | Add read_port/write_port MCP tools | F2 (relay methods exist) | 30min |
| **F7** | Verify: compilation + MCP tool smoke test | F1-F6 | 30min |

**Total: ~2.75 hours**

**Parallelization:** F1 + F3 can run in parallel (different files). F2 + F4 can be combined by same agent. F5 + F6 can run in parallel.

---

## Verification Criteria

1. `npx tsc --noEmit` — zero new errors (the 2 game_agent errors fixed)
2. MCP `get_monitoring` returns a unified snapshot with all 5 data streams
3. MCP `read_port 4` returns strategy agent decision entries
4. `status/decisions.json` is being written by strategy_agent (confirmed via read_file)
5. All files compile and deploy correctly

---

## What This Enables During Testing

With the observation bridge in place, Claude can:

1. **Call `get_monitoring`** every few seconds during testing to see:
   - Current player stats (hacking level, money, income)
   - RAM usage across all servers (spot over-deployment)
   - Running processes (confirm agents are alive)
   - Strategy decisions (what phase, what actions, why)
   - Heartbeat status (is strategy_agent alive?)

2. **Read decision history** to trace phase transitions and identify oscillation

3. **Write commands to boot_agent** via port 1 to manually trigger actions

4. **Detect anomalies**: phase oscillation, RAM exhaustion, agent crashes, stuck phases

5. **Optimize continuously**: observe income rates → adjust batch parameters → observe improvement
