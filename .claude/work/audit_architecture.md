# Cold Audit: Wave 4 Strategy Engine Plan (Sections 4.1-4.4)

**Auditor:** Automated adversarial review  
**Date:** 2026-06-28  
**Scope:** continuous_improvement.md sections 4.1-4.4, verified against docs/bitburner_reference.md  
**Severity Scale:** Critical (prevents autonomous play) > Major (causes incorrect behavior) > Minor (inefficiency or gap)

---

## 1. Architecture Decision (4.1)

### Verdict: CHOSEN approach is correct, but the alternatives were dismissed too quickly.

**Strengths of the chosen approach:**
- Single process means phase transitions are instant -- no IPC, no kill/restart dance.
- The two-tier split (boot_agent on home + strategy_agent on bigger server) is a pragmatic RAM workaround.
- Pure-function strategies are testable in isolation.

**Problems with the alternatives analysis:**

**Option B (separate strategy scripts per phase) was dismissed incorrectly.** The rationale says "need to kill/restart scripts on phase transition, coordination overhead." But the actual overhead is minimal:
- Only ONE strategy runs at any time. The others sit as files on the server -- they cost 0 RAM when not running.
- The 4.5 GB RAM estimate for the monolithic agent includes ALL action-execution imports (run, exec, scp, scriptKill, read, write, rm = ~6.9 GB). A per-phase split would let each strategy import only the functions it needs, reducing the agent's RAM footprint by 30-50%.
- **The real cost of the monolith:** The agent pays the RAM for `exec` (1.3 GB), `scriptKill` (1.0 GB), `read` (1.0 GB), `write` (1.0 GB), and `rm` (1.0 GB) in every phase, even though BOOTSTRAP only needs `scp`, `exec`, and `run` (~2.9 GB total). This is what drives the two-tier architecture requirement.

**Option D (behavior tree) was dismissed as "overly complex."** A behavior tree for 5 phases with priority ordering is essentially the same `if/else if` chain already in `detectPhase()`. The difference is that a behavior tree gives you a standardized way to add fallback, sequence, and parallel nodes -- which the plan already needs for concurrent actions (e.g., "hack AND buy port openers AND deploy scripts"). The RAM cost argument ("adds RAM cost for tree evaluation") is wrong: pure computation costs 0 GB. Dismissing it on that basis is a factual error.

### Finding: The plan never considered server purchasing as part of the architecture.

The ROM hierarchy assumes the strategy agent runs on `foodnstuff` (16 GB total, ~14 GB free). But in a fresh BitNode-1 start, the strategy agent would need ~4.5 GB free. That fits. However, in a tighter BitNode (reduced server RAM multipliers), foodnstuff might only have 8 GB or less. **The plan has no fallback for environments where no 0-port server has enough free RAM.** A purchased server (cheapest: $110k for 2 GB, $440k for 8 GB) is never mentioned as a strategy agent host.

---

## 2. Phase Detection Algorithm (4.2)

### 2.1 Adversarial Scenario: Stuck in BOOTSTRAP forever

**CONDITIONS:**
- `homeMaxRam <= 16 AND rootedCount < 3`

**Failure modes:**

| Scenario | Root Cause | Likelihood |
|---|---|---|
| Only 1-2 servers rooted, none have enough free RAM for strategy_agent | BOOTSTRAP runs scan_nuke every cycle but no new rootable servers appear. scan_nuke may have rooted all 0-port servers already. Cycle loops: scan_nuke -> no candidates -> scan_nuke. | **High** in BitNodes with reduced server RAM. There are only 6 zero-port servers. If only 2 have > 4.5 GB free, you're stuck. |
| boot2RunningOn never gets set | The BOOTSTRAP strategy checks `s.boot2RunningOn` which is NOT defined in the GameState interface (section 4.2). There is no mechanism shown for populating this field. Does the snapshot call `ns.ps()` or `ns.isRunning()`? Neither is in the RAM budget. | **Critical** -- without a way to check if boot2 is running, this field is always undefined, and the agent never transitions. |
| relay server gets nuked/reinstalled | Server reset clears scripts. boot2RunningOn becomes stale. Next cycle, agent believes relay is still running but it isn't. | **Major** -- acknowledged in 4.10 Q4 as "Phase 2 concern" but not handled. |

**Verdict: Critical gap.** The boot2RunningOn field is load-bearing but has no defined population mechanism in the GameState snapshot. Without calling `ns.isRunning('/monitor/boot2.js', host)` (0.1 GB) or `ns.ps(host)` (0.2 GB), the agent cannot tell if the relay is alive. Both functions are absent from the 4.5 RAM budget.

### 2.2 Adversarial Scenario: Skip SNOWBALL, go straight to EXPANSION without enough money

**CONDITIONS to skip SNOWBALL:**
- `rootedCount >= 5 AND hasAnyPortOpener = true`

**Failure analysis:**

There are exactly 6 zero-port servers: `foodnstuff`, `sigma-cosmetics`, `joesguns`, `nectar-net`, `hong-fang-tea`, `harakiri-sushi`. scan_nuke can root all 6 immediately if the player's hack level is high enough.

If the player created BruteSSH.exe (takes 10 minutes of real time via `createProgram()` -- available even without Singularity) while scan_nuke was running, then:
- `rootedCount = 6` (all zero-port servers)
- `hasAnyPortOpener = true` (BruteSSH.exe exists on home)
- SNOWBALL condition: `rootedCount < 5 || !hasAnyPortOpener` = `false || false` = false. **We skip SNOWBALL.**
- EXPANSION condition: `unrootedNukable > 0` = true (there are 1-port servers we can now root).

**Impact:** We jump to EXPANSION with only 1 port opener and no money (scanning doesn't generate income). EXPANSION runs scan_nuke which roots 1-port servers. But the agent has NO hack loop running -- EXPANSION's strategy only runs scan_nuke + deploy scripts. It does NOT run a hack loop. **Money generation is zero during EXPANSION.**

This is actually survivable if there are already hack scripts deployed from earlier. But if SNOWBALL never ran (because the phase detector skipped it), no hack scripts were deployed either. The agent is now in EXPANSION with no income and no mechanism to start generating income.

**Verdict: Critical.** EXPANSION strategy (section 4.3) does not include a hack loop. If SNOWBALL is skipped because `createProgram` was used instead of `purchaseProgram`, the agent enters EXPANSION with zero income and no way to generate money.

### 2.3 Adversarial Scenario: Transition to BATCH when targets aren't prepared

**CONDITIONS for BATCH:**
- All previous conditions false (not BOOTSTRAP, SNOWBALL, EXPANSION, PREPARATION)
- Specifically: `unpreparedTargets = 0`

**Failure mode:**

If `unrootedNukable = 0` (all nukable servers are rooted) AND `unpreparedTargets = 0` (because the state snapshot says targets are prepared), we go to BATCH. But the snapshot could be wrong if:
- The snapshot calls `ns.getServer(host)` which returns current server state at the moment of the call. If auto_grow ran in the previous second but hasn't finished growing yet, the server still shows lower money / higher security. The snapshot would count it as "unprepared."
- Conversely, if the snapshot runs right after a grow completes but before the next hack cycle, it shows "prepared" even though batch will immediately degrade it.

**Mitigation:** The plan's BATCH strategy just launches `batch_hack.js` which has its own preparation check internally. `batch_hack.js` won't start HWGW cycles on unprepared targets. So the transition to BATCH is safe even if targets aren't prepared -- batch_hack handles it.

**Verdict:** Minor. The strategy layer's incorrect assessment is caught by the execution layer.

### 2.4 Adversarial Scenario: Phase oscillation (ping-pong)

**PREPARATION <-> BATCH oscillation:**

This is the most dangerous ping-pong scenario:

1. PREPARATION runs auto_grow on targets.
2. Next cycle: `unpreparedTargets = 0` -> transition to BATCH.
3. BATCH runs `batch_hack.js`. Batch hack starts hacking (security goes up, money goes down).
4. Next cycle: `unpreparedTargets > 0` (because hacks degraded the targets) -> transition back to PREPARATION.
5. PREPARATION runs auto_grow again (killing any running batch operations?).
6. Go to step 2.

The cycle repeats every ~2 seconds. **Neither phase achieves its goal because neither runs long enough.**

**Root cause:** The phase detector uses an instantaneous snapshot to make a decision that should consider the trajectory of operations. PREPARATION's exit condition (`unpreparedTargets = 0`) is the inverse of BATCH's implicit precondition (`unpreparedTargets = 0`), creating a feedback loop where each phase immediately invalidates the other's work.

**Possible mitigation not in the plan:** A phase should only transition to BATCH after confirming targets STAY prepared for N consecutive cycles (hysteresis). Or the phase detector should be weighted -- once in BATCH, only fall back to PREPARATION if unpreparedTargets exceeds a threshold (not > 0).

**Verdict: Critical.** This oscillation will prevent batch hacking from ever completing a full HWGW cycle.

**EXPANSION stay-forever scenario (not oscillation, but similar):**

If there are unrooted servers that require more ports than we have (e.g., we have 2 port openers but servers need 3), `unrootedNukable = 0` for those servers. But wait -- unrootedNukable specifically counts servers we CAN root. So servers needing 3 ports when we have 2 are NOT counted. unrootedNukable = 0 -> we leave EXPANSION. But we're leaving without rooting everything reachable.

Actually, this is correct behavior: we root what we can, prepare/batch with those, and trust that scan_nuke runs periodically from BATCH to catch new servers when we get more port openers. The BATCH strategy does include `EXEC scan_nuke on home` every cycle. So this isn't a stuck scenario.

### 2.5 unrootedNukable accuracy analysis

The GameState includes:
```
unrootedNukable: number;  // how many we CAN root (have enough ports)
maxPorts: number;         // how many ports we can open right now
```

**The count is wrong if:**

1. **Hacking level check is missing.** The reference doc says "Hacking level does NOT matter for nuking -- only port count matters" (doc section 6). So this is correct -- only port count matters for nuking. However, to HACK a server you need the required hacking level. A nuked but unhackable server is still a rooted server, but it's useless for income. The plan needs to distinguish between "can nuke" and "can hack" for target selection. Currently `hackableServers` is defined as "rooted, money > 0, level <= ours" -- this is correct for hacking eligibility.

2. **Port opener existence might be stale.** The snapshot checks `fileExists()` (0 GB) which is real-time. But between the snapshot and the action execution, the game state doesn't change in a way that would add/remove port openers (you can't lose programs). The count is stable within a cycle.

3. **Reachability.** The plan assumes all unrooted servers that appear in `unrootedServers` are reachable via scan + route. But some servers require specific paths through the network. The plan's `snapshotGameState` would need to use a BFS/DFS pass via `ns.scan()` to discover all reachable servers. This is standard and should work.

**Verdict:** The unrootedNukable calculation is correct assuming a proper BFS scan. No issue here.

---

## 3. Strategy Functions (4.3) -- Per-Strategy Analysis

### 3.1 BOOTSTRAP

**Goal:** Get relay running on non-home server.

**Does it achieve its stated goal?** Yes, in principle. SCP boot2 to largest rooted server, exec it.

**Edge cases NOT handled:**

| Edge Case | Impact | Severity |
|---|---|---|
| No server has enough free RAM for strategy_agent (4.5 GB) | Stuck in BOOTSTRAP forever running scan_nuke | Critical |
| boot2RunningOn in GameState has no defined population mechanism | Phase never transitions | Critical |
| `s.serverFreeRam` is not defined in GameState interface | Candidate filter crashes at runtime (`s.serverFreeRam[b] > BOOT2_RAM_COST` on undefined) | Critical |
| No server purchased (never considered as option) | Misses obvious solution: buy a cheap server for $110k | Major |
| Candidate sort accesses `s.serverFreeRam[b]` -- this property doesn't exist in the defined GameState | `undefined` comparison on sort, likely runtime error | Critical |

**Exit condition:** `s.boot2RunningOn && s.boot2RunningOn !== 'home'` -- but this field is never populated in the snapshot. The strategy returns `[]` (empty actions) when this condition is met. An empty action list in the main loop means "do nothing this cycle" -- but detectPhase still runs next cycle and should transition. The problem is that the condition can never be true if the field is never set.

**Could two strategies fire conflicting actions?** BOOTSTRAP only runs when it's the active phase. No conflict.

### 3.2 SNOWBALL

**Goal:** Generate money, buy port opening programs.

**Does it achieve its stated goal?** Partially. The hack loop will generate money. But the program purchase relies on `BUY_PROGRAM` action type, which has **no working implementation for non-Singularity play**.

**Edge cases NOT handled:**

| Edge Case | Impact | Severity |
|---|---|---|
| `ns.singularity.purchaseProgram()` requires SF-4 | Without SF-4, no programs can be purchased. The plan acknowledges this in 4.10 Q2 but doesn't fix it in the strategy. | Critical |
| `simple_hack.js` doesn't exist yet (section 4.10 Q1: "Write a new ~50-line simple_hack.ts") | The strategy references a script that hasn't been written | Major |
| `hasDeployScripts[host]` is not in GameState interface | Runtime error when checking deploy status per host | Critical |
| Money check uses `s.money > opener.cost * 1.5` but money can change between snapshot and purchase | Not a bug -- this is a safety margin. But `s.money` is a snapshot, so if you spend money between snapshot and purchase... actually the action is executed in the same cycle. No issue. | Minor |
| Only buys ONE opener per cycle (due to `break`). With 5 openers and 1s cycle, takes 5 seconds to buy all. Acceptable. | None. | Informational |

**Exit condition discrepancy:** The text says "Once we have port openers and > 3 rooted servers" but the phase detector checks `rootedCount < 5` (not 3). This is a documentation bug. The code is authoritative (uses 5), but the text is misleading.

**Could two strategies fire conflicting actions?** SNOWBALL runs `DEPLOY` to all rooted servers. EXPANSION also runs `DEPLOY` to all rooted servers. If the agent transitions between SNOWBALL and EXPANSION, DEPLOY actions from both phases could conflict. But DEPLOY just copies scripts -- idempotent. No real conflict.

### 3.3 EXPANSION

**Goal:** Root every reachable server.

**Does it achieve its stated goal?** It runs scan_nuke every cycle. But scan_nuke only roots servers it can -- if some servers need more ports, they stay unrooted. The phase transitions away when unrootedNukable = 0, but this doesn't mean "everything is rooted" -- it means "nothing more can be rooted right now." The stated goal is misleading but the behavior is correct.

**Edge cases NOT handled:**

| Edge Case | Impact | Severity |
|---|---|---|
| scan_nuke runs every 1 second cycle. scan_nuke does a full BFS scan every time. This is wasteful for the network scan portion (the result hasn't changed). | CPU waste in-game, but harmless. | Minor |
| No income generation during EXPANSION. If the agent skipped SNOWBALL (see 2.2), EXPANSION has zero hack loops. | Zero income until phase transitions to PREPARATION/BATCH. | Critical (if combined with 2.2) |
| The state snapshot shows `unrootedNukable > 0` but by the time scan_nuke execs, another process might have used the RAM. scan_nuke could fail silently. | Failed scan_nuke means unrooted servers stay unrooted. Next cycle still shows unrootedNukable > 0 -> stuck loop. | Major |

**Exit condition:** `unrootedNukable > 0` being false. Correct but fragile if the snapshot and execution are out of sync.

**Could two strategies fire conflicting actions?** DEPLOY conflicts in theory (same as SNOWBALL), but copy is idempotent.

### 3.4 PREPARATION

**Goal:** Prepare batch targets (max money, min security).

**Does it achieve its stated goal?** The strategy distributes auto_grow threads. However:

1. **auto_grow might need weaken first.** If a server is at high security, auto_grow's grow operations are very slow (grow time scales with security). The strategy doesn't check security before running auto_grow. If auto_grow.ts includes its own weaken logic internally, this is fine. The plan doesn't specify auto_grow's behavior.

2. **Thread distribution is aggressive.** It uses half of ALL free RAM on ALL rooted servers for ONE target (per loop iteration). With 4 targets, it could use 50% of all RAM across the entire farm. The plan caps at `MAX_PREP_TARGETS` (typically 4). If auto_grow is inefficient (too many threads waste RAM), this starves other operations.

3. **No priority ordering.** It prepares `hackableServers` in whatever order the snapshot returned them. No sorting by "how close to prepared" or "value."

**Edge cases NOT handled:**

| Edge Case | Impact | Severity |
|---|---|---|
| Server free RAM changes between snapshot and exec | exec might fail (returns pid=0). No retry logic. | Major |
| No weakening before growing | If security is high, growth is slow. Preparation takes much longer. | Major |
| **Starvation:** PREPARATION uses `Math.floor(freeRam / GROW_RAM_COST / 2)` which means 50% utilization. But if multiple targets are being prepared, each gets some portion. If a target has very low growth factor, it may never reach max money. | Target stays unprepared forever -> phase never transitions. | Critical |
| What if ALL hackableServers are already prepared? Then targetsToPrep is empty, no actions produced. Safe. | None. | Informational |

**Exit condition:** `unpreparedTargets > 0` being false. This is correct -- once all targets are prepared, we move on. But oscillation risk with BATCH (see 2.4).

### 3.5 BATCH

**Goal:** Full HWGW batch cycles on prepared targets.

**Does it achieve its stated goal?** It launches batch_hack.js which is the existing orchestrator. The strategy itself is just a launcher -- it delegates the hard work to the existing engine.

**Edge cases NOT handled:**

| Edge Case | Impact | Severity |
|---|---|---|
| `isBatchHackRunning` is NOT in GameState interface | Check `!s.isBatchHackRunning` references undefined field. Will always evaluate to `undefined` (falsy), so batch_hack gets relaunched EVERY cycle. Multiple instances pile up. | Critical |
| batch_hack.js crashes with | Relaunch on next cycle (since undefined is falsy). Actually this works by accident -- the relaunch is correct. | Informational (bug + behavior compensate) |
| scan_nuke runs every cycle. In BATCH, this is unnecessary overhead (server topology doesn't change). | Wasteful, especially with full BFS scan. | Minor |
| `--homeRam` flag uses `s.homeMaxRam * 0.25` -- reserves 25% of home RAM for the agent. But the agent runs on a different server in the two-tier setup. | Home RAM reservation is meaningful for batch_hack internals (it may use home for operations). This is correct. | Informational |

**Exit condition:** There is no exit condition. BATCH is the terminal phase. The strategy only transitions away if detectPhase changes, but there's no mechanism in BATCH strategy to detect "we should stop batching." If batch operations are no longer viable (e.g., servers become unprepared), the phase oscillation kicks in (2.4).

**Could two strategies fire conflicting actions?** If the phase oscillates PREPARATION <-> BATCH, PREPARATION's auto_grow and BATCH's batch_hack will both be running simultaneously, competing for RAM and conflicting on target servers (both trying to grow/hack the same target). **This is a genuine resource conflict.**

---

## 4. Action Execution (4.4)

### 4.1 Action Type Completeness

**Actions defined:** RUN, EXEC, KILL, SCP, BUY_PROGRAM, DEPLOY

**Actions MISSING:**

| Missing Action | Why Needed | Severity |
|---|---|---|
| **KILLALL** | Kill all scripts on a server (e.g., to free RAM for strategy agent relocation). `ns.killall(host)` costs 0.5 GB. | Major |
| **PURCHASE_SERVER** | Buy new servers for RAM expansion. `ns.purchaseServer(name, ram)` costs 2.25 GB. The plan never considers server purchasing as a strategy action. | Critical |
| **HOME_RAM_UPGRADE** | Upgrade home RAM. Without this, the agent is locked into the two-tier architecture permanently. `ns.singularity.upgradeHomeRam()` requires SF-4, but there's no terminal command fallback. | Major |
| **TERMINAL_COMMAND** | Type any command into the terminal via DOM injection. Required for buying programs without Singularity (the plan's 4.10 Q2 solution). | Critical (if no SF-4) |
| **SPAWN** | Replace the current script (useful for self-updating the strategy agent). `ns.spawn()` costs 2.0 GB. | Minor |
| **SCAN_AND_NUKE** | Dedicated action for nuking, instead of relying on EXEC of scan_nuke.ts. Not necessary but cleaner. | Minor |

### 4.2 pid=0 Failure Handling

The `executeActions` function in section 4.4 calls `ns.run()` and `ns.exec()` but **completely ignores the return value (pid)**. When `ns.run()` returns 0, it means the script failed to start (insufficient RAM, script not found, invalid args, or server doesn't have the script).

**Consequences of ignoring pid=0:**

| Scenario | What Happens | Severity |
|---|---|---|
| scan_nuke exec fails (sufficient RAM but another process started first) | Agent believes scan_nuke is running, but it isn't. unrootedNukable remains > 0 -> stuck in EXPANSION. | Critical |
| auto_grow exec fails during PREPARATION | Targets never get prepared -> stuck in PREPARATION forever. | Critical |
| boot2 exec fails during BOOTSTRAP | No relay deployed. Agent keeps running scan_nuke, accumulating no progress. | Critical |
| batch_hack exec fails during BATCH | `isBatchHackRunning` is checked next cycle (even though undefined), batch_hack is relaunched. Actually works by accident. But each failure wastes a cycle. | Major |

**Missing: A retry mechanism, a fallback action (try a different server), or at minimum a log message when pid=0.**

### 4.3 BUY_PROGRAM Implementation

The plan's BUY_PROGRAM handler says:
```typescript
case 'BUY_PROGRAM':
  // Use singularity if available, otherwise log for Claude
  break;
```

**This is a no-op.** Without Singularity SF-4, `ns.singularity.purchaseProgram()` is unavailable. The plan acknowledges this in 4.10 Q2 but proposes a half-solution that depends on Claude (external) intervening via DOM terminal injection. **The strategy engine is supposed to be autonomous.** If Claude must type terminal commands, the agent is not autonomous.

**What the execution model should do here:**
1. Try `ns.singularity.purchaseProgram('BruteSSH.exe')` -- silently fail if Singularity is unavailable.
2. If Singularity is unavailable, the agent should try DOM terminal injection itself: `eval("document")` -> type `buy BruteSSH.exe` -> press Enter.
3. If neither works, the agent should fall back to creating the program: `ns.singularity.createProgram('BruteSSH.exe')` (requires SF-4 Level 3? No, actually `createProgram` is Singularity Level 3 -- requiring SF-4 L3).

Wait, let me check: the reference doc says `createProgram()` is a Level 3 Singularity function. But creating programs without Singularity is done via the terminal command `create -p BruteSSH.exe`. This takes 10 minutes and the player (or script) just waits.

Without any Singularity access and without DOM injection, **the agent cannot buy or create programs programmatically**. This is a fundamental blocker.

**Verdict: Critical.** The BUY_PROGRAM action is unimplemented for non-Singularity gameplay, which is the default for any fresh BitNode playthrough.

### 4.4 DEPLOY Implementation

The plan's DEPLOY handler says:
```typescript
case 'DEPLOY':
  // Copy hack/grow/weaken to target host
  break;
```

**Also a no-op.** The comment is aspirational. DEPLOY presumably needs to:
1. SCP the worker scripts (hack.js, grow.js, weaken.js) to the target host. `ns.scp()` costs 0.6 GB.
2. Potentially launch keep-alive scripts.

Without implementation, the DEsplay action does nothing. The SNOWBALL and EXPANSION strategies both rely on DEploy to distribute scripts. **Without working DEploy, no hack scripts run on remote servers.**

**Verdict: Critical.** The DEploy action is unimplemented.

### 4.5 RAM Budget Accuracy

The plan says action execution functions cost ~6.9 GB (run + exec + scp + scriptKill + read + write + rm). Let me verify:

| Function | RAM Cost | Source |
|---|---|---|
| `ns.run()` | 1.0 GB | Reference doc section 1.2 |
| `ns.exec()` | 1.3 GB | Reference doc section 1.2 |
| `ns.scp()` | 0.6 GB | Reference doc section 1.5 |
| `ns.scriptKill()` | 1.0 GB | Reference doc section 1.2 |
| `ns.read()` | 1.0 GB | Reference doc section 1.5 |
| `ns.write()` | 1.0 GB | Reference doc section 1.5 |
| `ns.rm()` | 1.0 GB | Reference doc section 1.5 |
| **Total** | **6.9 GB** | **Correct** |

But some of these might not be needed if the strategy agent doesn't use file-based IPC (which it doesn't -- it executes actions in-memory):
- The strategy agent DOES NOT need `read`, `write`, `rm` for its own operation -- those are for the boot agent's command relay. But the plan says the strategy agent uses `write` for decision logging. And the two-tier architecture has the strategy agent calling `exec`, `run`, `scp` directly.

**Corrected estimate for strategy_agent (no file I/O):**
- `ns.run()`: 1.0 GB (launch scripts on same server)
- `ns.exec()`: 1.3 GB (launch scripts on remote servers)
- `ns.scp()`: 0.6 GB (deploy worker scripts)
- `ns.scriptKill()`: 1.0 GB (stop scripts)
- `ns.write()`: 1.0 GB (decision logging)
- Base: ~1.6 GB
- Snapshot: ~0.85 GB (getServer + getPlayer + scan + getHackingLevel)
- **Total: ~6.35 GB** (without read, rm)

That's higher than the stated "~4.5 GB" even without read and rm. Let me recheck... is there a discrepancy? The plan says the strategy agent is ~4.5 GB but that doesn't include ns.exec (1.3 GB) for remote execution or ns.scriptKill (1.0 GB).

Let me recalculate more carefully:
- Base: 1.6 GB
- Snapshot: getServer 0.3, getPlayer 0.3, scan 0.2, getHackingLevel 0.05 = 0.85
- Action execution: run 1.0, exec 1.3, scp 0.6, scriptKill 1.0, write 1.0 = 4.9
- Port openers: brutessh, ftpcrack, relaysmtp, httpworm, sqlinject, nuke = 0 GB
- Total: 1.6 + 0.85 + 4.9 = **7.35 GB**

The plan says ~4.5 GB. This discrepancy needs resolution. The plan may be omitting some action function imports.

**Verdict: Major.** The RAM estimate is ~2.85 GB too low. The strategy agent needs ~7.35 GB, not ~4.5 GB. This means it won't fit on foodnstuff (16 GB total, maybe 14 GB free) -- actually it would still fit. But the estimate being wrong by 63% undermines confidence in the RAM analysis.

Wait, let me re-read the plan's table more carefully:

Section 4.5 says:
| Component | Functions | Added RAM |
|---|---|---|
| Base script cost | (all scripts) | ~1.6 GB |
| State snapshot | getServer, getPlayer, scan | ~0.85 GB |
| Action execution | run, exec, scp, scriptKill, read, write, rm | ~6.9 GB -> **can reduce** |

Then it says "Solution -- Two-tier architecture":
1. boot_agent (~3.3 GB): Only run, exec, read, write, rm, fileExists, sleep -- no state reading
2. strategy_agent (~4.5 GB): Full state snapshot + strategy + decision log. Uses exec to launch workers, write for decision log.

Hmm, the plan's own estimate puts strategy_agent at 4.5 GB. But my calculation gives 1.6 + 0.85 + 1.0 (run) + 1.3 (exec) + 0.6 (scp) + 1.0 (scriptKill) + 1.0 (write) = 7.35 GB.

Maybe the plan assumes not all of these are imported? If the strategy_agent only imports run, exec, scp, write = 1.0 + 1.3 + 0.6 + 1.0 = 3.9 GB for actions, plus 1.6 base + 0.85 snapshot = 6.35 GB. Still not 4.5 GB.

Unless the plan is assuming some functions aren't imported into strategy_agent. For example, if the strategy_agent doesn't have write (decision logging is done via a separate mechanism) -- 1.6 + 0.85 + 3.9 = 6.35 GB. Still not 4.5.

Or if it's using ns.kill (0.5 GB) instead of ns.scriptKill (1.0 GB) -- 1.6 + 0.85 + 1.0 + 1.3 + 0.6 + 0.5 + 1.0 = 6.85 GB. Still not 4.5.

I think the 4.5 GB estimate is simply missing some imports. This is a significant finding.

---

## 5. Overall: Top 3 Risks

### Risk 1 (Critical): Phase Oscillation Between PREPARATION and BATCH

**The problem:** The phase detector uses instantaneous GameState to make binary phase decisions. PREPARATION exits when `unpreparedTargets = 0`, and BATCH starts. As soon as BATCH runs a single hack, `unpreparedTargets > 0`, and the agent flips back to PREPARATION. Neither phase ever completes its objective.

**Why it's the top risk:** This will manifest on literally every playthrough that reaches the PREPARATION/BATCH boundary. It is not an edge case -- it is the normal flow. The agent will spend every second cycle undoing the previous phase's work.

**What's needed:** Phase hysteresis (e.g., only transition from PREPARATION to BATCH after N consecutive cycles of all targets being prepared) or a phase lock-in mechanism (once in BATCH, only leave if significantly degraded).

### Risk 2 (Critical): No Viable Path to Buy Port Openers Without Singularity

**The problem:** The entire phase progression depends on acquiring port openers. Without SF-4, `ns.singularity.purchaseProgram()` is undefined. The `BUY_PROGRAM` action is a no-op (`break`). The plan's fallback ("Claude types the buy command via DOM injection") breaks the autonomy requirement.

**Assumptions that will break on a fresh BitNode:**
1. The user has SF-4 (unlocked after first BitNode completion) -- false for fresh starts.
2. Claude is always connected to type terminal commands -- false if doing autonomous play without external orchestration.
3. The `createProgram` workaround (taking 10 minutes per program) is never considered.

**What's needed:** Either DOM terminal injection built into the agent itself (so it can type `buy` commands without relying on Claude), or a program-creation fallback using `ns.singularity.createProgram()` (if SF-4 L3 available) or the 10-minute `create -p` terminal command.

### Risk 3 (Major): GameState Has Missing Fields That Will Cause Runtime Crashes

**The problem:** The strategy code references fields that don't exist in the GameState interface:

| Reference | Field | Defined in GameState? | Used In |
|---|---|---|---|
| `s.boot2RunningOn` | Not defined | No (not in section 4.2 interface) | BOOTSTRAP strategy |
| `s.serverFreeRam[host]` | Not defined | No (not in section 4.2 interface) | BOOTSTRAP, PREPARATION strategies |
| `s.hasDeployScripts[host]` | Not defined | No (not in section 4.2 interface) | SNOWBALL, EXPANSION strategies |
| `s.isBatchHackRunning` | Not defined | No (not in section 4.2 interface) | BATCH strategy |

These will produce `undefined` at runtime, which is falsy. Some will accidentally work (e.g., `!s.isBatchHackRunning` being `true` means batch_hack gets relaunched every cycle -- wasteful but functional). Others will crash (e.g., `s.serverFreeRam[b]` accessed as a number `> BOOT2_RAM_COST` produces NaN comparison, which is always false).

**What's needed:** Before any code is written, the GameState interface and snapshot function must be fully specified with ALL fields the strategies require. The current state is pseudocode with invisible dependencies.

---

## Summary of Findings

| ID | Finding | Severity | Section |
|---|---|---|---|
| F1 | boot2RunningOn, isBatchHackRunning, serverFreeRam, hasDeployScripts all missing from GameState interface | Critical | 4.2, 4.3 |
| F2 | Phase oscillation PREPARATION <-> BATCH on every cycle | Critical | 4.2 |
| F3 | BUY_PROGRAM action is a no-op without Singularity SF-4 | Critical | 4.4 |
| F4 | SNOWBALL can be skipped entirely (via createProgram), leaving EXPANSION with no hack loop and zero income | Critical | 4.2 |
| F5 | pid=0 return values from run/exec never checked -- silent failures in all phases | Critical | 4.4 |
| F6 | DEPLOY action is a no-op (empty case body) | Critical | 4.4 |
| F7 | RAM estimate for strategy_agent is ~7.35 GB, not ~4.5 GB (63% underestimate) | Major | 4.5 |
| F8 | No purchased server consideration as strategy agent host | Major | 4.1 |
| F9 | PREPARATION doesn't weaken before growing; may never complete if security is high | Major | 4.3 |
| F10 | Documentation bug: SNOWBALL text says "> 3 servers" but code checks "< 5" | Minor | 4.3 |
| F11 | Option B (separate strategy scripts) dismissed without fair RAM comparison | Minor | 4.1 |
| F12 | Behavior tree dismissed with incorrect "adds RAM cost" claim | Minor | 4.1 |

**Bottom line:** The architecture direction (strategy functions in agent) is sound, but the pseudocode has 6 critical gaps that must be resolved before any implementation begins. The phase oscillation (F2) and the BUY_PROGRAM non-implementation (F3) are the two most impactful -- both will prevent autonomous play on any BitNode.
