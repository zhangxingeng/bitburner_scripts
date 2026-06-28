# Audit Report: Wave 4 Strategy Logic

> **Auditor:** Adversarial review of sections 4.3 (Strategy Functions) and 4.6 (Decision Logging)
> **Date:** 2026-06-28
> **Reference:** `docs/continuous_improvement.md`, actual source code in `src/`

---

## Summary of Severity

| Severity | Count |
|---|---|
| **CRITICAL** — Will prevent the agent from progressing | 5 |
| **HIGH** — Will cause silent failures, wasted cycles, or incorrect behavior | 8 |
| **MEDIUM** — Edge cases unhandled, resilience gaps | 6 |
| **LOW** — Missing observability, suboptimal but not broken | 4 |

---

## 1. BOOTSTRAP Strategy

### CRITICAL-1: boot2.js source does not exist (plan references a ghost file)

The plan references `/monitor/boot2.js` throughout the BOOTSTRAP strategy. It is deployed via SCP, checked for running status, and used as the relay target. The plan itself admits at section 4.7: "These only exist as pushed JS on game servers — no source. Need TypeScript source in repo." Step S2 says "Add boot.ts, boot2.ts, relay.ts source to repo" — but the strategy references boot2 before the source is added.

**Impact:** If built in order S3 before S2 (which the dependency table shows — S3 depends on S2, but the dependency note says "S3 depends on S1, S2"), boot2.js won't exist on home to be SCP'd. The bootstrap will silently fail to find boot2 and run scan_nuke in a loop.

**What should happen:** The strategy must either (a) have a concrete fallback if boot2.js doesn't exist on home, or (b) the build order must guarantee S2 completes before S3. Currently neither is enforced by code.

### CRITICAL-2: BOOT2_RAM_COST is never defined

The strategy pseudocode (line 630) filters candidates by `s.serverFreeRam[h] > BOOT2_RAM_COST`, but this constant is never defined anywhere in the plan — not in the GameState interface, not as a module-level constant. There is no actual measurement of boot2's RAM cost either (it's a ghost file per F-1 above).

**Impact:** The strategy code as written cannot compile. `BOOT2_RAM_COST` will throw a ReferenceError at runtime.

**What should happen:** Define `const BOOT2_RAM_COST = ns.getScriptRam('/monitor/boot2.js')` once, or hardcode after measuring the actual compiled JS.

### HIGH-3: No dependency resolution in SCP

The bootstrap action is:
```
actions.push({ type: 'SCP', script: '/monitor/boot2.js', dest: target });
```
`ns.scp(filename, dest, 'home')` copies exactly one file. If `boot2.js` imports modules (e.g., from `../lib/network` or uses any `import` statement that the bundler doesn't inline), those dependencies will be missing on the target server. The `exec` will fail silently or throw a "Missing script" error at runtime.

**Evidence:** The existing `execMulti` function (in `exec_multi.ts:54-60`) handles this by calling `ensureScriptExists` which wraps `ns.scp()`. The bootstrap SCP does not use this pattern — it copies ONE file with no dependency awareness.

**What should happen:** Either (a) use a bundler that inlines all dependencies into a single JS file, or (b) implement a recursive dependency copy in the SCP action, or (c) use the `execMulti` helper which already handles SCP per-server.

### MEDIUM-4: No scan_nuke cooldown in bootstrap

If no relay candidate is found (candidates.length === 0), the strategy runs scan_nuke every cycle. If scan_nuke finds no new servers (all 0-port servers already rooted, no port openers for the rest), it does nothing useful each time.

```
Every ~1 second: ns.exec('/tools/scan_nuke.js', 'home', 1)
```

scan_nuke.js costs 1 thread but the exec costs 1.3 GB RAM on home. This is a RAM drain with no benefit after the first few cycles.

**What should happen:** Add a cooldown (e.g., 10-30 seconds) or check whether scan_nuke actually found new roots last time before running it again.

### MEDIUM-5: No headroom margin for relay target

The candidate filter is `s.serverFreeRam[h] > BOOT2_RAM_COST`. If a server has exactly BOOT2_RAM_COST + 0.1 GB free, it passes. After boot2 deploys, there is zero headroom for the strategy agent or any workers. The bootstrap succeeded but immediately stalls because no usable RAM remains.

**What should happen:** Use a margin multiplier: `s.serverFreeRam[h] > BOOT2_RAM_COST * 1.5` or add a fixed headroom (e.g., 2 GB).

---

## 2. SNOWBALL Strategy

### CRITICAL-6: Phase deadlock — SNOWBALL cannot transition to EXPANSION

The phase detector transitions out of SNOWBALL when `s.rootedCount >= 5 && s.hasAnyPortOpener`. However, the SNOWBALL strategy **never runs scan_nuke**. It only:
1. Buys port openers
2. Hacks the best target
3. Deploys scripts

If the agent enters SNOWBALL with `rootedCount = 3` (typical: home + 2 0-port servers from BOOTSTRAP), it will:
- Buy all port openers (hasAnyPortOpener = true)
- Never nuke new servers (no scan_nuke call)
- Stay at rootedCount = 3 forever
- `rootedCount (3) < 5` → stays in SNOWBALL indefinitely

**Impact:** **Deadlock.** The agent will hack forever in SNOWBALL, never progressing to EXPANSION, never rooting more servers, never reaching batch hacking. This is the single most critical bug in the phase design.

**What should happen:** SNOWBALL must either (a) run scan_nuke periodically, or (b) the condition must be `rootedCount >= maxRootable` (i.e., all nukable servers are rooted), or (c) the transition must also consider whether we can afford openers and if so, automatically attempt nuking.

### CRITICAL-7: Port opener purchasing requires SF-4 (Singularity)

The `port_openers.ts` script (and the SNOWBALL strategy's BUY_PROGRAM action) calls `ns.singularity.purchaseProgram()` and `ns.singularity.purchaseTor()`. The Bitburner reference (section 2) explicitly states:

> Requires **Source-File 4 (BitNode-4: The Singularity)** at level 1.

Without SF-4, these calls will return `false` or throw an error. The port_openers.ts code:

```typescript
// Line 55-63
if (ns.getPlayer().money >= cost) {
    let success = false;
    if (opener === 'tor') {
        success = await executeCommand(ns, 'ns.singularity.purchaseTor()');
    } else {
        success = await executeCommand(ns, `ns.singularity.purchaseProgram("${opener}")`);
    }
}
// NOTE: remaining.push(opener) happens OUTSIDE the if, so even successful
// purchases are re-added to the "remaining" list (bug in port_openers.ts)
```

But the result `success` is **never checked**. The opener is pushed to `remaining` regardless. On the next iteration of `buyPortOpeners`, `ns.fileExists(opener)` is checked, and if the purchase failed (no SF-4), fileExists returns false, and it tries again in an infinite loop.

**Impact:** **Without SF-4, port openers can never be bought programmatically.** The agent loops forever in SNOWBALL, never buying openers, never leaving the phase. The only fallback in the plan is "Claude reads decisions.txt and uses DOM terminal injection" — but this is not autonomous and violates the "zero human intervention" goal.

**What should happen:** The strategy must (a) detect whether SF-4 is available (`ns.getOwnedSourceFiles()` requires SF-4 itself — chicken-and-egg), or (b) use a try-catch approach with ns.run() to create programs manually (which takes 10+ minutes each), or (c) inject DOM terminal commands to type `buy BruteSSH.exe` directly. None of these are implemented.

### HIGH-8: simple_hack.ts does not exist

The SNOWBALL strategy calls for `/contracts/simple_hack.js`:

```typescript
actions.push({ type: 'RUN', script: '/contracts/simple_hack.js', args: [s.bestTarget] });
```

The plan says "Write a new ~50-line simple_hack.ts" (section 4.10, Q1). It does not currently exist in the repo.

**Impact:** `ns.run()` returns 0 (failure), but the strategy doesn't check return values. The action silently fails.

### HIGH-9: No deploy scripts exist for the DEPLOY action

The strategy calls `DEPLOY` actions to "Copy hack/grow/weaken to target host." The deploy scripts (`src/deploy/hack.ts`, `grow.ts`, `weaken.ts`) exist, but the strategy's DEPLOY action is a stub in `executeActions`:

```typescript
case 'DEPLOY':
    // Copy hack/grow/weaken to target host
    break;  // <--- EMPTY
```

**Impact:** The DEPLOY action literally does nothing. The comment says what should happen but no code is written.

### MEDIUM-10: Silent idling when bestTarget is null

If no servers are hackable (`s.bestTarget === null`), the strategy falls through to the deploy loop (which does nothing, per F-9) and returns. No log, no fallback. If the player's hacking level is too low to hack any rooted server, the agent enters a do-nothing state until the player levels up by other means.

**What should happen:** When bestTarget is null, the strategy should fall back to other income sources: crimes (via simple_through_file), Hacknet nodes, or manual training.

---

## 3. EXPANSION Strategy

### HIGH-11: Premature phase exit leaves unrooted servers forever

The condition to transition from EXPANSION to PREPARATION is `s.unrootedNukable > 0` being false. If the agent has 3 port openers and all remaining unrooted servers need 4-5 ports, `unrootedNukable = 0`. The agent transitions to PREPARATION, then BATCH. Neither PREPARATION nor BATCH buys port openers or nukes servers (beyond batch_hack's periodic nukeAll, which would fail for the same reason).

**Impact:** Servers requiring 4-5 ports remain unrooted forever once the agent leaves EXPANSION. The agent never returns to EXPANSION because phase transitions are one-directional per the detectPhase algorithm.

**What should happen:** Either (a) the EXPANSION phase returning to unrootedNukable = 0 should also check whether new port openers could be bought, or (b) all later phases should include a "buy port openers + nuke" fallback, or (c) the phase detector should check if purchased-but-unowned openers exist and fall back to SNOWBALL/EXPANSION.

### MEDIUM-12: scan_nuke runs every cycle with no cooldown

Same as F-4 in BOOTSTRAP, but now the strategy explicitly calls:
```typescript
actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home' });
```
Every cycle (~1s). scan_nuke is a BFS that visits every server on the network — this is an O(n) scan with ns.* calls per server, called wastefully.

**What should happen:** Wrap in a `lastNukeTime` check (same pattern as batch_hack.ts does with its own nukeAll at 60s intervals).

---

## 4. PREPARATION Strategy

### HIGH-13: GROW_RAM_COST and MAX_PREP_TARGETS are undefined constants

The strategy pseudocode uses:
- `GROW_RAM_COST` — undefined, will throw ReferenceError
- `MAX_PREP_TARGETS` — undefined, typically shown as 4 in the comment but never declared

**Impact:** StrategyPreparation function cannot compile as written.

### HIGH-14: Massive over-deployment of auto_grow

The strategy distributes auto_grow to **every rooted server** for **every unprepared target**:

```typescript
for (const target of targetsToPrep) {
    for (const host of s.rootedServers) {
        const threads = Math.floor(s.serverFreeRam[host] / GROW_RAM_COST / 2);
        if (threads > 0) {
            actions.push({ type: 'EXEC', ..., threads, args: [target] });
        }
    }
}
```

If there are 4 unprepared targets and 25 rooted servers, this launches 100 `auto_grow` processes simultaneously — many on the same target. auto_grow.js runs a while(true) loop calling ns.weaken()/ns.grow() until prepared. Multiple instances on the same target will:
1. Over-weaken/grow past the target thresholds
2. Security fluctuates unpredictably
3. Many threads are wasted because one instance could do the job alone

**Impact:** RAM wasted, security overshoots, preparation takes longer due to contention.

**What should happen:** Run one auto_grow per target, on the single best server, with as many threads as available. Not N*M processes.

### MEDIUM-15: Silent skip when no RAM for any auto_grow thread

If every server's free RAM is below `GROW_RAM_COST`, every thread calculation yields 0, and the method returns an empty actions array. No log, no fallback, no transition back to a different strategy.

**What should happen:** Log a warning and either (a) wait for RAM to free up, or (b) fall back to SNOWBALL/EXPANSION-style simple hacking.

---

## 5. BATCH Strategy

### CRITICAL-16: batch_hack.ts does not parse CLI args (--homeRam ignored)

The plan's BATCH strategy launches batch_hack.js with:
```typescript
actions.push({ type: 'RUN', script: '/contracts/batch_hack.js',
    args: ['--homeRam', s.homeMaxRam * 0.25] });
```

But `batch_hack.ts` never calls `ns.flags()` or reads `ns.args`. The `HackingConfig` class hardcodes:
```typescript
readonly ramConfig = {
    minHomeReserve: 100,       // fixed 100 GB reserve
    homeRamReservePercent: 0.25,
    maxHomeReserve: 128,
};
```

And `start_hack.ts` (the current launcher) passes `--homeRam` the same way — also ignored by batch_hack.ts.

**Impact:** The `--homeRam` arg is completely decorative. The actual home RAM reservation is calculated from hardcoded config: `Math.max(Math.min(homeMaxRam * 0.25, 128), 100)` = 100 GB minimum. On a home with 8 GB RAM (fresh start), this reservation exceeds total RAM. `getAvailableServers` with `homeRamReserve=100` will exclude home entirely (since `maxRam - usedRam - 100 < minServerRam`).

**What should happen:** Either (a) make batch_hack.ts parse CLI args, or (b) make HackingConfig dynamically set minHomeReserve based on actual home RAM (e.g., `minHomeReserve = Math.min(100, homeMaxRam * 0.5)`). Currently, home RAM is always over-reserved for fresh starts.

### HIGH-17: No RAM check before launching batch_hack.js

The strategy calls `ns.run('/contracts/batch_hack.js', ...)` but never checks whether there is enough free RAM to run it. batch_hack.js imports: RamManager, ServerTargetManager, ThreadDistributionManager, BatchHackManager, HackingConfig, FormulaHelper, Allocator, execMulti, and 4 functions from batch_util. Its RAM cost is likely 10-20+ GB.

If `ns.run()` returns 0 (not enough RAM), the strategy doesn't detect the failure. `s.isBatchHackRunning` stays false, and the strategy tries again next cycle — crash loop.

**What should happen:** Check `ns.getScriptRam('/contracts/batch_hack.js')` against available free RAM before calling `ns.run()`. If insufficient, fall back to simpler strategies (PREPARATION, SNOWBALL).

### MEDIUM-18: Crash loop vulnerability

If batch_hack.js throws an uncaught exception (e.g., from a failed ns.* call, network issue, config error), it dies. The next cycle detects `s.isBatchHackRunning === false` and launches it again. If it crashes again, the agent is in a tight crash loop (launch → crash → check → launch → crash) with no backoff or cooldown.

**What should happen:** Add a `lastBatchCrashTime` tracker. If batch_hack dies within 30 seconds of launch, wait 60 seconds before retrying. Log the crash.

---

## 6. Missing Strategies (Game State Coverage Gaps)

### CRITICAL-19: No endgame strategy exists

The plan lists "Endgame" as a phase but provides **no strategy function** for it. The phase detector never targets it (all conditions lead to BATCH). Once BATCH is running:
- No augmentation purchase
- No faction work
- No company work
- No BitNode destruction (`b1tflum3()` or `installAugmentations()`)
- No progress toward Source-Files

**Impact:** The agent plateaus at batch hacking forever. It never "wins" a BitNode.

### HIGH-20: No home RAM upgrade strategy

batch_hack.ts (line 191) calls `upgradeHomeServer` periodically, but the Wave 4 strategy engine has no equivalent. The plan mentions home RAM costs (section 4.5: "First upgrade (8->16 GB): $256,000") but the strategy never buys upgrades. If the strategy agent replaces batch_hack (as section 4.7 plans), home RAM upgrades cease entirely.

### MEDIUM-21: Stock market code exists but is never activated

The plan's community research table (section 4.9) says: "Our stock module is complete but untested in live play." The strategy engine has no stock market strategy, even when income is high enough to buy a WSE account ($200M) and 4S Market Data ($1B/$25B).

### MEDIUM-22: No coding contract automation

We have 12 contract solver types, but no strategy routine for scanning for coding contracts and solving them. These can provide millions in early game.

### LOW-23: No Hacknet node strategy

The plan mentions Hacknet nodes in the API reference but no strategy builds them. They're a non-negligible income source in early game.

### LOW-24: No crime strategy

Simple crimes (shoplifting, mugging) can provide early-game capital when hacking is not yet viable. The `src/contracts/crime.ts` file exists but the strategy engine never uses it.

---

## 7. Decision Logging (Section 4.6)

### HIGH-25: Log format records intent only, not outcome

The log format:
```json
{"tick": 1, "phase": "BOOTSTRAP", "decision": "Relay deployed to foodnstuff", "ts": 12345}
```

This records what the agent DECIDED to do, not whether it SUCCEEDED. When combined with the strategy's lack of return-value checking (many actions silently fail), the log will say "Relay deployed to foodnstuff" even when:
- boot2.js didn't exist (ns.exec returned 0)
- SCP failed
- boot2.js crashed on start

**Impact:** Claude reads the decision log and sees a successful bootstrap. There's no way to detect silent failures.

### HIGH-26: No state snapshot in log entries

Each log entry is an isolated JSON object. To understand WHY a decision was made, you'd need the GameState at that moment. Without it, debugging requires matching tick numbers against a separate state timeline (which isn't recorded either).

**Missing fields per entry:**
- `money` — current money (critical for "Bought X" decisions)
- `rootedCount` — number of rooted servers
- `unrootedNukable` — remaining rootable servers
- `hackingLevel` — player level
- `totalRamPool` — available RAM for workers
- `incomeRate` — $/s metric

### MEDIUM-27: No phase transition markers

The log shows tick N with phase "SNOWBALL" and tick N+1 with phase "EXPANSION", but there's no explicit "Transitioning: SNOWBALL → EXPANSION because..." entry. A human (or Claude) reading the log has to infer the transition from the phase field changing. The REASON for the transition is lost.

### MEDIUM-28: No error/exception logging

If a strategy function throws, the `executeActions` catch block catches it, but the plan has no mechanism to log errors to the decision log. Silent failures leave no trace.

### LOW-29: No duration or performance tracking

No metrics like:
- Cycle execution time (planned 1s, actual ?)
- Actions executed per cycle
- Failed actions per cycle
- Money earned since last cycle

Without these, Claude cannot determine if the strategy is performing well or stuck.

### LOW-30: Tick number is fragile as a sequence identifier

If the agent is restarted, tick resets to 0. If two agents run simultaneously (shouldn't happen, but possible during transition), tick collisions occur. Use a monotonic timestamp or UUID-like counter instead.

---

## Cross-Cutting Issues

### DESIGN-31: Phase transitions are one-directional

The `detectPhase` function is called every cycle and returns the current phase. But once the agent transitions from SNOWBALL → EXPANSION → PREPARATION → BATCH, it can never go back. If BATCH fails (not enough RAM), it stays in BATCH and keeps failing. There's no "regression" path.

**Example scenario:**
1. Agent reaches BATCH, launches batch_hack.js
2. batch_hack.js crashes (or is killed by the player)
3. `s.isBatchHackRunning` = false
4. Strategy launches it again → crashes again → infinite loop
5. Never returns to PREPARATION or SNOWBALL even if they'd work better

### DESIGN-32: GameState snapshot costs are underestimated

Section 4.5 estimates snapshot RAM at ~0.85 GB, but:
- `getServer(host)` at 0.3 GB × N rooted servers (not "one call total")
- The GameState interface requires per-server free RAM (`serverFreeRam`), which requires calling `getServer()` on EACH rooted server, not once globally
- `rootedServers` and `unrootedServers` require `scan()` + `hasRootAccess()` per server

If there are 20 rooted servers, that's 20 × 0.3 GB = 6 GB just for `getServer()`, not 0.3 GB. The 0.85 GB estimate appears to assume `getServer()` is called once globally, but it returns data for one host.

### DESIGN-33: AgentAPI is specified but AgentAPI semantics are incomplete

The `AgentAPI` interface:
```typescript
interface AgentAPI {
  run(script, threads?, ...args): number;
  exec(script, host, threads?, ...args): number;
  ...
}
```

The return value `number` is a PID (or 0 on failure), but no strategy function checks the return value. All strategies fire-and-forget. Combined with F-25 (no outcome logging), failures are invisible.

---

## Recommendations (Prioritized)

| Priority | Fix For | Action |
|---|---|---|
| **P0** | F-6 (SNOWBALL deadlock) | Add scan_nuke to SNOWBALL strategy, or change phase condition to allow transition when all nukable servers are rooted |
| **P0** | F-7 (SF-4 requirement) | Implement DOM terminal injection for `buy` commands, or implement manual program creation via `ns.run` + createProgram |
| **P0** | F-16 (--homeRam ignored) | Fix HackingConfig to use actual home RAM for reserve calculation; add ns.flags() to batch_hack.ts or remove the decorative arg |
| **P1** | F-13 (undefined constants) | Define GROW_RAM_COST, MAX_PREP_TARGETS, BOOT2_RAM_COST before building strategy code |
| **P1** | F-1/F-8/F-9 (missing files) | Ensure boot2.ts, simple_hack.ts, and DEPLOY action code exist before the strategy references them |
| **P1** | F-14 (auto_grow over-deployment) | Limit to one auto_grow instance per target on the best available server |
| **P1** | F-19 (no endgame) | Add at minimum a stub strategy for Endgame phase, even if it just logs "not implemented" |
| **P2** | F-3 (dependency resolution) | Use execMulti pattern for SCP operations or bundle to single file |
| **P2** | F-25/F-26 (logging) | Enrich decision log with state snapshot + outcome per action |
| **P2** | F-31 (phase regression) | Add regression path: if BATCH fails N times, drop to PREPARATION |
| **P3** | F-4/F-12 (no cooldown) | Add cooldown timers to scan_nuke calls |
| **P3** | F-17 (RAM check before launch) | Check available RAM vs script cost before ns.run() |
