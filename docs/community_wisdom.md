# Bitburner Community Wisdom: Design Patterns & Constraints

## 1. RAM Constraints & Workarounds

### The Core Constraint
Home starts at 8 GB RAM. Every `import` statement, every ns function reference, and every helper library adds to the script's base cost. A "simple" orchestrator script can easily cost 6-10 GB, leaving nothing for the hack/grow/weaken operations it needs to run.

### The "RAM Dodging" Pattern (Alainbryden, 604 stars)
This is the single most important RAM workaround in the community. The insight: running a temporary script costs only the RAM of `ns.run` (1.60 GB) plus whatever that script imports, and the temp script's RAM is freed when it exits. So instead of calling `ns.getPlayer()` directly (which costs ~0.5 GB just to have the reference in your script), you:

1. Write a one-line temp script to disk: `export async function main(ns) { ns.write("result.txt", JSON.stringify(ns.getPlayer()), "w"); }`
2. Run it with `ns.run(tempScript, 1)` -- costs only the 1.60 GB for ns.run
3. Read the result from the file with `ns.read("result.txt")` -- costs 0 GB
4. The temp script exits and its RAM is reclaimed

The trick: if your orchestrator script already uses `ns.run` for other purposes, importing the RAM-dodge helpers costs only 1.0 GB. Alainbryden's `helpers.js` makes this a first-class API: `getNsDataThroughFile(ns, "ns.getPlayer()")` wraps the entire pattern. His autopilot.js uses this for EVERY expensive call -- getting player info, server data, augmentations, everything.

**Cost analysis from Alainbryden's helpers.js:**
- `ns.getServer('home')` called directly: expensive (includes full Server object serialization)
- Same call via `getNsDataThroughFile`: costs only the 1.60 GB for `ns.run` + 0 GB for `ns.read`, and the temp script self-destructs

**Key implementation details reused everywhere in his codebase:**
- The temp file path is deterministic based on the command (e.g., `/Temp/ns-getPlayer.txt`)
- A command like `ns.singularity.getOwnedAugmentations()` that costs 20+ GB with SF4 gets "dodged" into a tiny 1.6 GB temp script
- Functions with multiple calls group them into one temp script: `Object.fromEntries(ns.args.map(server => [server, ns.getServerRequiredHackingLevel(server)]))`
- The `temporary: true` option (newer Bitburner API) means the script won't save to the save file

### The "Backup Server" Pattern (Alainbryden)
When home has only 8-16 GB RAM, daemon.js automatically offloads helper scripts to other rooted servers. The key constant in daemon.js:
```
const backupServerName = 'harakiri-sushi'; // 16 GB, 0 port requirement
```
Early-game scripts that would crowd home RAM get dispatched here instead. The condition: `if homeServer.totalRam() < 32` then `arbitraryExecution()` tries to run on any available rooted server instead of home.

### The "Reserved RAM" Pattern (Alainbryden, Jrpl)
Daemon.js uses a `--reserved-ram` flag (default 32 GB) to keep a buffer of home RAM free for:
- Ad-hoc terminal commands
- Temp scripts for RAM dodging
- Periodic utility scripts that need to fire briefly
- The player running manual commands

Jrpl's hack-manager.js does the same: it calculates `reserved_RAM` and subtracts it from home's available RAM before computing thread counts.

### The "Progressive Infrastructure" Pattern
No one keeps a big orchestrator running on 8 GB home. The progression is:
- **8 GB home**: Run only a minimal hack script directly (no imports). Use `ns.hack()` in a tight loop. Or use the "easy hack" pattern (Zharay).
- **16-32 GB home**: Introduce a lightweight coordinator that dispatches tiny hack/grow/weaken scripts to other servers.
- **32-128 GB home**: The full daemon/orchestrator becomes viable. Helper scripts (stockmaster, hacknet, sleeves) start launching.
- **128+ GB home**: Everything runs. Batch scheduling, looping mode, fancy optimizations.

Inigo's bootstrap.ts makes this explicit: it gates phase 2 behind `homeRam >= 1024 GB`. Below that, it runs a minimal loop.

### The "Thread Budget" Pattern (Zharay)
Zharay's hack-daemon calculates threads per target with:
```
hostRam - reservedRam / scriptRam
```
It then chooses the MIN between what's needed and what's available. If RAM is tight, it does less. There's no "all or nothing" -- it always does what it can.

### The "Hacknet Node as Poor Man's Server" Pattern (Alainbryden)
Hacknet servers have RAM that can be used for scripts with `--use-hacknet-servers`. They are typically dedicated to hash generation, but in a pinch their RAM can supplement the compute pool. This is gated behind a flag because it reduces hash production.

### Application to Our Codebase
Our `game_agent.ts` costs 9.15 GB and home is 8 GB. The community wisdom says:
- **Our game_agent.ts is too big for its own good.** We should RAM-dodge every expensive call through `getNsDataThroughFile`-style temp scripts.
- **Split the orchestrator.** The strategy logic (expensive, decision-heavy) should be a separate script that fires briefly, writes decisions to a file/port, and exits. The always-running daemon should be tiny.
- **Use a backup server** when home RAM is insufficient. Root n00dles or harakiri-sushi early, copy files there, run helpers there.
- **The heartbeat/port-writing loop** should be the only thing that runs continuously. Everything else is a temp script.

---

## 2. Bootstrap from Zero

### The Minimal First Script
**Alainbryden:** Runs `daemon.js` directly -- but daemon.js is already a sophisticated script that requires 32+ GB. For true-zero, the README suggests running just `hack.js` or `nc.js` manually until you can afford home RAM.

**Inigo:** `bootstrap.ts` is the first script. It starts with:
1. Launch logging
2. Select a goal (what game mechanic to focus on this BitNode)
3. Run sleeves (if available)
4. Run Stanek's Gift charging (if available)
5. Brief studying session to kickstart hack XP
6. Then it enters a tight phase-1 loop that runs each utility script sequentially, waiting for each to finish before starting the next

**Zharay:** `auto-spread-v2.js` is the entry point. It discovers all servers, roots them, copies `hack-daemon.js` to each, and runs it. The hack-daemon then self-organizes via ports.

**Jrpl:** Runs `hack-manager.js` which discovers servers, calculates what it can afford, and distributes threads across all rooted servers.

### The Casino Cash Injection Pattern
When starting fresh in a BN, early money is the bottleneck. Multiple authors use the casino as a kickstart:
- **Alainbryden:** `casino.js` earns $10B, gated behind `playerWealth < 1t` and income rate < 5B/min
- **Inigo:** `cheatCasino.js` runs if `homeRam < 512 GB || homeMoney < 300M`
- **Zharay:** Own stock-bot scripts for early income

The pattern: "If we are poor and early, cheat the casino. Once we are established, skip it."

### The Sequential Utility Loop (Inigo)
In bootstrap.ts phase 1, scripts run one-at-a-time, synchronously:
```
for script in [upgradeMemory, buyCracks, crackAll, installBackdoors, spreadAttack, hacknet/sellHashes, contracts]:
    ns.run(script)
    while anyScriptRunning(script): await sleep(200)
```
This avoids RAM contention: each utility runs, finishes, releases its RAM, then the next runs.

### Phase Transition Gating (Inigo)
The clearest example of explicit gating between bootstrap phases:
```
isPhaseTwo = allCracksBought && homeRam >= 1024 GB && homeMoney > 1M && !cheatingCasino
```
Once phase 2 is reached, bootstrap spawns `launchAll.js` and dies. No overlap, no confusion.

### Application to Our Codebase
Our bootstrap should be:
1. A minimal script (no imports) that does basic hacking on a nearby server until we have ~$1M
2. Then run utility scripts one-at-a-time: buy cracks, root servers, upgrade home RAM
3. Gate the full orchestrator behind `homeRam >= 32 GB` (or whatever our orchestrator needs)
4. Between phases, use a tiny loop that just does manual `ns.hack()` / `ns.weaken()` / `ns.grow()` directly

---

## 3. Script Architecture Patterns

### The Orchestrator Split (Alainbryden, Inigo)
The community has converged on splitting the orchestrator into layers:

```
autopilot.js (high-level strategy: when to install augs, when to destroy BN)
    |
    v
daemon.js (batch scheduler: where to hack, how many threads, what targets)
    |
    v
Remote/*.js (hack/grow/weaken workers: run on target servers, accept timing args)
```

Each layer is dumber than the one above it. autopilot.js doesn't know about batch timing. daemon.js doesn't know about augmentation gating. Remote scripts don't know about strategy.

### The Helper Script Pattern (Alainbryden)
Daemon.js categorizes all external scripts into three distinct types:

1. **Asynchronous Helpers** -- Long-running standalone scripts (stockmaster, gangs, sleeves, hacknet). Run once, expected to run forever. Checked periodically and restarted if dead.
2. **Periodic Scripts** -- Fire on an interval (25-33 seconds). Each has an `interval`, `shouldRun()` predicate, and optional dynamic `args()` function. They are staggered so they don't all burst at once.
3. **Hack Tools** -- Remote batch scripts (hack, grow, weaken, share). These are the workers. They accept precise timing parameters and execute a single operation.

Each helper has a `shouldRun()` condition that checks whether the game state and home RAM warrant launching it. This prevents RAM waste.

### The Port-Based IPC System (Zharay, Inigo)
Zharay's entire botnet runs on port-based communication:

- **Port 1**: Target list (coordinator sends to workers)
- **Port 3**: Target status (coordinator maintains, workers read)
- **Port 6**: Lock system (prevents race conditions on the same target)
- **Port 11**: Host registration (workers announce "I exist")
- **Port 20**: Kill switch

The lock system is particularly clever: before a worker performs an action on a target, it requests a lock via port 15. The coordinator grants it by writing the worker's hostname to the lock array on port 6, which is a shared JSON blob. This prevents two workers from both weakening the same target.

Inigo uses ports similarly but with a simpler API: `checkPort(ns, portNumber, transformFn)` for peeking, `setPortValue` for setting, and named port constants (HACKING_PORT, GANG_CONTROL_PORT, etc.).

### The File-Based IPC Pattern (Alainbryden)
Complementary to ports, Alainbryden uses files for shared state:
- `reserve.txt` -- A money amount that should not be spent (written by autopilot, read by daemon and host-manager)
- `/Temp/analyze-hack.txt` -- Server income analysis (written by daemon, read by autopilot)
- `/Temp/affordable-augs.txt` -- Faction manager output
- Config files: `scriptname.config.txt` -- Persisted runtime arguments

Files have the advantage of being human-readable and surviving script restarts. The convention is to write to `/Temp/` for ephemeral data.

### The "One Script, One Job" Principle
All four repos follow this implicitly:
- **Remote scripts** (Alainbryden): `hack-target.js` only hacks, `weak-target.js` only weakens, `grow-target.js` only grows
- **Attack scripts** (Inigo): Separate files for hack, grow, weaken
- **Zharay**: Same -- separate hack.js, weaken.js, grow.js

The rationale: each job script stays small (1.60-1.75 GB), so it can run on any server with available RAM. A combined hack-grow-weaken script would be 3-4 GB and harder to schedule.

### The "Precise Timing via Arguments" Pattern (Alainbryden)
Remote scripts receive absolute start times, not delays:
```
hack-target.js [target, start_time, duration, description, manipulateStock, silentMisfires, loopingMode]
```
The script calculates `sleepDuration = start_time - Date.now()` and uses `additionalMsec` in the ns.hack/grow/weaken call. This enables precise batch scheduling where multiple scripts fire at exact times across different servers.

### Application to Our Codebase
Our monolithic `game_agent.ts` should be split:
1. **Strategy/decision script** (runs briefly, writes decisions to port/file, exits) -- analogous to autopilot.js
2. **Daemon/dispatcher** (always runs, lightweight, reads decisions, dispatches workers) -- analogous to daemon.js
3. **Worker scripts** (tiny, one job each, run on any available server) -- hack.js, grow.js, weaken.js

The communication between them should use ports (for real-time IPC) or files (for durable/shared state).

---

## 4. Progressive Enhancement

### Home RAM as the Progression Metric
Every repo uses home RAM explicitly to gate what features are available. Alainbryden's daemon.js has `reqRam(N)` checks everywhere:
- **8-16 GB**: Run targeted hack/grow/weaken from home and a backup server. No helpers. No extras.
- **32 GB**: Stockmaster becomes viable. Share scripts start.
- **64 GB**: Gangs, sleeves, bladeburner, hacknet managers, stock market
- **128+ GB**: Full faction management, Stanek's Gift, periodic script intervals

### Hack Level as a Secondary Gate
Alainbryden's `--high-hack-threshold` (default 8000) toggles a "looping mode" where batch scheduling switches from spawning many small scripts to fewer long-lived looping scripts. This reduces RAM overhead from script spawning when hack levels are high enough that operations complete very quickly.

### The Two-Speed Bootstrap (Inigo)
Inigo has the clearest two-phase progression:
- **Phase 1** (bootstrap.ts): Sequential utility execution, single-target hacks, no fancy scheduling
- **Phase 2** (launchAll.ts): Full parallel batch attacks, all game mechanics, stocks, gangs

Phase 2 is gated behind: 1024 GB home RAM, all 5 crack programs bought, money > $1M, and casino finished.

### The Daemon Arg Tuning Pattern (Alainbryden)
As the game progresses, daemon.js is relaunched with different arguments:
- Early: `--no-share --initial-max-targets 1` (conserve RAM, single target)
- Mid: default args (multiple targets, share enabled, normal timing)
- Late: `--loop-mode --cycle-timing-delay 40 --queue-delay 50` (tight batches, high throughput)

Autopilot.js handles the relaunch logic, deciding which args daemon.js needs at each phase.

### Budget Scaling (Alainbryden, Jrpl)
Spending on infrastructure scales with income, not hoarded cash:
- **Alainbryden:** Max 25% of hack income spent on purchased servers. Budget includes `reserve.txt` to avoid spending money earmarked for augs.
- **Jrpl:** Uses a fraction `c` that starts at 2 (half the server's money per cycle) and is reduced if RAM can't support the threads.
- **Alainbryden's ram-manager.js:** Spend 50% of unreserved cash on home RAM upgrades, which are permanent for the BN.

### Application to Our Codebase
We need explicit phase gates in our strategy agent:
- **Phase 0 (8 GB home):** No strategy agent. Run a tiny manual hack script directly. No imports.
- **Phase 1 (16-32 GB):** Lightweight daemon. Single target. Basic hack/grow/weaken. Root all servers. No extras.
- **Phase 2 (32-128 GB):** Full daemon with batch scheduling. Stock market. Hacknet. Helper scripts.
- **Phase 3 (128+ GB):** All features. Gang management. Sleeves. Faction reputation optimization.

Each phase transition should be a distinct event, not a smooth gradient. The orchestrator checks: "Can I now afford to run X?" and if yes, spawns it.

---

## 5. Error Recovery & Resilience

### The "Auto Retry" Pattern (Alainbryden)
The most robust pattern: every operation that can fail (RAM exhaustion, server not found, etc.) is wrapped in `autoRetry()` with exponential backoff:
```javascript
autoRetry(ns,
    () => ns.exec(script, host, {temporary: true}, ...args),
    pid => pid !== 0,  // success condition
    () => "Error message",  // error context
    maxRetries, retryDelayMs, backoffRate
)
```
The backoff rate of 3x means: 50ms, 150ms, 450ms, 1.35s, 4.05s. This handles transient RAM congestion gracefully.

### The "Keep Alive" Loop (All repos)
Every orchestrator wraps its main loop in try/catch:
```javascript
while (keepRunning) {
    try {
        keepRunning = await mainLoop(ns);
    } catch (err) {
        log(ns, "Caught error: " + err.message);
        keepRunning = true; // Don't die, try again next loop
    }
    await ns.sleep(interval);
}
```
The orchestrator NEVER crashes. It logs errors and continues. If it truly can't function (e.g., home RAM dropped), it shuts itself down gracefully with a message to the user.

### The "Singleton" Pattern (Alainbryden)
Multiple repos check for duplicate instances at startup:
```javascript
const runningScripts = await getNsDataThroughFile(ns, 'ns.ps("home")');
const otherInstances = runningScripts.filter(s => s.filename === scriptName && s.pid !== ns.pid);
if (otherInstances.length > 0) return; // Quietly exit
```
This prevents the "100 copies of the daemon" problem that happens when scripts auto-restart.

### The "Process Watcher" Pattern (Alainbryden)
Daemon.js uses `waitForProcessToComplete_Custom` with a custom `fnIsAlive` to avoid the cost of importing `ns.isRunning`:
```javascript
const fnIsAlive = pid => ns.ps("home").some(p => p.pid === pid);
// or even cheaper:
const fnIsAlive = () => ns.read(fName) === initialContents; // File-based detection
```

### Graceful Degradation (Alainbryden)
Every `getNsDataThroughFile` call has a fallback. For example, `tryGetBitNodeMultipliers` tries the API (requires SF5, expensive), then falls back to hard-coded values from the Bitburner source. Similarly, attempts to get server names fall back to `"home"` if the API call fails.

### The "Reserve.txt" Money Protection (Alainbryden)
Money reserved for specific purposes is written to `reserve.txt`. All scripts that spend money check this file first:
- Autopilot writes total aug cost to reserve.txt before installing
- Stockmaster reads it to know how much cash to keep
- Host-manager and ram-manager both check it
- This prevents the "stockmaster bought more stocks and now I can't afford my augmentations" problem

### Application to Our Codebase
Every script should:
1. Never crash -- wrap main loop in try/catch
2. Use auto-retry with backoff for operations that compete for RAM
3. Check for duplicate instances at startup
4. Fall back gracefully when APIs aren't available (low RAM, missing SF)
5. Use a shared `reserve.txt` or port value for money protection

---

## 6. The "Game Agent" / Daemon Pattern

### What the Orchestrator Actually Does
The daemon/orchestrator in each repo has a surprisingly small set of continuous responsibilities:

1. **Check if helpers are running** (and restart if not)
2. **Check for phase transitions** (should we upgrade behavior?)
3. **Periodically dispatch utility scripts** (contracts, hacknet, factions)
4. **Sleep** -- most of the time it is sleeping

The actual hack/grow/weaken scheduling is done by sub-scripts that the daemon launches. The daemon itself does not hack anything.

### Alainbryden's Daemon Structure
Despite being the "big" daemon, its hot loop is lean:
```javascript
async function doTargetingLoop(ns) {
    while (!runOnce || loopCount++ < 1) {
        await refreshServerCache(ns);        // Update server states
        await refreshDynamicSettings(ns);     // Check for phase transitions
        await scheduleBatches(ns);            // Calculate and dispatch HGW batches
        await runPeriodicScripts(ns);         // Fire any due periodic tasks
        await ns.sleep(loopInterval);         // Sleep (default 1 second)
    }
}
```

### The Minimal Daemon (Zharay)
Zharay's coordinator is the most interesting minimal daemon:
1. It reads target lists from port 8 (populated by auto-spread)
2. It maintains target status in port 3 (JSON blob: what threads are running on what)
3. It processes task completions from workers via port 13
4. It manages locks via port 15
5. It sleeps 500ms between cycles

The entire state is in ports, not in memory. If the coordinator crashes, a new one reads the ports and picks up where the old one left off.

### Inigo's Sequential Phase-1 Daemon
The simplest workable pattern: a `while(true)` loop that runs utility scripts one-at-a time:
```javascript
while(true) {
    for (const script of scripts) {
        ns.run(script);
        while (ns.isRunning(script)) await ns.sleep(50);
    }
    await ns.sleep(15000);
}
```
This is the minimal viable orchestrator. It is dumb, it is slow, but it works with 8 GB home and zero imports.

### The "Spawn-and-Forget" Pattern (Jrpl)
Jrpl's hack-manager does not use a daemon at all. It is a single script that:
1. Scans all servers
2. Calculates optimal thread distribution
3. Uses `ns.exec()` to run targeted scripts on each server
4. Exits

The assumption: run it periodically (via a simple `run hack-manager.js` loop) or just manually re-run it.

### Key Design Insight: What Stays in RAM
The community has converged on this principle:

**Long-running scripts should import almost nothing and use almost no ns functions directly.**

Everything expensive should be done via:
- Temp scripts (RAM dodging)
- File reads (free)
- Port reads (free)

The daemon's base cost should be only: `ns.run` (1.60 GB), `ns.read` (0 GB), `ns.write` (0 GB), `ns.exec` (free if you use run for exec). Everything else is dodged.

### Application to Our Codebase
Our game agent should be restructured into at minimum these scripts:

1. **boot.js (the tiny daemon)** -- Runs forever, costs < 3 GB
   - Sends heartbeat to a port every second
   - Reads strategy decisions from a file/port
   - Dispatches hack/grow/weaken workers via `ns.exec`
   - Checks if helpers need restarting
   - Imports NOTHING but `ns`

2. **strategy.js (the decision-maker)** -- Runs briefly, costs 9+ GB
   - RAM dodges all expensive calls through temp scripts
   - Reads game state, decides what to do
   - Writes decisions (target, mode, phase) to a file or port
   - Exits after each decision cycle
   - The boot daemon re-launches this periodically (e.g., every 30s)

3. **worker scripts** -- Each < 2 GB, single purpose
   - `hack.js` -- Only hacks a target at a given time
   - `grow.js` -- Only grows a target
   - `weaken.js` -- Only weakens a target

The strategy script (game_agent) should NOT be the always-running daemon. It should be a decision-maker that fires, decides, writes results, and exits. The daemon should be a separate, tiny script that reads decisions and executes them.

---

## Summary: Key Principles for Our Codebase

| Principle | Source | Why |
|-----------|--------|-----|
| RAM-dodge everything expensive | Alainbryden | 9 GB scripts can't run on 8 GB home |
| Split orchestrator from daemon | All | Keep the hot loop tiny (< 3 GB) |
| One script, one job | All | Each script stays small, can run anywhere |
| Use ports for IPC | Zharay, Inigo | Survives script restarts, no RAM cost |
| Progressive gating by home RAM | All | Don't launch 32 GB features on 8 GB home |
| Auto-retry with backoff | Alainbryden | Transient RAM contention is normal |
| Never crash | All | Log errors, keep looping |
| Sequential utility execution | Inigo | Avoids RAM contention from concurrent scripts |
| Reserve.txt for money protection | Alainbryden | Prevents scripts spending each other's money |
| Temp scripts for expensive operations | Alainbryden | Running a 1.6 GB temp script is cheaper than importing a function |
