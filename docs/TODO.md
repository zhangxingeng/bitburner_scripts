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

## 3. `src/player/corp_manager.ts` — DONE (2026-07-02), v1 scope, needs live verification

Built via a git-worktree parallel session alongside 5 other items (see item 8). v1 is
deliberately narrow: one corporation, one Agriculture division, Sector-12 only, initial
office/warehouse size, round-robin hiring (no `setJobAssignment`), no product-design loop.
Founding is gated behind a single `corpInvest`/`corpFound` decision (~$324b total). Explicitly
deferred to a v2 pass: office/warehouse upgrades, AdVert, research, a second division/city,
investor/IPO mechanics.

**Known risk, not a bug:** this daemon's static RAM cost is unusually large (~220-230 GB,
summing every distinct `ns.corporation.*` function it touches) — inherent to the corp API
surface, not a regression. A save can't even afford to found a corp without ~$324b liquid,
which implies enormous home RAM already exists from compute-layer reinvestment by that point,
but don't chase this as a bug if a future debugging session notices it.

## 4. `docs/mcp/plan-mcp-reliability.md` Problem 3 — DONE (audited 2026-07-02, not a bug)

`contract_solver.ts`'s 22 GB has zero unnecessary imports — it's the intrinsic, unavoidable
cost of the three `ns.codingcontract.*` calls (`getContractType`+`getData`+`attempt`) any
solver must make, verified against `bitburner-src`'s RAM cost tables. The doc's original
diagnosis (assumed heavy/unused imports) was wrong; corrected in place. No code change needed
or possible here — this is a sequencing constraint (needs ~16GB+ free home RAM to run), not a
defect. The doc's Fix Option 2 (a RAM-gate before launching contract_solver) is still a
reasonable, not-yet-built follow-up if contract-solving needs to work on very small saves.

## 5. `docs/design/14-roadmap-to-full-autoplay.md` gaps — mostly closed 2026-07-02

- ~~Reset loop~~ — DONE (a prior session); still needs a live end-to-end smoke test (approve → confirm actual reset+reboot fires).
- ~~BitNode selection~~ — DONE (2026-07-02), `player/bitnode_selector.ts`, "suggest + approve" mode. Also fixed: `w0r1d_d43m0n` has no network-topology entry so the BFS nuke sweep never reached it — now roots it by hostname directly. Needs live verification once a BitNode is actually beatable.
- ~~Action-level navigation (`act()` layer, `docs/design/12`)~~ — **re-audited, not needed.** Every action that would have used it (company work, aug donation, grafting travel) has a plain `ns.singularity.*` equivalent via the existing `ns_dodge` idiom. `docs/design/12` marked NOT NEEDED; do not build it without a genuinely new DOM-only use case.
- ~~Crime not wired~~ — DONE (2026-07-02), refactored to the manager idiom + registered under `autoCrime`. Also fixed a real bug found along the way: training silently no-op'd outside Sector-12.
- ~~Company work missing~~ — DONE (2026-07-02), folded into `faction_manager.ts`'s existing work-target loop (not a separate daemon — would race for the single current-work slot).
- Grafting manager — still open: has a decision-kind (item 1) but doesn't auto-travel to New Tokyo yet (reports "[not in New Tokyo]" rather than fixing it). Small follow-up, same `ns_dodge` idiom as everything else.
- ~~Aug pricing ignores SF11 / no donation path~~ — DONE (2026-07-02). Needs live verification (donation candidate surfacing + the `--donate` CLI mode).
- ~~Bladeburner Black Ops not surfaced~~ — done a prior session.
- ~~`stock/main.ts` sell-signal tracking~~ — DONE (2026-07-02). Also fixed a real dead-code bug: `purchasePrice`/`isShort` were never set, so the entire trailing-stop/profit-target exit ladder had never fired in live play. **This is a real trading-behavior change, not yet observed live — watch for it.**
- Script-audit pass (`docs/design/13`'s matrix) not yet fully executed (Round 1E) — still open.
- Console "offline" indicator not built (Round 1F) — still open.
- `docs/design/12` §8's five open sub-questions — moot, that doc is no longer being built.

## 6. Smaller `TODO(design)` markers (feature gaps, not urgent, not residue)

- `compute/hacknet_manager.ts` — wire `MAX_PAYOFF_TIME`/aggressiveness to phase boundaries.
- `compute/pserv_manager.ts` — full time-decay reserve-by-time model.
- `compute/scheduler.ts` — integrate the `PORT_BUS_TASK` protocol; adopt alainbryden bin-packing.
- `compute/coordinator.ts` — phase-aware compute-strategy switch; `PORT_BUS_TASK` publishing;
  home-reservation doubling on frequent violation; **stock↔hack coupling** (read `PORT_STOCK`,
  bias grow/hack toward positions) — the data this would consume is now real (item 5 above
  fixed `profitChange`), but the coordinator-side consumption itself is still unbuilt.
- `compute/target_selector.ts` — per-thread-efficiency ranking for EARLY phase.
- `compute/hwgw_batcher.ts` — adopt inigo/alainbryden scheduling patterns; recovery weaken padding
  (`maxTargets` auto-scale may now be partially superseded by the pressure-shrink hook already built).
- `cross/reporter.ts` — replace file-dump status snapshots with the React dashboard (control console
  already exists per `docs/design/08-control-console.md`; this is about extending it to consume live
  data via DOM injection into `#overview-extra-hook-0`, not building it from scratch).

## 7. Known but low-priority — `lib/connect.ts`'s Wave-0 plan item is obsolete, not missing

An earlier plan called for routing `lib/connect.ts`'s Singularity calls through `ns_dodge`. That
approach was superseded by a better fix already shipped: `checkOwnSF`/`hasSF4` (now in
`lib/sf_check.ts`) gate the calls directly, documented in `docs/ram_evasion_rules.md` §6. No action
needed — noted here only so the old plan item isn't mistaken for outstanding work.

## 8. Live verification of everything built 2026-07-02 — DONE, found and fixed 2 real bugs

All six items were launched live against the running game (not just typechecked). Two genuine
bugs surfaced — exactly the class of thing `tsc` cannot catch — both fixed and committed:

- **stock sell-signal**: the resurrected `checkPositionManagement` trailing-stop check ran
  unconditionally (unlike every sibling check), so it tripped from the bid/ask spread alone
  0 ticks after a fresh buy — observed live as a real buy/sell/loss thrash on APHE. Fixed by
  gating it behind `shouldConsiderSelling` like every other exit condition. Re-verified live:
  clean profit-taking and sensible stop-losses after a proper restart, no more instant-thrash.
- **bitnode-selector**: `ns.getServer('w0r1d_d43m0n')` throws unconditionally until the player
  has installed "The Red Pill" (confirmed in bitburner-src — pre-TRP the World Daemon is an
  "isolated non-dnet server", not just unreachable via scan as originally assumed). This
  crashed the whole detection snapshot every tick. Fixed by gating the entire World Daemon
  probe behind `resetInfo.ownedAugs.has('The Red Pill')` (already fetched via `getResetInfo`,
  zero extra cost). Re-verified live: clean "not yet beatable" status, no crash.
- **crime**: confirmed live — ticks, trains, and shows correct 100% crime chances across the
  ladder (this dev save has very high stats).
- **corp**: confirmed live — correctly self-guards as `available:false` pending SF3/BN3, no
  crash. The actual founding sequence (`corpFound` decision → bootstrap) was NOT exercised —
  this dev save's money dropped to ~$14B (partly from the stock-thrash bug above, since fixed)
  and corp needs ~$324B to bootstrap. Re-verify the founding flow once funds recover or SF3 is
  granted with enough money.
- **company-work**: confirmed live — `faction_manager.ts` runs without crashing. The actual
  company-work-target code path was NOT exercised (no currently-joined faction has an
  unsatisfied company-rep gate in this save, and the script's `ns.print`-only logging isn't
  readable through the tools available this session) — reasonably low-risk since it's
  additive, data-driven logic gated the same way as the rest of this file.
- **aug-donation**: confirmed live — `aug_planner.js` ran clean, correctly found zero donation
  candidates because `Formulas.exe` is absent in this save (verified directly) — this is
  correct behavior per the code's own guard, not a gap in testing. The actual donation
  surfacing/`--donate` CLI path was NOT exercised — needs Formulas.exe to test meaningfully.
