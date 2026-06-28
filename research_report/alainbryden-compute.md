# alainbryden Compute Thread Research Report

## Summary (Top 10 Findings)

1. **Architecture is two-tier**: `autopilot.js` is the meta-brain (BN sequencing, aug installs, Daedalus logic); `daemon.js` is the hacking engine. autopilot spawns daemon with calculated args; daemon is a 1800+ line monolith that also launches most helper scripts directly.
2. **RAM-dodging is the core architectural technique**: `getNsDataThroughFile` in helpers.js spawns a disposable temp script, evaluates an arbitrary NS expression, writes JSON to `/Temp/*.txt`, reads it back. Almost every expensive NS call uses this pattern.
3. **True HWGW batching**: `getScheduleTiming` computes 4 precise fire times (H, W1, G, W2) staggered by `cycleTimingDelay/4` per step, all resolved in order. Multiple batches overlap in parallel up to `maxBatches=40`.
4. **Phase detection is implicit, not a state machine**: a set of boolean flags and numeric thresholds, not an enum. Key signals: homeRam < 32, homeRam < 64, hack >= 8000, hack >= 75% of WD, ScriptHackMoney==0, time-since-aug.
5. **Target selection**: sorted by `$/RAM/second` via `analyze-hack.js` (written to `/Temp/analyze-hack.txt`). XP mode uses `exp/second`. Both are pre-computed and cached, not recalculated per-loop.
6. **Adaptive max-targets**: starts at `2 + totalRam/(500TB)`, ramps up when low utilization (<80%) for multiple loop intervals, shrinks when high (>95%) for 60 intervals. Recovery thread padding also scales up when idle.
7. **Home RAM handling**: `reserve.txt` shared file sets global money+RAM reserve. `homeReservedRam` (default 32GB) deducted from home's usable RAM for scheduling. Doubles at 512GB threshold. Home gets grow/weaken preference (multi-core bonus).
8. **Hacknet ROI**: `hacknet-upgrade-manager.js` ranks upgrades by `production-added / cost` (hashes/sec per dollar), buys best if payoff < time threshold (1h kick-start, 4h ongoing, 8h at 1% of money). `spend-hacknet-hashes.js` spends on best server boost after 15 minutes.
9. **`arbitraryExecution` is the RAM packer**: tries to place all threads on the best single server; splits across servers only if `threadSpreadingAllowed`. Prefers home for grow/weak (cores), pushes hacknet servers to back of list.
10. **Binary-search steal% optimizer**: `optimizePerformanceMetrics` runs up to 1000 iterations adjusting hack thread count to maximize simultaneous batches while fitting within RAM. Uses a greedy bin-packing simulation (`getPerformanceSnapshot`) to estimate without actually scheduling.

---

## Per-File Notes

### `autopilot.js`
- **Role**: Top-level orchestrator. Main loop every 2s (`--interval`). Does NOT do any hacking itself.
- **Key responsibilities**: BN order planning, aug counting, Daedalus invite rush, casino, Stanek init, script health checks, work-for-factions coordination, augmentation install timing.
- **Daemon args calculation**: autopilot computes daemon args based on hack level, homeRam, XP modes, BN multipliers, then kills + relaunches daemon if args don't match. Key modes injected: `--xp-only`, `--silent-misfires`, `--recovery-thread-padding`, `--cycle-timing-delay`, `--queue-delay`.
- **Phase signals autopilot reads**:
  - `homeRam < 32`: `--no-share --initial-max-targets 1`
  - `player.skills.hacking >= 8000` (`--high-hack-threshold`): sets tighter timing (40ms cycle delay, 50ms queue delay)
  - `prioritizeHackForWd` or `prioritizeHackForDaedalus`: injects `--xp-only` into daemon
  - `ScriptHackMoney * ScriptHackMoneyGain == 0`: `--xp-only` for all non-BN8 nodes
  - `currentNode == 8`: `--stock-manipulation-focus`
- **XP mode scheduling**: optional timed rotation every `xp-mode-interval-minutes` (default 55) for `xp-mode-duration-minutes` (default 5). Daemon is relaunched with `--xp-only` during that window.
- **Config persistence**: saves changed args to `autopilot.js.config.txt` so they survive resets via `persistConfigChanges`.
- **Hack: autopilot also launches stockmaster.js, sleeve.js, gangs.js** independently of daemon, to avoid daemon's startup lag.

### `daemon.js`
- **Role**: Hacking engine + helper script launcher. ~1800 lines. Author warns it's "a mess" at the top.
- **Startup sequence**:
  1. Kill competing daemon instances
  2. `establishMultipliers` - read BN multipliers and player stats
  3. `buildServerList` - discover/scan all servers
  4. Root everything rootable immediately
  5. `kickstartHackXp` if < 500 hack and < 10 min since aug (study + XP cycles)
  6. Default `maxTargets = 2 + round(totalRam/500TB)`
  7. Launch `doTargetingLoop`
- **Two helper categories**:
  - `asynchronousHelpers`: launched once, expected to run forever (stats, stockmaster, hacknet-upgrade-manager, spend-hacknet-hashes, sleeve, gangs, work-for-factions, bladeburner). Launched with `shouldRun()` predicate and RAM requirements.
  - `periodicScripts`: run every N ms (25-33s staggered to avoid RAM bursts). Includes tor-manager, program-manager, contractor, hacknet-upgrade-manager (3 variants with different budgets), ram-manager, faction-manager, host-manager, backdoor-all-servers.
- **The targeting loop** (`doTargetingLoop`): runs every 1s. Builds targeting order, iterates servers, classifies each into: noMoney/notRooted/cantHack/prepping/targeting/skipped/failed. Calls `prepServer` or `performScheduling` as appropriate.
- **Utilization caps**: `maxUtilization = 0.95` (hard cap, stop scheduling), `lowUtilizationThreshold = 0.80` (below = ramp up). `maxUtilizationPreppingAboveHackLevel = 0.75` (for pre-hacking prep).
- **XP farming fills gaps**: if utilization is low for >10 iterations, `farmHackXp` uses spare RAM for hack XP. `farmHackXp` runs in two modes: simple (single server, best exp/sec target) and multi-target XP mode.
- **Share fills remaining gaps**: after hack scheduling and XP cycles, any remaining RAM below `--share-max-utilization` (80%) spawns `share.js` threads to boost faction rep.

### `helpers.js`
- **`getNsDataThroughFile(ns, command, fName, args)`**: Core RAM-dodge. Writes `let r; try { r=JSON.stringify(${command}); } catch... ns.write(fName, r)` to a temp `.js` file, runs it via `ns.run`, reads the result back. ~1.6GB base + whatever fnRun costs. Used everywhere.
- **`getNsDataThroughFile_Custom`**: Same but takes a `fnRun` arg, so callers already using `ns.exec` pay no extra RAM.
- **`autoRetry`**: retry wrapper used around exec calls and file reads.
- **`getActiveSourceFiles`**: reads source files without using the SF4 API (works even without SF4).
- **`tryGetBitNodeMultipliers`**: gets BN mults, falls back gracefully if SF5 not owned.

### `host-manager.js`
- **Budget model**: called from daemon periodic scripts. Budget = `max(0, 0.25 * sinceInstall.hacking - totalServerSpend, 0.001 * sinceInstall.total - totalServerSpend)`. Server spend tracked via `ns.getMoneySources()`.
- **Size selection**: iterates exponent levels 1..20, picks highest it can afford from the spendable budget. Enforces minimum exponent (default 2^5=32GB).
- **Three stop conditions before buying**: (1) can't afford min size; (2) affordable size < 25% of home RAM; (3) affordable size adds < 2% to network RAM. Bypassed if buying the max purchasable size.
- **Upgrade logic**: when buying and there are old purchased servers, will delete smallest old server to make room if at server cap and new server is bigger.
- **`reserve-by-time` mode** (enabled by daemon): exponential decay. `pctReserved = 1 - (1 - initialPct) * (1 - decayFactor)^t`. With default 0.1 decay: starts at 5% reserved, grows to ~75% at 6h. Early-game server buying is aggressive, tapers off.
- **Utilization trigger disabled**: daemon passes `--utilization-trigger 0` so host-manager doesn't wait for utilization to be high before buying.

### `Remote/hack-target.js`, `grow-target.js`, `weak-target.js`
- Minimal single-purpose scripts (~40 lines each).
- **Args protocol**: `[target, start_time, duration, description, manipulateStock, silentMisfires, loopingMode]`
- **Sleep via `additionalMsec`**: sleep delay is bundled into the `hgwOptions.additionalMsec` field rather than a separate `ns.sleep`. The game adds this to the built-in operation time. No wasted syscall overhead.
- **`description`** arg (e.g. `"Batch 3-hack"`) is used by daemon to detect whether a script is "targeting" or "prepping" via `process.args[3].startsWith('Batch')` vs `== "prep"`.
- **Looping mode**: if loopingMode==true, scripts loop forever, adding `duration * 3.0` to `additionalMsec` after first iteration. Intended to fire once per weaken-cycle without respawning.
- **Misfire detection**: hack checks `stolen == 0`; grow/weak fire immediately if `start_time < Date.now()` (logs misfire toast if not silenced).

### `hacknet-upgrade-manager.js`
- **ROI metric**: `addedProduction(nodeStats) / cost` = (new hashes/sec) / (dollar cost). Bigger is better.
- **Upgrade candidates**: level (+production * level ratio), ram (+7% production), cores (+production by core ratio), cache (treated as ~1% per cache level if below min cache, purely to unlock hash capacity).
- **New node vs upgrade**: uses `worstNodeProduction / newNodeCost` as proxy ROI. Optimistic estimate (actual cost to match existing node's production is higher, but scaling makes this roughly OK).
- **Payoff time**: `1 / (hashDollarValue * ROI)`. `hashDollarValue = 250000` (each hash/sec is worth $250k/s → $1M per 4 hashes). Hacknet nodes use 1 (raw hashes).
- **Three invocations from daemon periodic scripts**: one with 1h limit (kickstart, unlimited spend), one with 4h limit (10% of money), one with 8h limit (1% of money). Staggered at 28000/28500/29000ms intervals.

### `spend-hacknet-hashes.js`
- Runs continuously with 50ms interval.
- **Two modes**: `--liquidate` (spend as fast as hashes arrive), default (spend only when within one tick of capacity to avoid waste).
- **Multi-instance support**: multiple concurrent instances with different `--spend-on` configs are fine.
- **autopilot chooses target**: after 15 min, reads `/Temp/analyze-hack.txt`, picks server with best `gainRate` where hack level is sufficient, starts `spend-hacknet-hashes.js --spend-on Increase_Maximum_Money --spend-on-server <best>`. Also adds `Reduce_Minimum_Security` if server's min security > 2.
- **Capacity upgrades**: if can't afford desired purchase, will try to buy hacknet capacity upgrades (unless `--no-capacity-upgrades`).

### `Tasks/crack-host.js`
- Used by daemon for nuking: `await doRoot(ns, server)` → exec `crack-host.js`, wait for completion.
- One-shot: opens ports with whatever cracks are available and runs NUKE.exe.

---

## Investigation Points

### 1. Philosophy & Architecture

**autopilot.js → daemon.js relationship**:
- autopilot runs at 2s intervals, monitors everything, decides high-level strategy
- daemon gets relaunched by autopilot when its args need to change (e.g., entering XP mode)
- daemon itself launches ~8 async helpers and ~8 periodic scripts
- There's intentional redundancy: autopilot ALSO launches stockmaster, sleeve, gangs independently (at the top of `checkOnRunningScripts`), with its own conditions, to avoid relying on daemon's slower startup

**Coordination mechanisms**:
- `/Temp/*.txt` files: ubiquitous inter-process communication
- `reserve.txt`: global money reserve shared by all scripts
- `reserve.txt` content = amount to keep free; scripts read it with `Number(ns.read("reserve.txt") || 0)`
- Script arg position 3 (`description`) encodes state: `"prep"` vs `"Batch N-hack"` etc.
- `/Temp/analyze-hack.txt`: server income ranking written by `analyze-hack.js`, read by daemon, autopilot, spend-hacknet-hashes

**Control flow**:
```
autopilot.main → startUp → mainLoop (every 2s)
  mainLoop → checkOnRunningScripts → [launch daemon with computed args]
  daemon.startup → doTargetingLoop (every 1s)
    → runStartupScripts (async helpers, once each)
    → runPeriodicScripts (periodic tasks on staggered timers)
    → getAllServersByTargetOrder → [classify each server]
    → prepServer or performScheduling
    → farmHackXp (fill spare RAM)
    → share.js threads (fill remaining RAM)
```

### 2. Income Engine

**HWGW Batching**:
- `getScheduleTiming(fromDate, currentTarget)`: calculates absolute fire times working backwards from the final weaken.
- Order of resolution: H → W1 → G → W2, each spaced by `cycleTimingDelay/4` (default 1000ms → 250ms gaps).
- Multiple batches overlap: batch N+1 starts `cycleTimingDelay` (4000ms) after batch N.
- `maxBatches=40` hard cap on queued batches.

**Steal % optimization** (`optimizePerformanceMetrics`):
- Binary-search style with halving increment.
- Uses `getPerformanceSnapshot` to simulate how many complete batches fit in current RAM (greedy bin-packing on sorted free-RAM list).
- Targets: `optimalPacedCycles` (how many fit in weaken-time / cycleTimingDelay) vs `maxCompleteCycles` (how many fit in RAM). Tries to make them equal.
- Stops when increment reaches 1 hack thread.
- Up to 1000 iterations before giving up.

**Target ordering** (`getAllServersByTargetOrder`):
- Primary sort: `getMoneyPerRamSecond()` from `dictServerProfitInfo` (analyze-hack.js output)
- Hackable (canHack()) servers go before unhackable ones
- First un-prepped hackable server gets moved to front of list to unblock future targeting

**Strategy scaling**:
- Very early (8GB home): maxTargets=1, maxPreppingAtMaxTargets=1, no share
- Early (<32GB): no share, targets=1
- Normal: automatic target scaling, share when utilization < 80%
- High hack (>8000): tighter timing (40ms cycle delay, 50ms queue delay)
- XP mode: switch to farmHackXp for all RAM, sort by exp/sec instead of $/RAM/sec
- Late game (loopingMode, disabled): scripts loop themselves for efficiency

**Thread spreading**: weaken (`weak`) allows thread spreading across servers. hack and grow do NOT by default (splitting reduces effectiveness of batching). Exception: prep grow is allowed to split (`allowThreadSplitting=true`) to speed prep.

### 3. Infrastructure

**Nuking/spreading**:
- `buildServerList` uses `scan.js`-style recursive BFS to discover all servers.
- `doRoot` calls `/Tasks/crack-host.js` as a subprocess, waits for completion.
- Done opportunistically in the targeting loop: any unrooted server that `canCrack()` gets rooted during the loop pass.
- No explicit "spread scripts to all servers" step - scripts are copied on-demand in `arbitraryExecution` when needed on a remote host.

**Purchased servers** (`host-manager.js`):
- Named `"daemon"` prefix (checked via string startsWith in shouldHack()).
- Budget: 25% of cumulative hack income minus what's already been spent on servers. Falls back to 0.1% of total income for XP-focus BNs.
- `reserve-by-time` decay: early augment = spend heavily, late = spend little.
- Will delete smallest owned server to make room for a bigger one (upgrade path).
- Min exponent 5 (32GB) by default; won't buy smaller.
- Comparisons: new server must be >25% of home RAM, and add >2% to total network RAM.

**Home RAM handling**:
- `homeReservedRam` (default 32GB from `--reserved-ram`) subtracted from home's available RAM in all scheduling.
- Doubles to 64GB when home hits 512GB (`--double-reserve-threshold`).
- When home RAM < 16GB (BN 1.1), daemon uses `harakiri-sushi` as a backup server for helper scripts.
- autopilot pushes extra reserve if SF4 < level 3 (singularity functions are more expensive).

**Hacknet in botnet**:
- `--use-hacknet-servers` flag enables using hacknet nodes as script hosts.
- `host-manager.js` explicitly excludes hacknet from utilization stats if they have 0 used RAM (preserving their hash production).
- `arbitraryExecution` pushes hacknet servers to the back of the preferred execution order.

### 4. Phase Detection

There is no single `gamePhase` variable. Instead, daemon and autopilot read a collection of signals:

| Signal | Behavior change |
|---|---|
| `homeRam == 8` (BN 1.1 fresh) | maxTargets=1, show manual buy hints, use backup server |
| `homeRam < 32` | No share, maxTargets=1 |
| `homeRam < 64 && !SF4` | Print manual upgrade reminder every 10 min |
| `hack < 500 && timeSinceAug < 10min` | kickstartHackXp (study + XP cycles) |
| `ScriptHackMoney * MoneyGain == 0` | xpOnly mode, no hacknet server buy logic |
| `hack >= 75% of WD req` | prioritizeHackForWd = true → XP mode via daemon relaunch |
| `hack >= 8000` (configurable) | Tighter timing args passed to daemon |
| `totalRam >= 1TB` | share auto-enabled |
| `homeRam >= 512GB` | homeReservedRam doubled |
| `getTimeInAug() >= 15 min` | Start spending hashes on best server |
| `lowUtilizationIterations > intervalsPerCycle` | Increase maxTargets or recoveryThreadPadding |
| `highUtilizationIterations > 60` | Decrease maxTargets |
| `dictSourceFiles[4]` (SF4 owned) | Enable singularity-dependent scripts |
| `Formulas.exe exists` | Use formulas API for precise hackPercent calculation |

### 5. Hacknet

**Two-script architecture**:
- `hacknet-upgrade-manager.js`: buys upgrades (hardware), runs periodically from daemon
- `spend-hacknet-hashes.js`: spends hashes (software), runs continuously

**ROI model**: compares `addedProduction / cost` across all nodes and all upgrade types. Buys the best. New nodes compared as `worstNodeProduction / newNodeCost` (deliberately optimistic).

**Payoff thresholds** (from daemon periodic config):
- One-time kick: buy if payoff < 1h, no spend limit
- Ongoing: buy if payoff < 4h AND cost < 10% of money
- Scraps: buy if payoff < ∞ AND cost < 0.1% of money

**Hash spending** (from autopilot):
- After 15 min in aug: spend on `Increase_Maximum_Money` for best server
- Also spend on `Reduce_Minimum_Security` if min security > 2
- daemon fallback: spend for $1M if money < $10M and have spare RAM

**Hash capacity**: cache upgrades unlock more capacity (capacity = 1 hash * 2^cache). Valued at 1% production per cache level, ensuring they're bought before they're needed.

### 6. Notable Techniques

**`additionalMsec` in hgwOptions**: hack/grow/weaken start times are packed into the operation's own wait time. No extra `ns.sleep(delay)` needed. Clean and avoids wasting a thread's uptime sleeping.

**Greedy bin-packing simulation** in `getPerformanceSnapshot`: simulates placing batch jobs on sorted server list to estimate how many batches can be scheduled, without committing RAM. Used to optimize steal % without trial-and-error scheduling.

**`recoveryThreadPadding`**: multiplier on grow/weaken threads (default 1, auto-scales up with spare RAM, up to 10x). Acts as a budget for misfire recovery. With padding, a server can re-prep itself after a misfire without intervention.

**Prefer home for grow/weaken** in `arbitraryExecution`: home's multi-core bonus makes grow/weaken more effective per thread. Explicitly moved to front of preferred server list for those tools.

**`ps()` caching** (`psCache`): cleared once per main loop, cached per-server within the loop. Avoids repeated expensive ps() calls when checking isTargeting/isPrepping for multiple servers.

**`isPrepped()` tolerance**: accepts 1% deviation in both security (above min) and money (below max). Avoids unnecessary re-prep from floating point drift.

**`Server._files` lazy cache**: `hasFile(fileName)` caches the server's file list as a `Set` on first call. Avoids repeated `ns.ls()` calls.

**Backwards compatibility layer** in `checkBackwardsCompatibility`: maps v2 API names to v3 names in command strings, so older saves still work.

**Special edge case** when `percentageStolenPerHackThread >= 1` (early game, low skill): uses two-grow strategy (inject$1/thread then grow to max) instead of normal post-theft grow.

**Config file persistence**: autopilot writes changed args to `autopilot.js.config.txt`, which is auto-loaded on restart after install/destroy. Survives BN transitions.

### 7. Strengths & Weaknesses

**COPY / EMULATE:**
- `getNsDataThroughFile` RAM-dodging pattern (helpers.js): essential for early-game and general robustness
- `additionalMsec` timing trick in Remote scripts (replaces `sleep()`)
- `optimizePerformanceMetrics` / `getPerformanceSnapshot`: the bin-packing steal% optimization is well-thought-out
- `analyzeSnapshot` binary-search approach: far better than random or gradient descent
- `getScheduleTiming`: clean absolute-time batch scheduling math, working backwards from terminal weaken
- `recoveryThreadPadding` concept: self-healing from misfires via thread over-allocation
- `arbitraryExecution` RAM packer: prefer large servers, home for grow/weak, hacknet last
- `reserve-by-time` decay in host-manager: great idea for early-aug spending discipline
- Adaptive `maxTargets` with utilization feedback loop
- `host-manager` upgrade logic: delete worst owned server to make room for better one
- Per-loop `psCache` clearing pattern
- The `Server` class with lazy-cached properties and `resetCaches()` per loop
- Staggered periodic script intervals (avoids RAM bursts)

**REBUILD CLEANER:**
- `daemon.js` is a 1800-line monolith. Should be split: scheduler, server model, helper launcher, XP farmer are all entangled.
- Phase detection is scattered flags/conditions with no central state machine. Hard to reason about.
- Coordination between autopilot and daemon launching the same scripts (stockmaster, gangs, etc.) creates confusion about which one owns what.
- `loopingMode` is half-finished and disabled (`TODO` everywhere). Either commit or remove.
- XP farming logic (`farmHackXp`, `scheduleHackExpCycle`) is deeply nested and hard to test independently.
- `getPerformanceSnapshot` bin-packing simulation doesn't account for the actual server-preference algorithm used by `arbitraryExecution`, so it can be over-optimistic.
- `prepServer` allows grow thread splitting but normal scheduling doesn't - inconsistency.
- No clean separation between "compute" and "player" thread concerns in daemon (it launches work-for-factions, bladeburner, gangs).
- Configuration files (`config.txt`) survive resets but can get stale/wrong type — code has special workarounds for this.

---

## Interesting Discoveries

- **autopilot runs stockmaster twice**: once in its own `checkOnRunningScripts` and once as a daemon async helper. The autopilot version takes precedence (it runs first and sets a flag). Daemon's version becomes a no-op.

- **WD hack requirement is cached forever**: once `wdHack` is resolved (from `ns.scan("The-Cave")`), it's never re-checked. This means if the requirement changed, you'd be stuck. Works in practice because WD requirement doesn't change mid-BN.

- **`waitForCycleEnd` polling pattern**: when an XP cycle is about to end, it polls every 5ms for up to 200ms waiting for the process to finish. This avoids missing the "just completed" window.

- **`getHostManagerBudget` reads `moneySources`**: this requires `ns.getMoneySources()`, which daemon refreshes every 60 loop iterations via `refreshDynamicServerData`. Budget calculation would be wrong on the first iteration.

- **hack/grow/weaken scheduling order within a batch**: hack and grow are scheduled before weakens (in the code). But within H/G, whichever needs more threads goes first. This is because large jobs are harder to place — better to fail early than waste time scheduling small jobs first.

- **Stanek's gift sequence**: stanek.js is launched as a blocking pre-step before daemon, using the `--on-completion-script daemon.js` pattern to chain them. During stanek, daemon is launched with `--reserved-ram 1E100` (essentially infinite, leaves all home RAM for stanek).

- **`ns.getMoneySources()` for server budget tracking**: instead of tracking its own spend, host-manager relies on `ns.getMoneySources().sinceInstall.servers` to know how much has been spent on servers this augmentation. Clean.

- **Intelligence farming mode** (`-i`): daemon can target the currently connected terminal server with `manualhack` for intelligence stat. A niche feature but integrated into the same loop.
