# Cold Audit Synthesis — Wave 4 Strategy Engine Plan

**Date:** 2026-06-28
**Auditors:** 4 independent adversarial review agents
**Plan audited:** `docs/continuous_improvement.md` Sections 4.1–4.10

---

## Finding Summary

| Severity | Count | Category |
|---|---|---|
| **CRITICAL** — blocks autonomous play | 14 | Deadlocks, no-ops, undefined refs, RAM miscalculation |
| **HIGH** — significant gap | 8 | Missing regression path, ghost files, no endgame |
| **MEDIUM** — implementation issue | 4 | Effort estimate, missing steps, test gaps |

---

## CRITICAL Findings (Must Fix Before Build)

### F1. SNOWBALL Phase Deadlock
**Source:** Architecture audit + Strategy audit

The SNOWBALL strategy never runs `scan_nuke`. Phase exit condition requires `rootedCount >= 5`, but BOOTSTRAP only roots 0-port servers (typically 7–8). The plan says BOOTSTRAP transitions when `rootedCount >= 3`, but SNOWBALL requires `rootedCount >= 5` to exit. The 0-port servers are already rooted by then — and scan_nuke is never called again. **The agent is permanently stuck in SNOWBALL.**

**Fix:** SNOWBALL must run `scan_nuke` periodically. Or change the exit condition to not depend on rootedCount.

### F2. Phase Oscillation (PREPARATION ↔ BATCH)
**Source:** Architecture audit

Every BATCH hack cycle degrades target servers (money drops, security rises). After one cycle, `isServerPrepared()` returns false → phase detector flips back to PREPARATION → auto_grow runs → back to BATCH → oscillates every tick. **Neither phase ever stabilizes.**

**Fix:** Add hysteresis — require N consecutive ticks of "unprepared" before leaving BATCH. Or have BATCH handle its own prep internally (batch_hack.ts already does this).

### F3. Port Openers Require SF-4 (Unobtainable on Fresh Game)
**Source:** Strategy audit + Architecture audit

`ns.singularity.purchaseProgram()` is gated behind Source-File 4 (BitNode-4 completion). On a fresh game (BN-1), this function throws. The `port_openers.ts` script and the `BUY_PROGRAM` action both depend on it. **The agent can never buy port openers programmatically on a fresh game.**

**Fix:** Either use DOM terminal injection (`buy BruteSSH.exe` via the terminal input trick) or accept that manual port opener purchase is required on BN-1.

### F4. RAM Estimate 61–63% Too Low
**Source:** RAM Budget audit + Architecture audit

The plan claims boot_agent = ~3.3 GB. Actual minimum with the listed functions (run, exec, read, write, rm): **5.3 GB** just in function costs, plus ~1.6 GB base = ~6.9 GB. The claim is mathematically impossible with the listed function set.

The plan claims strategy_agent = ~4.5 GB. Actual: ~7.35 GB when all required functions are included.

**Fix:** Either (a) use port I/O instead of file I/O (ports cost 0 GB), saving 3.0 GB, or (b) split the agent into even smaller pieces, or (c) accept higher RAM and always relay to a larger server.

### F5. DEPLOY Action is a No-Op
**Source:** Architecture audit

The DEPLOY case in `executeActions()` has an empty body (`// Copy hack/grow/weaken to target host`). No files are ever copied. **Worker scripts never reach remote servers.**

**Fix:** Implement DEPLOY using `ns.scp()` to copy hack.js, grow.js, weaken.js from home to target.

### F6. BUY_PROGRAM Action is a No-Op
**Source:** Architecture audit

Same as F3 — the handler body does nothing. Even with SF-4, the code path is `break` with no purchase call.

**Fix:** Implement actual purchase logic, or document that this is a logged intent for Claude to execute via terminal injection.

### F7. pid=0 Return Values Never Checked
**Source:** Architecture audit

Every `ns.run()` and `ns.exec()` call ignores the return value. A failed launch (insufficient RAM, missing script, wrong args) produces pid=0 but the agent proceeds as if successful. **Silent failures are indistinguishable from success.**

**Fix:** Check `pid > 0` on every run/exec call. Log failures. Retry or fall back.

### F8. Ghost Files — boot2.js, simple_hack.js Don't Exist
**Source:** Strategy audit

The BOOTSTRAP strategy calls `scp('/monitor/boot2.js', ...)` and the SNOWBALL strategy calls `run('/contracts/simple_hack.js', ...)`. Neither file exists in `src/` or `dist/`. The bootstrap relay cannot complete. The simple hack loop cannot start.

**Fix:** Write these files (S2 in implementation order) BEFORE the strategy engine depends on them.

### F9. Undefined Constants in Pseudocode
**Source:** Strategy audit

`BOOT2_RAM_COST`, `GROW_RAM_COST`, and `MAX_PREP_TARGETS` are used in strategy pseudocode but never declared. Any implementation would fail with ReferenceError.

**Fix:** Define all constants with actual values before implementation.

### F10. Missing GameState Fields
**Source:** Architecture audit

`boot2RunningOn`, `isBatchHackRunning`, `serverFreeRam` (per-server map), and `hasDeployScripts` (per-server map) are referenced in strategy code but not in the GameState interface. They would be `undefined` at runtime.

**Fix:** Add these fields to the GameState interface and populate them in `snapshotGameState()`.

### F11. --homeRam Arg Ignored by batch_hack.ts
**Source:** Strategy audit

The BATCH strategy passes `--homeRam` to batch_hack.js, but `batch_hack.ts` never calls `ns.flags()` to parse it. `HackingConfig` hardcodes `minHomeReserve: 100` — meaning home is excluded from the server pool by default on any server with < 200 GB RAM. On a fresh 8 GB home, this means **home is never used for batching even after relay.**

**Fix:** Either (a) read --homeRam in batch_hack.ts and override config, or (b) lower the default minHomeReserve for early game.

### F12. lib/script.ts Has Active Engine Importers
**Source:** Implementation audit

The plan says to remove `lib/script.ts` because "only midgame_hack.ts uses it." This is FALSE:
- `src/engine/thread_manager.ts:3,445` imports `distributeThreads`
- `src/engine/exec_multi.ts:2,123` imports `ensureScriptExists`

Removing this file breaks the active batch hack engine.

**Fix:** Remove `lib/script.ts` from the cleanup plan. The file stays.

### F13. No SNOWBALL Hack Loop Exists
**Source:** Strategy audit + Implementation audit

The SNOWBALL strategy needs a `simple_hack.js` but the plan identifies this as an open question (4.10, Q1) without resolving it. Without this script, SNOWBALL has no income generation mechanism.

**Fix:** Add `src/deploy/simple_hack_loop.ts` to the implementation order as a prerequisite for S3.

### F14. No Regression Path in Phase Detector
**Source:** Strategy audit

The phase detector is strictly forward: BOOTSTRAP → SNOWBALL → EXPANSION → PREPARATION → BATCH. If BATCH crashes (OOM, config error), there's no path back. If a server gets un-rooted (unlikely but edge case), there's no recovery.

**Fix:** Add regression: any phase can fall back to SNOWBALL (safe default with simple hack loop).

---

## HIGH Findings (Address Before or During Build)

### H1. No Endgame Strategy
**Source:** Strategy audit
The plan only covers through BATCH. No strategy for augmentations, factions, or BitNode reset exists. This is acceptable for a first build (we're not at endgame yet), but the phase detector should recognize "all done" and not loop forever.

### H2. auto_grow Over-Deployment
**Source:** Strategy audit
The PREPARATION strategy launches auto_grow on N targets × M servers = N×M processes. With 4 targets and 8 servers, that's 32 auto_grow processes — each using RAM. Should be capped.

### H3. Decision Log Records Intent Only
**Source:** Strategy audit
The log records what the agent decided to do, but not what actually happened (pid, result, error). Debugging requires both.

### H4. No RAM Check Before Launching batch_hack
**Source:** Strategy audit
BATCH launches batch_hack.js without checking if enough RAM is available. On a constrained system, this launch silently fails.

### H5. No Recovery If Strategy Agent on foodnstuff is Killed
**Source:** RAM audit
If the relay server's strategy agent dies (script killed, server nuked), there's no watchdog to restart it. The system goes silent.

### H6. Boot Chain Source Files Missing from Repo
**Source:** Implementation audit (verified)
`boot.js`, `boot2.js`, and `relay.js` exist on game servers but not in `src/` or `dist/`. Step S2 adds them, but the implementation order has them at S2 (after S1 cleanup). If S1 removes files first, there's a gap where nothing works.

### H7. Get-Context Procedure Not Followed
**Source:** Manager template
The plan was written without running get-context against every file it touches. This is how the F12 (lib/script.ts importers) and F11 (batch_hack not reading --homeRam) errors went undetected. The build phase MUST run get-context.

### H8. No Test Plan
**Source:** Implementation audit
Section 4.8 has S6 ("Test: fresh game start") but no test criteria, expected outcomes, or regression tests for earlier steps. Without these, verification is ad-hoc.

---

## MEDIUM Findings (Address During Build)

### M1. Effort Estimate Too Low
**Source:** Implementation audit
Plan says 10–12h. After adding the missing steps (simple_hack.ts, lib/script.ts migration, config wiring), realistic estimate is 13–16h.

### M2. P1 (File Sync) and P2 (getAllFiles MCP) Could Be Parallel
**Source:** Implementation audit
P1 modifies `build/game-bridge.ts`. P2 modifies `build/game-bridge-mcp/src/index.ts`. Different files, different concerns. Can be parallelized.

### M3. S1 (Cleanup) and S2 (Boot Source) Could Be Parallel
**Source:** Implementation audit
S1 removes files. S2 adds files. No dependency between them except midgame_hack removal before strategy build.

### M4. server_manager.ts Thresholds Are Functional Duplicates
**Source:** Implementation audit
`server_manager.ts:84-85` has hardcoded `moneyThreshold: 0.9, securityThreshold: 3`. `HackingConfig` has `targetingConfig.moneyThreshold: 0.9, targetingConfig.securityThreshold: 3`. Same values, different locations. They don't share a source of truth. Fix: pass config values to ServerTargetManager constructor.

---

## Correct Claims (Verified)

The following plan claims were verified as correct by the audits:

- Architecture direction (strategy functions in agent) is sound ✅
- Phase order (BOOTSTRAP → SNOWBALL → EXPANSION → PREPARATION → BATCH) is correct ✅
- `ns.getServer()` optimization saves 0.25 GB ✅
- Port openers cost 0 GB RAM ✅
- `status_reporter.ts` has zero importers, safe to remove ✅
- `midgame_hack.ts` has zero importers, safe to remove ✅
- `start_hack.ts` has zero importers, safe to remove ✅
- `lib/server.ts` calculateServerValue missing growth factor ✅
- `server_manager.ts` hardcoded thresholds confirmed ✅
- All individual ns.* function RAM costs verified correct ✅
- Two-tier architecture (boot + strategy) is the right approach ✅
- foodnstuff (16 GB) is the correct relay target ✅
- n00dles (4 GB) cannot host the strategy agent ✅

---

## Next Steps

1. Fix all 14 CRITICAL findings in the plan
2. Address 8 HIGH findings
3. Restructure into individual actionable plan files under `.claude/work/plans/`
4. Run get-context on every file before building
