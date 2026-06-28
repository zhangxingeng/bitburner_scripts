# S2 Build Spec: Strategy Engine Agents

**Source of truth:** `docs/continuous_improvement.md` Sections 4.1-4.6, verified against actual source code (`src/`) and API reference (`docs/bitburner_reference.md`).

---

## Files to Create

| File | Role | RAM Budget | Deploy Target |
|---|---|---|---|
| `src/monitor/boot_agent.ts` | Lightweight command relay on home | ~3.3 GB | home |
| `src/monitor/strategy_agent.ts` | Autonomous brain + phase detection | ~5.9 GB | foodnstuff (or any >=16 GB rooted server) |
| `src/deploy/simple_hack_loop.ts` | Sequential H->W->G->W for SNOWBALL | ~1.8 GB | Any rooted server |

---

## 1. boot_agent.ts (~3.3 GB RAM)

### Purpose
Lightweight command relay running on `home`. Reads commands from **port 1**, executes them via `ns.*` APIs, writes results to **port 2**. Also monitors heartbeat from strategy_agent on **port 3**.

### Port Protocol

| Port | Direction | Content | Format |
|---|---|---|---|
| 1 | Claude -> boot_agent | Incoming commands | JSON command object |
| 2 | boot_agent -> Claude | Command results | JSON result object |
| 3 | strategy_agent -> boot_agent | Heartbeat (every 5s) | `"alive"` string |

### RAM Verification (Optimized)

The plan's 3.9 GB estimate omitted `ns.exec` (needed for remote launches). Verified costs:

| Function | RAM Cost | Used For |
|---|---|---|
| `ns.run(script, threads, ...args)` | 1.0 GB | Launch scripts (local) |
| `ns.exec(script, host, threads, ...args)` | 1.3 GB | Launch scripts on remote servers |
| `ns.kill(pid)` | 0.5 GB | Kill by PID |
| `ns.readPort(port)` | 0 GB | Read commands from port 1 |
| `ns.writePort(port, data)` | 0 GB | Write results to port 2 |
| `ns.peek(port)` | 0 GB | Peek heartbeat on port 3 |
| `ns.clearPort(port)` | 0 GB | Clear port after reading |
| `ns.fileExists(path)` | 0 GB | Check file presence |
| `ns.sleep(ms)` | 0 GB | Loop timing |
| `ns.print(...args)` | 0 GB | Logging |
| `ns.disableLog(fn)` | 0 GB | Suppress log noise |
| `ns.getHostname()` | 0.05 GB | Confirm we're on home |
| **Function total** | **2.85 GB** | |
| Base script overhead | ~1.6 GB | |
| **Total boot_agent** | **~4.45 GB** | **Fits on 8 GB home with ~3.5 GB free** |

**Design tradeoffs:**
- `ns.exec` (1.3 GB) is kept for `exec` command support. If running tight on RAM, this can be removed and boot_agent only handles `run` (local). Remote exec goes through strategy_agent.
- `ns.scriptKill` (1.0 GB) replaced with `ns.kill(pid)` (0.5 GB) by tracking PIDs.
- `ns.scp` (0.6 GB) NOT included — only strategy_agent handles SCP.

### Commands Handled

```typescript
interface BootCommand {
  id: string;
  method: 'exec' | 'run' | 'kill' | 'getState' | 'ps';
  script?: string;
  host?: string;          // for exec (target server)
  threads?: number;
  args?: (string | number | boolean)[];
  pid?: number;           // for kill by PID
}

interface BootResult {
  id: string;
  success: boolean;
  pid?: number;
  data?: unknown;
  error?: string;
}
```

### Main Loop Pseudocode

```
async function main(ns: NS):
  ns.disableLog('ALL')
  ns.print('Boot agent started on home')
  
  let lastHeartbeat = Date.now()
  
  while (true):
    // 1. Read command from port 1 (non-blocking)
    const cmdStr = ns.readPort(1)  // null if empty
    if (cmdStr):
      try:
        const cmd = JSON.parse(cmdStr)
        const result = executeCommand(ns, cmd)
        ns.writePort(2, JSON.stringify(result))
      catch (e):
        ns.writePort(2, JSON.stringify({ id: 'error', success: false, error: String(e) }))
    
    // 2. Check heartbeat from port 3 (peek, doesn't consume)
    const heartbeat = ns.peek(3)
    if (heartbeat === 'alive'):
      lastHeartbeat = Date.now()
    
    // 3. Alert if heartbeat stale
    if (Date.now() - lastHeartbeat > 30000):
      ns.print('WARNING: No strategy agent heartbeat for 30s')
    
    // 4. Sleep
    await ns.sleep(500)
```

### Execute Command Logic

```
function executeCommand(ns: NS, cmd: BootCommand): BootResult:
  const result: BootResult = { id: cmd.id, success: false }

  switch (cmd.method):
    case 'run':
      // Launch script on current server (home)
      const pid = ns.run(cmd.script, cmd.threads ?? 1, ...(cmd.args ?? []))
      result.success = pid > 0
      result.pid = pid
      if (!result.success) result.error = 'ns.run failed'
      break

    case 'exec':
      // Launch script on remote host
      const pid = ns.exec(cmd.script, cmd.host, cmd.threads ?? 1, ...(cmd.args ?? []))
      result.success = pid > 0
      result.pid = pid
      if (!result.success) result.error = 'ns.exec failed on ' + cmd.host
      break

    case 'kill':
      if (cmd.pid):
        result.success = ns.kill(cmd.pid)
      else:
        result.success = ns.scriptKill(cmd.script, cmd.host ?? 'home')
      if (!result.success) result.error = 'kill failed'
      break

    case 'getState':
      result.data = {
        hostname: ns.getHostname(),
        pid: ns.pid,
        uptime: ...,  // track internally
        lastHeartbeat: ...
      }
      result.success = true
      break

    case 'ps':
      result.data = ns.ps(cmd.host ?? 'home').map(p => ({
        filename: p.filename, threads: p.threads, pid: p.pid
      }))
      result.success = true
      break

    default:
      result.error = 'Unknown method: ' + cmd.method

  return result
```

---

## 2. strategy_agent.ts (~5.9 GB RAM)

### Purpose
Autonomous brain running on the best available non-home server (target: `foodnstuff`, 16 GB). Runs a 1-second main loop: snapshot game state, detect phase, select strategy, execute actions, log decisions.

### RAM Verification (Optimized)

The plan's 5.8 GB estimate missed several required functions. Verified with optimizations:

| Function | RAM Cost | Used For |
|---|---|---|
| `ns.getServer(host)` | 0.3 GB | All server properties in one call |
| `ns.getPlayer()` | 0.3 GB | Player state |
| `ns.scan(host)` | 0.2 GB | Network traversal |
| `ns.run(script, ...)` | 1.0 GB | Launch scripts (on relay server) |
| `ns.exec(script, host, ...)` | 1.3 GB | Launch scripts remotely |
| `ns.scp(script, dest, source?)` | 0.6 GB | Deploy worker scripts |
| `ns.kill(pid)` | 0.5 GB | Kill by PID |
| `ns.readPort(port)` | 0 GB | IPC receive |
| `ns.writePort(port, data)` | 0 GB | Send heartbeat to port 3 |
| `ns.peek(port)` | 0 GB | Port inspection |
| `ns.fileExists(filename)` | 0 GB | Check scripts, port openers |
| `ns.hasRootAccess(host)` | 0.05 GB | Root check |
| `ns.scriptRunning(script, host)` | 1.0 GB | Check if batch_hack is running |
| `ns.sleep(ms)` | 0 GB | Loop timing |
| `ns.print(...args)` | 0 GB | Logging |
| `ns.disableLog(fn)` | 0 GB | Suppress noise |
| `ns.brutessh/ftpcrack/relaysmtp/httpworm/sqlinject/nuke` | 0 GB | Port opening (0 GB each) |
| `ns.getHostname()` | 0.05 GB | Confirm current server |
| `ns.pid` (property) | 0 GB | Current PID |
| **Function total** | **5.3 GB** | |
| Base script overhead | ~1.6 GB | |
| **Total strategy_agent** | **~6.9 GB** | **Fits on foodnstuff (16 GB) with ~9 GB free** |

**Design tradeoffs:**
- `ns.getPurchasedServers()` (2.25 GB) excluded. Strategy agent uses `ns.scan()` + admin check instead. Purchased server management is the batch engine's job.
- `ns.scriptKill` (1.0 GB) excluded. Use `ns.kill(pid)` (0.5 GB) with PID tracking.
- `ns.scriptRunning` (1.0 GB) kept because we need to check if batch_hack is alive without tracking its PID across cycles. Could optimize by tracking PID and using ns.kill(pid, host) for existence check.
- `ns.write` (1.0 GB) excluded for decision logs. Decisions logged via `ns.print()` only. Claude reads script logs instead of status files for this agent.

### GameState Interface (ALL fields)

```typescript
interface GameState {
  // --- Player (from ns.getPlayer()) ---
  hackingLevel: number;
  money: number;
  incomeRate: number;            // $/sec from getPlayer().workMoneyGainRate

  // --- Home ---
  homeMaxRam: number;
  homeUsedRam: number;
  homeFreeRam: number;

  // --- Relay / Bootstrap tracking ---
  relayRunningOn: string | null; // hostname where strategy_agent is running (null = not yet)
  relayPid: number;              // PID of self for heartbeat (F10 addition)

  // --- Network (from ns.scan + ns.hasRootAccess) ---
  rootedServers: string[];
  rootedCount: number;
  unrootedServers: string[];
  unrootedNukable: number;       // reachable unrooted servers we CAN root right now

  // --- Per-server state (F10 addition) ---
  serverFreeRam: Map<string, number>;
  hasDeployScripts: Map<string, boolean>;

  // --- Port openers ---
  hasBruteSSH: boolean;
  hasFtpCrack: boolean;
  hasRelaySmtp: boolean;
  hasHttpWorm: boolean;
  hasSqlInject: boolean;
  hasAnyPortOpener: boolean;
  maxPorts: number;              // how many ports we can open right now

  // --- Hack targets ---
  hackableServers: string[];     // rooted + moneyMax > 0 + player level >= required
  bestTarget: string | null;     // highest-value hackable server
  preparedTargets: string[];     // at min security, >= 90% max money
  unpreparedTargets: number;     // hackable servers not yet prepared

  // --- Running state ---
  isBatchHackRunning: boolean;   // is batch_hack.js running?
  isRelayRunning: boolean;       // is strategy_agent running on non-home?

  // --- Economy ---
  totalRamPool: number;          // total free RAM across rooted servers (F10 addition)
  totalMaxRam: number;           // total max RAM across rooted servers (F10 addition)

  // --- Programs ---
  hasFormulas: boolean;
  hasTor: boolean;
}
```

**F10 audit additions (4+ fields):** `relayPid`, `serverFreeRam`, `hasDeployScripts`, `totalRamPool`, `totalMaxRam`. These enable per-server RAM-aware decisions and deploy-status tracking.

### Phase Enum

```typescript
enum Phase {
  BOOTSTRAP,    // Home <= 16 GB, need relay on bigger server
  SNOWBALL,     // Simple hack loop, accumulate money
  EXPANSION,    // Root everything with port openers
  PREPARATION,  // Prepare batch targets (auto_grow)
  BATCH,        // Full HWGW batch cycles
}
```

### Phase Stability Tracker (Audit F2)

```typescript
interface PhaseStability {
  candidate: Phase | null;       // candidate phase we might switch to
  consecutiveTicks: number;      // ticks the candidate has been stable
  readonly REQUIRED_TICKS: 5;   // stability requirement before switching
}
```

### Phase Detection Logic

```typescript
function detectPhase(s: GameState, prev: Phase, stab: PhaseStability): Phase {
  let target: Phase;

  // BOOTSTRAP: Home <= 16 GB AND no relay on non-home server
  if (s.homeMaxRam <= 16 && !s.relayRunningOn) {
    target = Phase.BOOTSTRAP;
  }
  // SNOWBALL: No port openers OR still have nukable servers OR < 5 rooted
  else if (!s.hasAnyPortOpener || s.unrootedNukable > 0 || s.rootedCount < 5) {
    target = Phase.SNOWBALL;
  }
  // EXPANSION: Have port openers, still have nukable servers
  else if (s.unrootedNukable > 0) {
    target = Phase.EXPANSION;
  }
  // PREPARATION: Servers rooted but targets not at max money/min security
  else if (s.unpreparedTargets > 0 && prev === Phase.PREPARATION) {
    target = Phase.PREPARATION;  // Stay in PREPARATION
  }
  else if (s.unpreparedTargets > 0) {
    target = prev;  // First tick — don't switch yet, start stability count
  }
  // BATCH: All targets prepared and stable
  else {
    target = Phase.BATCH;
  }

  // Hysteresis gate — require 5 consecutive ticks
  if (target !== prev) {
    if (stab.candidate === target) {
      stab.consecutiveTicks++;
      if (stab.consecutiveTicks >= stab.REQUIRED_TICKS) {
        stab.candidate = null;
        stab.consecutiveTicks = 0;
        return target;  // COMMIT transition
      }
      return prev;  // Not enough ticks
    } else {
      stab.candidate = target;
      stab.consecutiveTicks = 1;
      return prev;
    }
  } else {
    stab.candidate = null;
    stab.consecutiveTicks = 0;
  }

  return target;
}
```

### AgentAPI Interface

```typescript
interface AgentAPI {
  run(script: string, threads?: number, ...args: any[]): number;
  exec(script: string, host: string, threads?: number, ...args: any[]): number;
  kill(script: string, hostOrPid: string | number): boolean;
  scp(script: string, dest: string, source?: string): boolean;
  log(message: string): void;
  lastScanNukeTime: number;
}
```

### Action Type (Discriminated Union)

```typescript
type Action =
  | { type: 'RUN'; script: string; threads?: number; args?: (string | number)[] }
  | { type: 'EXEC'; script: string; host: string; threads?: number; args?: (string | number)[] }
  | { type: 'KILL'; script: string; host: string }
  | { type: 'SCP'; script: string; dest: string; source?: string }
  | { type: 'BUY_PROGRAM'; program: string; cost: number }
  | { type: 'DEPLOY'; host: string };
```

### Main Loop Pseudocode

```typescript
export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');
  ns.print('Strategy agent starting on ' + ns.getHostname());

  // ── Config ──
  const CFG = {
    STRATEGY_AGENT_RAM: 6.9,      // GB (verified with optimizations)
    WORKER_SCRIPT_RAM: 1.75,      // GB
    MAX_PREP_TARGETS: 4,
    MAX_AUTOGROW_PER_SERVER: 2,   // Audit H2
    PHASE_STABILITY_TICKS: 5,     // Audit F2
    HEARTBEAT_INTERVAL_MS: 5000,
    SCAN_NUKE_COOLDOWN: 60000,
    LOOP_INTERVAL_MS: 1000,
    HOME_RAM_RESERVE_FRACTION: 0.25,  // Reserve 25% of home RAM for system
  };

  // ── State ──
  let prevPhase = Phase.BOOTSTRAP;
  const stability: PhaseStability = { candidate: null, consecutiveTicks: 0, REQUIRED_TICKS: CFG.PHASE_STABILITY_TICKS };
  const api: AgentAPI = { lastScanNukeTime: 0, ... };
  let tickNumber = 0;

  // ── Main Loop ──
  while (true) {
    tickNumber++;
    const loopStart = Date.now();

    try {
      // Step 1: Heartbeat to port 3
      if (tickNumber % (CFG.HEARTBEAT_INTERVAL_MS / CFG.LOOP_INTERVAL_MS) === 0) {
        ns.writePort(3, 'alive');
      }

      // Step 2: Snapshot game state
      const state = await snapshotGameState(ns);

      // Step 3: Detect phase with hysteresis (Audit F2)
      const phase = detectPhase(state, prevPhase, stability);

      // Step 4: Generate strategy actions
      let actions: Action[] = [];
      switch (phase) {
        case Phase.BOOTSTRAP:   actions = strategyBootstrap(state, api); break;
        case Phase.SNOWBALL:    actions = strategySnowball(state, api); break;
        case Phase.EXPANSION:   actions = strategyExpansion(state, api); break;
        case Phase.PREPARATION: actions = strategyPreparation(state, api); break;
        case Phase.BATCH:       actions = strategyBatch(state, api); break;
      }

      // Step 5: Execute actions with PID checks (Audit F7)
      executeActions(ns, actions, api);

      // Step 6: Log decision
      if (phase !== prevPhase || actions.length > 0) {
        api.log(`[${Phase[phase]}] tick=${tickNumber} actions=${actions.length}`);
        ns.print(JSON.stringify({
          tick: tickNumber, ts: Date.now(), phase: Phase[phase],
          actions: actions.length, rooted: state.rootedCount,
          money: state.money, batchRunning: state.isBatchHackRunning,
        }));
      }

      prevPhase = phase;
    } catch (error) {
      ns.print('ERROR in main loop: ' + String(error));
      // Regression: fall back to SNOWBALL on crash (Audit F14)
      if (prevPhase !== Phase.SNOWBALL) {
        ns.print('REGRESSION: falling back to SNOWBALL');
        prevPhase = Phase.SNOWBALL;
        stability.candidate = null;
        stability.consecutiveTicks = 0;
      }
    }

    // Step 7: Sleep to maintain 1s cycle
    const elapsed = Date.now() - loopStart;
    await ns.sleep(Math.max(50, CFG.LOOP_INTERVAL_MS - elapsed));
  }
}
```

### snapshotGameState() Pseudocode

```
async function snapshotGameState(ns: NS): GameState {
  const state = {} as GameState;

  // ---- Player ----
  const player = ns.getPlayer();
  state.hackingLevel = player.skills.hacking;
  state.money = player.money;
  state.incomeRate = player.workMoneyGainRate ?? 0;

  // ---- Home ----
  const homeInfo = ns.getServer('home');
  state.homeMaxRam = homeInfo.maxRam ?? 0;
  state.homeUsedRam = homeInfo.ramUsed ?? 0;
  state.homeFreeRam = Math.max(0, state.homeMaxRam - state.homeUsedRam);

  // ---- Network scan (one pass, cached) ----
  const allServers = findAllServers(ns);  // from src/lib/network.ts (uses ns.scan)
  const rooted: string[] = [];
  const unrooted: string[] = [];
  const hackable: string[] = [];
  const prepared: string[] = [];
  const serverFreeRam = new Map<string, number>();
  const hasDeployScripts = new Map<string, boolean>();
  let totalRamPool = 0;
  let totalMaxRam = 0;

  for (const host of allServers) {
    if (host === 'home') continue;

    if (ns.hasRootAccess(host)) {
      rooted.push(host);
      const sv = ns.getServer(host);       // 0.3 GB — all props in one call
      const maxRam = sv.maxRam ?? 0;
      const usedRam = sv.ramUsed ?? 0;
      const freeRam = Math.max(0, maxRam - usedRam);

      serverFreeRam.set(host, freeRam);
      totalRamPool += freeRam;
      totalMaxRam += maxRam;

      // Deploy script check (fileExists is 0 GB)
      const h = ns.fileExists('/deploy/hack.js', host);
      const g = ns.fileExists('/deploy/grow.js', host);
      const w = ns.fileExists('/deploy/weaken.js', host);
      hasDeployScripts.set(host, h && g && w);

      // Hackable check
      if ((sv.moneyMax ?? 0) > 0 && (state.hackingLevel >= (sv.requiredHackingSkill ?? 0))) {
        hackable.push(host);

        // Prepared check (same as server_manager.ts isServerPrepared)
        const moneyPct = (sv.moneyAvailable ?? 0) / (sv.moneyMax ?? 1);
        const securityDiff = (sv.hackDifficulty ?? 100) - (sv.minDifficulty ?? 1);
        if (moneyPct >= 0.9 && securityDiff <= 3) {
          prepared.push(host);
        }
      }
    } else {
      unrooted.push(host);
    }
  }

  state.rootedServers = rooted;
  state.rootedCount = rooted.length;
  state.unrootedServers = unrooted;
  state.serverFreeRam = serverFreeRam;
  state.hasDeployScripts = hasDeployScripts;
  state.totalRamPool = totalRamPool;
  state.totalMaxRam = totalMaxRam;

  // ---- Port openers ----
  state.hasBruteSSH = ns.fileExists('BruteSSH.exe', 'home');
  state.hasFtpCrack = ns.fileExists('FTPCrack.exe', 'home');
  state.hasRelaySmtp = ns.fileExists('relaySMTP.exe', 'home');
  state.hasHttpWorm = ns.fileExists('HTTPWorm.exe', 'home');
  state.hasSqlInject = ns.fileExists('SQLInject.exe', 'home');
  state.hasAnyPortOpener = state.hasBruteSSH || state.hasFtpCrack || state.hasRelaySmtp
    || state.hasHttpWorm || state.hasSqlInject;
  state.maxPorts = countAvailablePortOpeners(state);  // count booleans

  // ---- Nukable count ----
  state.unrootedNukable = countNukable(ns, unrooted, state.maxPorts);

  // ---- Targets ----
  state.hackableServers = hackable;
  state.bestTarget = findBestTarget(ns, hackable);
  state.preparedTargets = prepared;
  state.unpreparedTargets = hackable.length - prepared.length;

  // ---- Running state ----
  state.isBatchHackRunning = ns.scriptRunning('/contracts/batch_hack.js', 'home');
  state.isRelayRunning = true;  // self — we ARE the relay

  // ---- Programs ----
  state.hasFormulas = ns.fileExists('Formulas.exe', 'home');
  state.hasTor = ns.hasTorRouter();

  // ---- Relay tracking ----
  state.relayRunningOn = ns.getHostname();  // self
  state.relayPid = ns.pid;

  return state;
}
```

**countNukable helper:**
```
function countNukable(ns, unrootedServers: string[], maxPorts: number): number {
  let count = 0;
  for (const host of unrootedServers) {
    if (ns.getServerNumPortsRequired(host) <= maxPorts) count++;
  }
  return count;
}
```

**findBestTarget helper:**
```
function findBestTarget(ns, servers: string[]): string | null {
  let best = null;
  let bestVal = -1;
  for (const host of servers) {
    const sv = ns.getServer(host);
    const val = sv.moneyMax ?? 0;
    if (val > bestVal) { bestVal = val; best = host; }
  }
  return best;
}
```

---

## 3. Strategy Functions

### Strategy: BOOTSTRAP

**Goal:** Get strategy agent running on largest non-home rooted server. If none exists, run scan_nuke to root 0-port servers.

```
function strategyBootstrap(state: GameState, api: AgentAPI): Action[] {
  if (state.relayRunningOn) {
    return [];  // Already bootstrapped. Phase detector will transition out.
  }

  const candidates = state.rootedServers
    .filter(h => h !== 'home')
    .filter(h => (state.serverFreeRam.get(h) ?? 0) > STRATEGY_AGENT_RAM)
    .sort((a, b) => (state.serverFreeRam.get(b) ?? 0) - (state.serverFreeRam.get(a) ?? 0));

  if (candidates.length > 0) {
    const target = candidates[0];
    return [
      { type: 'SCP' as const, script: '/monitor/strategy_agent.js', dest: target },
      { type: 'EXEC' as const, script: '/monitor/strategy_agent.js', host: target, threads: 1 },
    ];
  }

  // No relay target found — run scan_nuke to discover more servers
  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN) {
    api.lastScanNukeTime = Date.now();
    return [
      { type: 'EXEC' as const, script: '/tools/scan_nuke.js', host: 'home', threads: 1 },
    ];
  }

  return [];
}
```

### Strategy: SNOWBALL

**Goal:** Generate money for port openers. Runs periodic scan_nuke (Audit F1). Simple hack loop on best target. BUY_PROGRAM signals purchase intent (Audit F3).

```
function strategySnowball(state: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // 1) Periodic scan_nuke (F1: SNOWBALL must root servers)
  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  // 2) Port opener purchase intent (one per cycle)
  const OPENERS = [
    { file: 'BruteSSH.exe', cost: 500000, key: 'hasBruteSSH' as const },
    { file: 'FTPCrack.exe', cost: 1500000, key: 'hasFtpCrack' as const },
    { file: 'relaySMTP.exe', cost: 5000000, key: 'hasRelaySmtp' as const },
    { file: 'HTTPWorm.exe', cost: 30000000, key: 'hasHttpWorm' as const },
    { file: 'SQLInject.exe', cost: 250000000, key: 'hasSqlInject' as const },
  ];
  for (const opener of OPENERS) {
    if (!(state as any)[opener.key] && state.money > opener.cost * 1.5) {
      actions.push({ type: 'BUY_PROGRAM', program: opener.file, cost: opener.cost });
      api.log(`SNOWBALL: Purchase intent — ${opener.file} ($${opener.cost.toLocaleString()})`);
      break;  // One purchase per cycle
    }
  }

  // 3) Hack best target
  if (state.bestTarget) {
    if (!state.preparedTargets.includes(state.bestTarget)) {
      // Not prepared — run auto_grow
      actions.push({ type: 'EXEC', script: '/deploy/auto_grow.js', host: 'home', threads: 1, args: [state.bestTarget] });
    } else {
      // Prepared — run simple hack loop
      actions.push({ type: 'EXEC', script: '/deploy/simple_hack_loop.js', host: 'home', threads: 1, args: [state.bestTarget] });
    }
  } else if (state.hackableServers.length === 0) {
    api.log('SNOWBALL: No hackable servers. Waiting for scan_nuke or hacking level increase...');
  }

  // 4) Deploy worker scripts
  for (const host of state.rootedServers) {
    if (!(state.hasDeployScripts.get(host) ?? false)) {
      actions.push({ type: 'DEPLOY', host });
    }
  }

  return actions;
}
```

### Strategy: EXPANSION

**Goal:** Root every reachable server. Scan_nuke + deploy workers.

```
function strategyExpansion(state: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // Periodic scan_nuke
  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  // Deploy worker scripts to every rooted server that doesn't have them
  for (const host of state.rootedServers) {
    if (!(state.hasDeployScripts.get(host) ?? false)) {
      actions.push({ type: 'DEPLOY', host });
    }
  }

  return actions;
}
```

### Strategy: PREPARATION

**Goal:** Prepare batch targets using auto_grow. Capped deployment per server (Audit H2).

```
function strategyPreparation(state: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // Top N unprepared targets
  const targetsToPrep = state.hackableServers
    .filter(t => !state.preparedTargets.includes(t))
    .slice(0, MAX_PREP_TARGETS);

  const perServerCount = new Map<string, number>();

  for (const target of targetsToPrep) {
    for (const host of state.rootedServers) {
      const current = perServerCount.get(host) ?? 0;
      if (current >= MAX_AUTOGROW_PER_SERVER) continue;  // H2: cap per server

      const freeRam = state.serverFreeRam.get(host) ?? 0;
      const threads = Math.floor(freeRam / WORKER_SCRIPT_RAM / (MAX_AUTOGROW_PER_SERVER + 1));
      if (threads > 0) {
        actions.push({ type: 'EXEC', script: '/deploy/auto_grow.js', host, threads, args: [target] });
        perServerCount.set(host, current + 1);
      }
    }
  }

  if (targetsToPrep.length > 0) {
    api.log(`PREPARATION: ${targetsToPrep.length} targets across servers`);
  }

  return actions;
}
```

### Strategy: BATCH

**Goal:** Run full HWGW batch cycles via batch_hack.js. Check RAM before launch. Periodic scan_nuke maintenance.

```
function strategyBatch(state: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // Launch batch_hack if not running
  if (!state.isBatchHackRunning) {
    const homeFree = state.homeFreeRam;
    const minRam = WORKER_SCRIPT_RAM;  // 1.75 GB
    if (homeFree > minRam) {
      actions.push({
        type: 'RUN',
        script: '/contracts/batch_hack.js',
        threads: 1,
        args: ['--homeRam', String(Math.floor(state.homeMaxRam * HOME_RAM_RESERVE_FRACTION))],
      });
      api.log('BATCH: Starting HWGW batch hack system');
    } else {
      api.log(`BATCH: Insufficient RAM (need ${minRam}GB, have ${homeFree}GB free)`);
    }
  }

  // Periodic scan_nuke
  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  return actions;
}
```

### Regression Path (Audit F14)

Any phase can fall back to SNOWBALL. The phase detection top-down order ensures this:
- SNOWBALL condition (`!hasAnyPortOpener || unrootedNukable > 0 || rootedCount < 5`) is checked early
- If servers get un-rooted or port openers lost, the condition triggers
- Exception handler in main loop also regresses to SNOWBALL on uncaught errors

---

## 4. Action Execution (Audit F7: PID Verification)

```
function executeActions(ns: NS, actions: Action[], api: AgentAPI): void {
  for (const action of actions) {
    switch (action.type) {
      case 'RUN': {
        const pid = ns.run(action.script, action.threads ?? 1, ...(action.args ?? []));
        if (pid === 0) api.log(`WARN: RUN failed — ${action.script}`);
        else api.log(`RUN: ${action.script} pid=${pid}`);
        break;
      }
      case 'EXEC': {
        const pid = ns.exec(action.script, action.host, action.threads ?? 1, ...(action.args ?? []));
        if (pid === 0) api.log(`WARN: EXEC failed — ${action.script} on ${action.host}`);
        else api.log(`EXEC: ${action.script} on ${action.host} pid=${pid}`);
        break;
      }
      case 'KILL': {
        const ok = ns.scriptKill(action.script, action.host);
        if (!ok) api.log(`WARN: KILL failed — ${action.script} on ${action.host}`);
        break;
      }
      case 'SCP': {
        const ok = ns.scp(action.script, action.dest, action.source ?? 'home');
        if (!ok) api.log(`WARN: SCP failed — ${action.script} -> ${action.dest}`);
        break;
      }
      case 'BUY_PROGRAM': {
        // F3/F6: try Singluarity API, fall back to intent log
        try {
          const purchased = (ns as any).singularity?.purchaseProgram?.(action.program);
          if (purchased) {
            api.log(`BOUGHT: ${action.program}`);
          } else {
            api.log(`PURCHASE_INTENT: ${action.program} — needs terminal or SF-4`);
          }
        } catch {
          api.log(`PURCHASE_INTENT: ${action.program} — Singularity unavailable`);
        }
        break;
      }
      case 'DEPLOY': {
        // F5: Copy hack/grow/weaken.js to target
        const scripts = ['/deploy/hack.js', '/deploy/grow.js', '/deploy/weaken.js'];
        let copied = 0;
        for (const script of scripts) {
          if (ns.scp(script, action.host, 'home')) copied++;
        }
        if (copied === scripts.length) {
          api.log(`DEPLOY: All 3 scripts -> ${action.host}`);
        } else {
          api.log(`WARN: DEPLOY partial — ${copied}/3 -> ${action.host}`);
        }
        break;
      }
    }
  }
}
```

---

## 5. Constants to Define (Audit F9)

```typescript
// ---- RAM budgets (verified against bitburner_reference.md) ----
const BOOT_AGENT_RAM = 4.45;         // GB — boot_agent (exec kept)
const STRATEGY_AGENT_RAM = 6.9;      // GB — strategy_agent (optimized)
const WORKER_SCRIPT_RAM = 1.75;      // GB — hack.js / grow.js / weaken.js

// ---- Strategy tuning ----
const MAX_PREP_TARGETS = 4;          // max simultaneous auto_grow targets
const MAX_AUTOGROW_PER_SERVER = 2;   // cap per server per target (Audit H2)
const HOME_RAM_RESERVE_FRACTION = 0.25; // reserve 25% home RAM for system

// ---- Timing ----
const PHASE_STABILITY_TICKS = 5;       // 5s stability before phase transition (Audit F2)
const HEARTBEAT_INTERVAL_MS = 5000;    // heartbeat to port 3
const LOOP_INTERVAL_MS = 1000;         // main loop cycle
const SCAN_NUKE_COOLDOWN = 60000;      // 60s between scan_nuke runs

// ---- Port assignments ----
const PORT_CMD = 1;                    // port 1: commands (Claude -> boot_agent)
const PORT_RESULT = 2;                 // port 2: results (boot_agent -> Claude)
const PORT_HEARTBEAT = 3;              // port 3: strategy_agent heartbeat

// ---- Prepared thresholds (mirroring server_manager.ts) ----
const MONEY_THRESHOLD = 0.9;           // 90% of max money = prepared
const SECURITY_THRESHOLD = 3;          // within 3 of min security = prepared

// ---- Port opener costs (for purchase intent logging) ----
const PORT_OPENER_COSTS: Record<string, number> = {
  'BruteSSH.exe': 500000,
  'FTPCrack.exe': 1500000,
  'relaySMTP.exe': 5000000,
  'HTTPWorm.exe': 30000000,
  'SQLInject.exe': 250000000,
};
```

---

## 6. Decision Logging

Due to `ns.write()` costing 1.0 GB, decisions are logged via `ns.print()` only (0 GB). Claude reads these from the script log via the existing MCP `read_file` tool on the script log.

**Log format (one JSON line per tick with actions):**
```
{"tick":1,"ts":1712345678000,"phase":"BOOTSTRAP","actions":2,"rooted":3,"money":5000,"batchRunning":false}
{"tick":60,"ts":1712345738000,"phase":"SNOWBALL","actions":3,"rooted":5,"money":250000,"batchRunning":false}
```

**Phase transitions are logged explicitly:**
```
{"tick":120,"ts":1712345798000,"phase":"EXPANSION","transitionedFrom":"SNOWBALL","actions":2}
```

---

## 7. Bootstrap Deployment Sequence (Section 4.5)

From a fresh game start (home = 8 GB):

1. Claude pushes all scripts to home via MCP push_file:
   - `/monitor/boot_agent.js`
   - `/monitor/strategy_agent.js`
   - `/tools/scan_nuke.js`
   - `/deploy/hack.js`, `/deploy/grow.js`, `/deploy/weaken.js`
   - `/deploy/auto_grow.js`
   - `/deploy/simple_hack_loop.js`
2. User runs: `run /monitor/boot_agent.js` (one-time manual step)
3. Claude sends command to port 1: `{"id":"c1","method":"run","script":"/tools/scan_nuke.js"}`
   - scan_nuke roots all 0-port servers (n00dles, foodnstuff, sigma-cosmetics, joesguns, etc.)
4. Claude sends command: `{"id":"c2","method":"exec","script":"/monitor/strategy_agent.js","host":"foodnstuff","threads":1}`
5. Strategy agent starts on foodnstuff (16 GB), enters main loop
6. Phase = BOOTSTRAP -> finds relay exists (self on foodnstuff) -> no-ops -> transitions to SNOWBALL after 5 ticks
7. Full autonomy achieved from SNOWBALL onward

---

## 8. Worker Script Paths (Existing Files)

| Script | Path | RAM | Mode |
|---|---|---|---|
| hack.js | `/deploy/hack.js` | ~1.75 GB | Timed single hack, supports looping mode |
| grow.js | `/deploy/grow.js` | ~1.75 GB | Timed single grow, supports looping mode |
| weaken.js | `/deploy/weaken.js` | ~1.75 GB | Timed single weaken, supports looping mode |
| auto_grow.js | `/deploy/auto_grow.js` | ~2.3 GB | Weaken+grow loop until 90% money, +3 security |
| scan_nuke.js | `/tools/scan_nuke.js` | ~2.0 GB | BFS scan + inline nuke (checks port openers once) |
| batch_hack.js | `/contracts/batch_hack.js` | ~1.75 GB | HWGW batch orchestrator |
| simple_hack_loop.js | `/deploy/simple_hack_loop.js` | ~1.8 GB | **NEW**: sequential H->W->G->W loop |

---

## 9. Implementation Notes

### Avoided Functions (Too Expensive)

| Function | Cost | Reason |
|---|---|---|
| `ns.getPurchasedServers()` | 2.25 GB | Strategy agent doesn't manage purchased servers |
| `ns.scriptKill()` | 1.0 GB | Use `ns.kill(pid)` (0.5 GB) |
| `ns.write()` | 1.0 GB | Use ports; decisions logged via ns.print |
| `ns.read()` | 1.0 GB | Use ports |
| `ns.rm()` | 1.0 GB | Not needed |
| `ns.ps()` | 0.2 GB | Only if batch_hack PID tracking fails |
| `ns.getScriptRam()` | 0.1 GB | Pre-compute as constant |
| `ns.getHackingLevel()` | 0.05 GB | Available from ns.getPlayer() |

### Key Optimization: ns.getServer() vs Individual Getters

**Do NOT call 6 individual getters per server (0.55 GB total):**
- `getServerMaxRam` (0.1), `getServerUsedRam` (0.1)
- `getServerMaxMoney` (0.1), `getServerRequiredHackingLevel` (0.1)
- `getServerMinSecurityLevel` (0.1), `hasRootAccess` (0.05)

**Use ONE call (0.3 GB):** `ns.getServer(host)` returns all properties at once.
Savings: **0.25 GB per server per cycle**.

### Interaction with Existing Engine Files

The strategy agent does NOT import any existing engine classes. It is standalone:
- Calls `ns.*` functions directly
- Reads game state independently
- Launches worker scripts via `ns.exec()`
- Does NOT use Allocator, RamManager, ThreadManager, etc.

The BATCH phase launches `batch_hack.js` which uses the full engine stack.

### Audit F8: boot.js Exists, boot2.js is Ghost

- `boot.js` exists on game server as an ad-hoc script (not in `src/`)
- `boot2.js` does not exist — do NOT reference it
- The new `boot_agent.ts` is a proper source file

### Audit F11: batch_hack reads --homeRam from ns.args

`batch_hack.ts` already supports `--homeRam` CLI arg. The strategy agent passes it when launching:
```
args: ['--homeRam', String(Math.floor(state.homeMaxRam * 0.25))]
```

### Audit F12: Do NOT Remove lib/script.ts

`src/lib/script.ts` is imported by active engine files (`thread_manager.ts`, `exec_multi.ts`). Keep it.

### Edge Cases

1. **Stale heartbeat (30s):** boot_agent logs warning. Phase 2 enhancement will add re-deploy logic.
2. **Strategy agent crash:** Main loop try/catch falls back to SNOWBALL. Boot_agent detects missing heartbeat.
3. **No hackable servers:** SNOWBALL logs and waits. scan_nuke discovers more. Hacking level increases naturally.
4. **All servers prepared:** PREPARATION -> immediate BATCH transition.
5. **Batch crash -> regression:** Phase detector sees unprepared targets -> PREPARATION. Hysteresis prevents oscillation.
6. **Multiple instances:** Each writes PID to heartbeat. Boot_agent detects duplicates.
7. **Relay server dies:** Boot_agent detects missing heartbeat; manual re-deploy needed (future: auto).
8. **`ns.writePort` on full port:** Ports hold 50 entries by default. Heartbeat (every 5s) should never fill port 3. If needed, use `ns.clearPort()` periodically.
