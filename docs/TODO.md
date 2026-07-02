# Outstanding Work — the single gathered list

> Consolidates every incomplete/deferred item found across a full code + docs audit
> (2026-07-01). Previously these lived scattered across `TODO(design)`/`TODO(decision)`
> comments, `docs/design/14`'s gap list, and a couple of standalone plan docs. This is
> now the one place to check "what's left" — update it as items land or new ones surface,
> don't let a second copy grow elsewhere.
>
> Each item names its concrete file(s). If a file/line has moved, grep the function or
> comment text below rather than trusting the line number.

---

## 1. Decision-wiring — 5 subsystems — DONE (2026-07-01), needs live verification

`src/lib/decisions.ts`'s `upsertPending`/`drainReplies` approve/deny/defer mechanism is now wired
into all five subsystems, built in parallel via git-worktree subagents and merged into `main`
(`npx tsc --noEmit` clean on the combined tree):

| File | What was wired | `DecisionKind` |
|---|---|---|
| `src/player/gang_manager.ts` | Territory warfare enable/disable gated on `getChanceToWinClash` vs every active rival (hysteresis band, deny/defer cooldowns); disengage stays ungated (always safe) | `gangWarfare` |
| `src/player/bladeburner_manager.ts` | Black Ops approval integrated into the existing `needSwitch`/`currentTaskEndTime` scheduling; deny requires rank to grow by a delta, defer is a tick cooldown | `bladeOp` |
| `src/player/grafting_manager.ts` | Auto-graft-cheapest-aug, gated on New Tokyo + affordability + not already grafting; `focus:false` so it doesn't hijack the UI | `graft` |
| `src/player/sleeve_manager.ts` | Per-(sleeve, aug) purchase decisions via `getSleevePurchasableAugs`/`purchaseSleeveAug`, independent of the existing task-assignment ladder | `sleeveSpend` |
| `src/player/stanek_manager.ts` | Minimal MVP: brute-force first-fit scan for one non-booster fragment at a time, surfaced as a placement decision | new kind `stanekPlacement` added to `lib/decisions.ts` |

**Live-verified 2026-07-02**, and a real bug was found and fixed in the process:
`lib/decisions.ts::drainReplies()` did a destructive pop-until-empty of the single shared
`PORT_DECISION_REPLY` port. That was fine when `player_sequencer` (the `augReset` decision) was
its only caller, but once all five subsystem managers above started calling it too, whichever
daemon polled the port first would consume — and silently discard — replies addressed to a
different manager. Caught live: an approved Stanek fragment placement vanished (port drained,
pending entry never cleared, fragment never placed) because another manager's `drainReplies()`
call won the race that tick.

Fix: `drainReplies(ns, matches)` now takes a predicate; each of the 6 call sites (five managers
above + `player_sequencer.ts`) scopes it to their own decision-id namespace, and non-matching
replies are pushed back onto the port instead of being dropped. Re-verified live: the exact
previously-lost Stanek approval was replayed and correctly applied with all 5 managers running
concurrently.

## 2. Wave 2 leftovers from the priority/exec_guard refactor — DONE (2026-07-01)

All remaining `execMulti`/`ns.run` call sites now route through `lib/exec_guard.ts::requestRun`,
tagged with the correct `Priority` tier. Merged into `main`, `npx tsc --noEmit` clean:

- `src/compute/hwgw_batcher.ts` (`executeOperation`, now async) and `src/compute/coordinator.ts`
  (`prepareServers`/`shareRemainingRam`, now async) → `Priority.COMPUTE_WORKER`.
- `src/cross/player_sequencer.ts`'s five sites (`tickManagers`'s generic manager launch, both
  `aug_planner --install` sites, `faction_manager`, `program_acquirer`) → `Priority.ESSENTIAL`.

No business logic or thresholds changed — pure launch-primitive swap. Not live-tested (see caveat
in §1) but preemption already worked before this via the direct pressure-polling path, so this is
confirmed-safe consistency cleanup, not a behavior change.

## 3. `src/player/corp_manager.ts` — still a deliberate stub

25 lines, publishes `{available: false, headline: 'Corp — automation deferred'}` on a timer and does
nothing else. No corporation API calls at all. Full corp automation is a from-scratch build, not a
partial fix — flagged repeatedly as too large/risky to attempt without live testing time.

## 4. `docs/mcp/plan-mcp-reliability.md` Problem 3 — player-module RAM audit (still open)

Run `calculate_ram` against every `src/player/*.js`. `contract_solver` reportedly costs 22GB and
should only need `ns.codingcontract.*` + a pure-JS BFS/solver — audit its imports for anything
pulling in `ns_dodge`/formulas/the compute stack unnecessarily.

## 5. `docs/design/14-roadmap-to-full-autoplay.md` gaps (still accurate as of this audit)

- Reset loop: `installAugmentations` exists but hasn't been exercised live end-to-end yet.
- BitNode selection: `player/bitnode_selector.ts` not yet built.
- Action-level navigation (`act()` layer per `docs/design/12`) — undesigned into code, Round 2.
- Crime not wired into `DAEMON_CATALOG`/sequencer (Round 1D).
- Company work missing — blocks progress with 8+ factions that require it (Round 3A gap #4).
- Grafting manager is report-only (gap #7 — see item 1 above, now has a concrete decision-kind).
- Aug pricing ignores SF11 cost-reduction and has no donation-based purchase path (gap #8).
- Bladeburner Black Ops not surfaced (gap #6 — see item 1 above).
- `stock/main.ts`: `purchaseProfitPotential`/`profitChange` tracking not implemented (sell-signal gap).
- Script-audit pass (`docs/design/13`'s matrix) not yet fully executed (Round 1E).
- Console "offline" indicator not built (Round 1F).
- `docs/design/12` §8's five open sub-questions (travel-confirm dialog, apply-for-job `isTrusted`
  audit, MUI Select fiber manipulation, multi-step nav render-stabilization, port-based SF4
  feedback) — block Round 2 detail work, currently only captured as questions.

## 6. Smaller `TODO(design)` markers (feature gaps, not urgent, not residue)

- `compute/hacknet_manager.ts` — wire `MAX_PAYOFF_TIME`/aggressiveness to phase boundaries.
- `compute/pserv_manager.ts` — full time-decay reserve-by-time model.
- `compute/scheduler.ts` — integrate the `PORT_BUS_TASK` protocol; adopt alainbryden bin-packing.
- `compute/coordinator.ts` — phase-aware compute-strategy switch; `PORT_BUS_TASK` publishing;
  home-reservation doubling on frequent violation.
- `compute/target_selector.ts` — per-thread-efficiency ranking for EARLY phase.
- `compute/hwgw_batcher.ts` — adopt inigo/alainbryden scheduling patterns; recovery weaken padding
  (`maxTargets` auto-scale may now be partially superseded by the pressure-shrink hook already built).
- `cross/reporter.ts` — replace file-dump status snapshots with the React dashboard (control console
  already exists per `docs/design/08-control-console.md`; this is about extending it to consume live
  data via DOM injection into `#overview-extra-hook-0`, not building it from scratch).
- `player/faction_manager.ts` — idle karma-grind fallback when no faction work is available;
  company-work integration (see item 5).
- `player/aug_planner.ts` — SF11 reduction factors; donation-based aug purchases (see item 5).

## 7. Known but low-priority — `lib/connect.ts`'s Wave-0 plan item is obsolete, not missing

An earlier plan called for routing `lib/connect.ts`'s Singularity calls through `ns_dodge`. That
approach was superseded by a better fix already shipped: `checkOwnSF`/`hasSF4` (now in
`lib/sf_check.ts`) gate the calls directly, documented in `docs/ram_evasion_rules.md` §6. No action
needed — noted here only so the old plan item isn't mistaken for outstanding work.
