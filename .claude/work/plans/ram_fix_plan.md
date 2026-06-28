# RAM Budget Fix Plan — Community Wisdom Applied

**Status:** `needs design` → `ready to build`

**Problem:** All our scripts exceed their target servers' RAM. game_agent = 9.15 GB (home=8), strategy_agent = 40 GB (foodnstuff=16), simple_hack_loop = 4.2 GB (n00dles=4). The root cause: we directly reference expensive `ns.*` functions instead of RAM-dodging them through temp scripts.

**Source of truth:** `docs/community_wisdom.md` — 4 community repos analyzed, unanimous on RAM dodging.

---

## Root Cause Analysis

The game calculates RAM by counting every unique `ns.<function>` reference in a script's AST. Each function has a fixed cost (e.g., `ns.exec` = 1.3 GB, `ns.singularity.*` = 10+ GB). The script's total RAM = base (1.6 GB) + sum of all unique ns function costs.

Our manual estimates were wrong because:
1. We missed that `ns.singularity.*` functions cost 10+ GB each
2. We didn't account for all ns references spread across 734 lines
3. Every `ns.write`, `ns.read`, `ns.exec`, `ns.scriptRunning` adds up

### strategy_agent.ts (40 GB) — ns function usage

| ns function | Cost (GB) | Can RAM-dodge? |
|---|---|---|
| `ns.singularity.*` | ~15+ | **YES — must** |
| `ns.exec` | 1.3 | Keep (needed for dispatching) |
| `ns.run` | 1.0 | Keep |
| `ns.scriptRunning` | 1.0 | Replace with `ns.isRunning` (0.1) |
| `ns.write` | 1.0 | RAM-dodge |
| `ns.read` | 1.0 | RAM-dodge |
| `ns.scp` | 0.6 | Keep (needed for deploy) |
| `ns.kill` | 0.5 | Keep |
| `ns.getPlayer` | 0.3 | RAM-dodge |
| `ns.getServer` | 0.3 | Keep (needed every tick) |
| `ns.scan` | 0.2 | Keep |
| `ns.isRunning` | 0.1 | Keep |
| `ns.getServerNumPortsRequired` | 0.1 | RAM-dodge (use getServer result) |
| `ns.hasTorRouter` | 0.1 | RAM-dodge |
| `ns.getHostname` | 0.05 | Keep (one-time) |
| Port functions | 0 | Keep |
| Base | 1.6 | Unavoidable |

**After RAM-dodging:** ~1.6 + 1.3 + 1.0 + 0.6 + 0.5 + 0.3 + 0.2 + 0.1 + 0.05 = ~5.65 GB → fits on foodnstuff (16 GB)

BUT: strategy_agent should NOT be always-running. It should fire, decide, write results, and EXIT. The always-running daemon should be < 3 GB.

---

## Architecture: What Changes

### Design Principle (from community)
```
Always-running daemon (< 3 GB) → dispatches workers, monitors heartbeats
     ↑
Strategy script (~6 GB, runs briefly) → decides what to do, writes decisions, exits
     ↑
Temp scripts (1.6-2 GB each) → do ONE expensive operation, write result to file, exit
```

### New Script Architecture

```
home (8 GB) — Always running:
├── game_agent.ts     (~2.5 GB)  Command relay + port→file mirror ONLY
│   - ns.exec, ns.isRunning, ns.readPort, ns.writePort, ns.peek, ns.clearPort
│   - ns.sleep, ns.print, ns.disableLog
│   - NO: ns.write, ns.read, ns.getPlayer, ns.getServer, ns.scriptKill, ns.killall
│   - NO: status snapshots (moved to separate reporter script)
│
├── reporter.js       (~2 GB, temp script)  Writes status files, exits
│   - Runs every 5s via game_agent scheduling
│   - ns.getPlayer, ns.getServerMaxRam, ns.getServerUsedRam, ns.ps
│   - ns.write (player.txt, ram.txt, processes.txt)
│   - Exits after writing → RAM freed
│
foodnstuff (16 GB) — Runs briefly:
├── strategy_agent.ts (~6 GB, runs briefly)  Decision-maker
│   - Snapshot game state, detect phase, decide actions
│   - Write decisions to port 4 + status/decisions.json
│   - Exit after each cycle (relaunched by game_agent every 30s)
│   - ALL expensive calls RAM-dodged through temp scripts
│
├── snapshot.js       (~2 GB, temp script)  Game state snapshot
│   - ns.getServer for all rooted servers
│   - ns.getPlayer
│   - Writes to port or file
│   - Exits
│
Any rooted server:
├── hack.js           (~1.75 GB)  Single hack operation
├── grow.js           (~1.75 GB)  Single grow operation  
├── weaken.js         (~1.75 GB)  Single weaken operation
├── simple_hack_loop.js (~2.5 GB) Sequential H→W→G→W loop
```

### RAM Dodging Implementation

Template for RAM-dodging an expensive ns call:

```typescript
// Instead of this (costs the ns function's RAM in YOUR script):
const player = ns.getPlayer();

// Do this (costs only 1.0 GB for ns.run):
function ramDodge<T>(ns: NS, fnCall: string): T {
  const scriptPath = `/Temp/dodge_${Date.now()}.js`;
  const code = `
    export async function main(ns) {
      ns.write('/Temp/result_${Date.now()}.txt', 
        JSON.stringify(${fnCall}), 'w');
    }
  `;
  ns.write(scriptPath, code, 'w');
  ns.run(scriptPath, 1);
  while (ns.isRunning(scriptPath)) { /* wait */ }
  const result = ns.read('/Temp/result_${Date.now()}.txt');
  ns.rm(scriptPath);
  ns.rm('/Temp/result_${Date.now()}.txt');
  return JSON.parse(result);
}
```

BUT: this pattern itself requires `ns.write`, `ns.read`, `ns.rm` — which cost RAM. So the RAM-dodging infrastructure must be in a SEPARATE script from the always-running daemon.

**Better pattern (from community):** The strategy script (which already has ns.write/ns.read for decisions) does the RAM dodging. The always-running daemon does NOT ram-dodge — it simply doesn't import expensive functions at all.

---

## Implementation Plan

### Phase 1: Slim game_agent.ts to < 4 GB (target: ~2.5 GB)

**Remove from game_agent.ts:**
- Status snapshots (writeStatusFiles) → move to separate reporter.js
- getPlayer command → remove from relay
- getServer command → keep but RAM-dodge (write temp script, run it, read result)
- ns.write, ns.read, ns.rm → keep for command relay (needed for .cmd.json/.result.json)
- ns.killall → remove (kill specific scripts instead)
- ns.scriptKill → remove (use ns.kill which is cheaper at 0.5 GB)

**Keep in game_agent.ts:**
- ns.exec (1.3 GB) — needed to launch scripts
- ns.isRunning (0.1 GB) — check if scripts are alive
- ns.readPort (0 GB), ns.writePort (0 GB), ns.peek (0 GB), ns.clearPort (0 GB)
- ns.write (1.0 GB), ns.read (1.0 GB), ns.rm (1.0 GB) — command relay needs these
- ns.sleep (0 GB), ns.print (0 GB), ns.disableLog (0 GB)
- ns.getHostname (0.05 GB) — one-time

**Estimated after slimming:** 1.6 + 1.3 + 0.1 + 1.0 + 1.0 + 1.0 + 0.05 = 6.05 GB — STILL over.

We need more aggressive slimming. The command relay needs ns.write/ns.read/ns.rm for the file-based relay. But we can trade:
- Instead of game_agent reading .cmd.json itself, we make it port-based (read commands from port 1, write results to port 2)
- Then we don't need ns.write, ns.read, ns.rm in game_agent!
- But then Claude can't send commands via MCP... which needs the file relay.

**Hybrid approach:**
- Keep file-based relay (ns.write, ns.read, ns.rm) — these are 3 × 1.0 GB = 3.0 GB
- Drop ns.exec (1.3 GB) — use ns.run (1.0 GB) instead
- Drop ALL other expensive functions

**game_agent minimal set:**
- ns.run (1.0 GB), ns.write (1.0 GB), ns.read (1.0 GB), ns.rm (1.0 GB)
- ns.isRunning (0.1 GB), ns.getHostname (0.05 GB)
- ns.readPort (0 GB), ns.writePort (0 GB), ns.peek (0 GB), ns.clearPort (0 GB)
- ns.sleep (0 GB), ns.print (0 GB), ns.disableLog (0 GB), ns.fileExists (0 GB)
- Base: 1.6 GB
- **Total: 1.6 + 1.0 + 1.0 + 1.0 + 1.0 + 0.1 + 0.05 = 6.75 GB** — still over!

Wait, that's still 6.75 GB. Let me reconsider...

The fundamental issue: the file-based command relay REQUIRES ns.write + ns.read + ns.rm = 3 GB. That's the minimum cost of the relay protocol.

Options:
1. **Switch to port-based relay only** → drop ns.write/ns.read/ns.rm, use only ports → 1.6 + 1.0 (ns.run) + 0.1 (isRunning) = 2.7 GB! But Claude can only write ports via MCP, and write_port MCP tool goes through... game_agent's file relay. Chicken and egg.

2. **Keep file relay, split the rest** → game_agent keeps command relay (6.75 GB). Status reporter is separate temp script. Port mirror is separate. 6.75 GB fits on home (8 GB) with 1.25 GB to spare.

3. **Two-phase bootstrap** → Phase 1: use a TINY script (~2 GB) that just hacks. Phase 2: once home RAM is upgraded to 16 GB, launch the full game_agent.

### Decision: Option 2 + 3 Hybrid

**Phase 1 (8 GB home):**
- Run `simple_hack_loop.js` (~2.5 GB stripped version) directly on n00dles or home
- This generates initial income
- Buy home RAM upgrade to 16 GB ASAP (~$256,000)

**Phase 2 (16 GB home):**
- game_agent.js (6.75 GB) — command relay + port mirror
- boot_agent.js (4.65 GB) — port-based relay
- strategy_agent.js runs on foodnstuff (16 GB), brief execution

Actually wait — that doesn't work either. If game_agent requires 6.75 GB and boot_agent requires 4.65 GB, that's 11.4 GB on home, which still doesn't fit on 16 GB when you account for the OS/other scripts.

Let me think about this differently...

### The Real Fix: Port-Based Architecture (Zharay pattern)

Looking at the community wisdom again: Zharay's botnet uses ZERO file I/O. Everything is ports. This is the key insight.

**boot_agent.ts already IS port-based.** It uses ports 1/2/3. Cost: 4.65 GB.

**What if we make game_agent ALSO port-based?** Instead of file relay, it reads commands from a port and writes results to a port. Then we drop ns.write/ns.read/ns.rm entirely from game_agent.

But how does Claude send the initial command? **We add a bootstrap mechanism:**
1. On startup, a tiny init script reads a bootstrap file ONCE (ns.read costs 0 GB? No, it costs 1.0 GB in the init script)
2. After bootstrap, everything is port-based

Actually, the cleanest approach:

```
boot_agent.ts (~3 GB target) — always running on home
  - Port-based IPC only (ports 1/2/3/4)
  - No file I/O
  - Commands arrive on port 1, results on port 2
  - Heartbeat on port 3

game_agent.ts → RENAMED to reporter.ts
  - Runs briefly every 5s
  - Writes status files (player.txt, ram.txt, processes.txt)
  - Reads port 4 (decisions) → writes decisions_port.txt
  - Reads port 3 (heartbeat) → writes heartbeat.txt
  - Exits after each cycle → RAM freed

Claude → MCP write_port → port 1 → boot_agent reads → executes
Claude ← MCP read_port ← port 2 ← boot_agent writes result
Claude ← MCP read_file ← status/*.txt ← reporter writes
```

BUT: the MCP write_port/read_port tools use game_agent's file relay! We need to fix that.

**New MCP port tools that DON'T use game_agent:**
- `write_port`: writes a command file, waits for boot_agent to pick it up via a port
- Actually this still needs file I/O somewhere...

OK here's the real solution following community patterns:

### Final Architecture

1. **MCP command bootstrap**: MCP pushes a command file (`/Temp/cmd.json`). boot_agent reads it ONCE at startup and then switches to port-based operation.

2. **boot_agent.ts (target < 4 GB)**: 
   - At startup: read `/Temp/init_cmd.json` if exists → process → write `/Temp/init_result.json`
   - Main loop: read port 1 for commands, write port 2 for results, monitor port 3 heartbeat
   - Drop: ns.scriptKill (1.0 GB) → use ns.kill (0.5 GB)
   - Drop: ns.exec (1.3 GB) → use ns.run (1.0 GB) + ns.scp (0.6 GB if needed)
   - Total: 1.6 + 0.5 + 1.0 + 0.6 + port functions (0) + sleep/print (0) = 3.7 GB

3. **reporter.js (temp script, runs every 5s)**:
   - Gets player, RAM, processes
   - Writes status files
   - Exits → RAM freed
   - Launched by boot_agent or game_agent

4. **strategy_agent.ts (on foodnstuff, runs briefly)**:
   - RAM-dodge ns.singularity.* through temp scripts
   - RAM-dodge ns.getPlayer through temp scripts or reporter files
   - Write decisions to port 4
   - Exit after cycle

---

## Summary of Changes

| Script | Current RAM | Target RAM | Changes |
|---|---|---|---|
| game_agent.ts | 9.15 GB | N/A → **SPLIT** | Split into boot_agent + reporter |
| boot_agent.ts | 4.65 GB | < 4 GB | Drop scriptKill, exec; keep run+scp |
| strategy_agent.ts | 40 GB | < 16 GB | RAM-dodge singularity + getPlayer |
| simple_hack_loop.ts | 4.2 GB | < 4 GB | Tiny optimization |
| **NEW** reporter.js | — | < 4 GB | Temp script, runs every 5s, exits |

## Open Decisions

1. **File relay vs port relay for MCP commands:** The current MCP port tools depend on game_agent's file relay. Should we:
   - A) Keep game_agent as file relay (6.75 GB) + move everything else out
   - B) Make boot_agent bootstrap from a file then go port-only, update MCP tools accordingly
   - C) Accept that we need 16 GB home before the full system works

2. **Singularity RAM dodging:** `ns.singularity.purchaseProgram()` costs ~15+ GB. Should we:
   - A) RAM-dodge it through a temp script (adds complexity)
   - B) Remove it from strategy_agent entirely — accept that port opener purchasing is manual on BN-1
   - C) Use DOM terminal injection instead (as documented in the original plan)

3. **Status reporter as temp script vs always-running:** 
   - A) Temp script (runs 5s, exits, RAM freed) — simpler but spawn overhead
   - B) Always-running on a non-home server — uses RAM but no spawn overhead
