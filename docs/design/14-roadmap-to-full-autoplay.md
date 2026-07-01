# Design 14 — Roadmap to Full Autoplay

**Status:** RATIFIED 2026-06-30. The actionable spine. This doc sequences everything else.

**Companions:** [[12-navigation-interaction-layer]] (the act() layer), [[13-test-harness-and-script-audit]] (how we prove it runs), [[05-thread-p-sequencing]] (the brain), [[11-subsystem-autonomy-and-console-v2]] (managers + console), [[10-parallel-build-playbook]] (how we build concurrently).

---

## §0 The goal, and what "done" means

**One human input to start; everything after is autonomous where trusted, surfaced where it's a judgment call.**

"Full autoplay" = the brain can take a fresh BitNode from nothing to its end and into the next one, unattended:

> root + earn (compute) → join factions + grind rep → buy & **install augs (reset)** → repeat the prestige loop → when a BitNode is beatable, **beat it and pick the next** → run SF-gated subsystems (gang/corp/bladeburner/sleeve/stanek) as they unlock → only ping the human for genuine judgment calls (BitNode choice, scarce/irreversible spends) unless those are toggled to full-auto.

We are NOT there. We have a strong skeleton and most of the limbs, but **the prestige loop does not close** and the brain cannot perform **in-page actions**. This roadmap is the path from here to there.

---

## §1 Where we are (grounded snapshot, audit 2026-06-30)

**Solid (WORKS, validated):** the compute layer (HWGW coordinator/batcher/scheduler/allocator, pserv, hacknet), the stock trader, the bootstrap + phase detector, `game_agent` control channel, the Thread-P sequencer skeleton with a crash-guarded `PLAYER_MANAGERS` registry walk, the console v2 (Systems/Charts/Audit panels), and the side-system managers (gang, bladeburner, sleeve, stanek). Page-level nav (`lib/navigator.ts`) is built and zero-RAM.

**Fixed this session (were silent runtime crashes — `tsc` passed, code died):**
- `ns.formatNumber` → `ns.format.number` (removed in 3.0.0). [[runtime-safety-vs-typecheck]]
- Purchased-server APIs → `ns.cloud.*` (removed in 3.0.0) — 14 call sites across the **compute hot paths**. This is a major "scripts don't run" cause, now closed (commit `58e135a`).
- `dev/cheat.js` redesigned **surgical** (no-op unless a knob is named; blanket grants mask bugs).

**The honest gaps (why it can't yet play the whole game):**
1. **The reset loop never closes** — `ns.singularity.installAugmentations(...)` is called *nowhere*. We buy augs and never install them. (audit gap #1) — **still open.**
2. ~~**Terminal injection silently fails off the Terminal page**~~ — **CLOSED 2026-07-01.** `game_agent.ts`'s three terminal-injection call sites (control-channel `handleControlCmd`, the file-relay `executeCommand`, and the legacy `processLauncherCommands`) now all call `runTerminalCommandEnsured` (`cross/launcher.ts`), which calls `ensureTerminal()` (`lib/navigator.ts`) and polls for the Terminal page to become active before injecting — previously only the file-relay path attempted this, and even `launcher.ts`'s own `runTerminalCommand` primitive only *signaled* the caller to retry rather than actually waiting. See [[15-ram-evasion-rules]]'s sibling doc note and Round 1 track 1C below.
3. **No action-level navigation** — the brain can switch sidebar pages but cannot click in-page controls (travel, apply-for-job, buy-aug, donate, assign-sleeve). → [[12-navigation-interaction-layer]] — **still open.**
4. **Crime never fires** — `crime.ts` works but isn't in the registry; karma grind (gates Daedalus, etc.) never happens. (gap #2) — **still open.**
5. **Company work missing** — megacorp faction invites never arrive → 8+ factions and their exclusive augs are unreachable. (gap #4) — **still open.**
6. **BitNode selection missing** — after a reset the brain would stall at the BitVerse. (gap #5) — **still open.**
7. Smaller: grafting is report-only (gap #7), aug pricing ignores SF11 + can't donate (gap #8), bladeburner Black Ops aren't surfaced (gap #6), `contract_solver` is 22 GB (gap #9), stock↔hack coupling unbuilt (gap #10). — **all still open.**

---

## §1a Update — 2026-07-01: brain.ts is now the single entry point, plus a priority/RAM-budget layer

A separate, previously-undocumented pivot landed the same day this roadmap was last touched, and
then a follow-up session (this one) finished it and reconciled the docs. Recorded here since this
doc is the canonical "current state" reference:

- **`bootstrap.ts` is deleted.** Its daemon-catalog-walk logic (`launchEligibleDaemons`,
  `currentPhase`/`estimatePhase`, `nukeAndScan`, `pickTarget`, `deployWorkers`) was extracted into
  `lib/daemon_launcher.ts` — a pure, NS-parameterized library, not a competing top-level entry point.
- **`brain.ts` is the single entry point** (`run /brain.js` is the only thing the user types, on a
  fresh game or after a reset). Per tick it: (1) runs BFS/nuke + worker-spray + calls
  `daemon_launcher.launchEligibleDaemons`, (2) pre-SF4 only, mimics human UI actions directly
  (buy TOR, port openers, home RAM, a course) via `player/ui_actions.ts`'s exported functions —
  no separate process, since these are just clicks/keystrokes — and (3) once SF4 is detected, stops
  that branch entirely and defers to `cross/player_sequencer.ts` (already in `DAEMON_CATALOG`) for
  all further purchasing, so there is never more than one purchaser running at once.
  `player/ui_actions.ts --early-loop` was removed from `DAEMON_CATALOG` for this reason (it would
  otherwise race brain.ts's own calls to the same functions).
- **A priority/RAM-budget/preemption layer now sits under all of this** (`lib/config.ts`'s `Priority`
  enum — `BRAIN` > `ESSENTIAL` > `INCOME_ENGINE` > `COMPUTE_WORKER` — `lib/machine_status.ts`'s
  per-machine budget files, and `lib/exec_guard.ts`'s `requestRun`, the shared safe-launch
  primitive). `DAEMON_CATALOG` entries are tagged with priority; `lib/daemon_launcher.ts` launches
  through `requestRun` instead of a bare `ns.exec`; `hwgw_batcher.ts`'s existing
  `reduceActiveBatchLoad` preemption hook now also reacts to a published pressure signal, not just
  its own local RAM-violation check. This closes a real, previously-unnoticed inconsistency: the old
  `bootstrap.ts` daemon launcher never subtracted the home RAM reservation at all, while the compute
  stack (`RamManager`) always had — the two disagreed about how much home RAM was actually free.
- **MCP is explicitly scoped as dev/debug tooling only**, never a runtime dependency of `brain.ts` —
  see `docs/mcp-control-channel-usage.md` §0.
- This does not change §2–§7 below — the reset loop, nav/action layer, crime, company work, and
  BitNode selection gaps are orthogonal to this pivot and remain exactly as described. Round 1's
  scope (§4) is unaffected except where noted inline (tracks 1C and 1G, below).

---

## §2 The critical path

Most of the top-10 are leaves. **The spine — the few things that turn a pile of managers into a self-perpetuating player — is small:**

```
   [Make-it-run]            [Close-the-loop]              [Act-in-UI]
  ensureTerminal  ──►  installAugmentations (reset)  ──►  nav layer (act)
  script audit         + BitNode select (next BN)         └─► company work
  crime wired                                                 └─► full faction/aug reach
```

`ensureTerminal` + the script audit make the foundation trustworthy. `installAugmentations` + BitNode-select close the autonomy loop (this is the single highest-leverage work). The nav layer unlocks everything that needs an in-page click — most importantly **company work**, which is the gate to the back half of the faction/aug tree.

Three of the four spine items (`ensureTerminal`, reset call, crime wiring) are **Small**. We can close the autonomy loop in Round 1. (`ensureTerminal` wiring is now DONE — see §1a and track 1C below; the remaining Round-1 spine is the reset call, BitNode select, and crime wiring.)

---

## §3 The three capabilities, mapped to docs

| Capability | "Can the brain…" | Owner doc | State |
|---|---|---|---|
| **RUN** | …launch every script without it insta-crashing? | [[13-test-harness-and-script-audit]] | harness designed; 2 bugs fixed; full audit pass pending |
| **ACT** | …perform any in-page action by ID (DOM-first, SF4 fallback, RAM-aware)? | [[12-navigation-interaction-layer]] | designed; not built |
| **DECIDE+LOOP** | …run the full lifecycle incl. reset + BitNode, surfacing only judgment calls? | this doc §4 + [[05-thread-p-sequencing]] | skeleton works; loop doesn't close |

Full autoplay = all three, wired together by the sequencer.

---

## §4 Build rounds (concurrency-ready)

Each round follows [[10-parallel-build-playbook]]: a solo Wave-0 freezes any shared seam and is **pushed before fan-out** (`worktree.baseRef: head` is set; verify one worktree has the seam before spawning the rest). Tracks within a round touch **disjoint files** so Sonnet agents build them in parallel. Every track is gated by the [[13-test-harness-and-script-audit]] runtime smoke — "verified" means it ran under a surgical cheat, not that it compiled.

### Round 1 — Make-it-run + close the loop (the spine)

Highest leverage, mostly Small. Goal: the brain completes a full prestige cycle unattended in a dev game.

| Track | Scope | Owner file(s) | Size | Acceptance |
|---|---|---|---|---|
| 1A · Reset loop | After `aug_planner --purchase` verifies, call `installAugmentations('/brain.js')` via `ns_dodge`, gated by `autoReset`/decision; handle the reboot | `cross/player_sequencer.ts` | S | dev game: with augs owned + `autoReset` on, brain installs and reboots into brain.js |
| 1B · BitNode select | Score BNs, pick next, `destroyW0r1dD43m0n(nextBN, '/brain.js')` via `ns_dodge` gated by `autoBitNode`/decision (SF4 path; no DOM needed) | new `player/bitnode_selector.ts` + sequencer hook | M | with daemon beatable + `autoBitNode` on, brain enters next BN; else surfaces a decision |
| 1C · ensureTerminal | ~~Call `ensureTerminal()` before every terminal injection~~ **DONE 2026-07-01** — all three `game_agent.ts` injection call sites now go through `runTerminalCommandEnsured` | `cross/launcher.ts`, `cross/game_agent.ts` | S | ✅ injection works regardless of current page (verified via tsc; live-game re-verification still recommended) |
| 1D · Crime wired | Add `autoCrime` setting + `crime` entry to registry; sequencer launches it; faction_manager falls back to karma grind when idle | `lib/settings.ts`, `lib/manager_registry.ts`, `cross/player_sequencer.ts`, `player/faction_manager.ts` | S | dev game: idle brain commits crime; karma drops |
| 1E · Script audit pass | Execute the [[13-test-harness-and-script-audit]] §3 matrix under surgical cheats; record PASS/FAIL; file small disjoint fixes; encode §4.3 smoke as a repeatable MCP sequence | `docs/design/13` matrix + tiny fixes | M | every script in the matrix has a PASS or a logged, ticketed FAIL |
| 1F · Console "offline" | Console shows "⚠ sequencer offline / no producer" when `player_state.json` is stale, instead of silent stale dots | `ui/control_console.tsx`, `ui/panels/subsystems_panel.tsx` | S | with no sequencer running, panels say offline (the exact confusion that started this round) |
| 1G · Terminal submit | ~~**CONFIRMED bug** (design/13 §8.3): `runTerminalCommand`'s captured `onKeyDown` reads stale React state~~ — **ALREADY RESOLVED** by the time of this update: the current `runTerminalCommand` uses the native-value-setter + dispatched `input`/`keydown` events approach (not the old captured-handler approach this gap described), and 1C above additionally wires the ensure-Terminal-first fix into every call path. Blast radius was MCP/control + dev path only (the brain uses `ns.exec`/`requestRun` for daemon launches, not terminal injection) | `cross/launcher.ts` | S | ✅ resolved |

**Sequencing note:** 1A/1B/1D all touch `player_sequencer.ts`. Either one owner does 1A+1B+1D as a coherent solo sub-wave, or freeze a small sequencer seam in Wave-0 and split. 1C/1E/1F are disjoint and fully parallel.

**RAM:** all Round-1 additions ride existing `ns_dodge` (~0 GB to the sequencer). No new resident footprint.

### Round 2 — Navigation / interaction layer

The full [[12-navigation-interaction-layer]] sub-venture: Wave-0 freezes `lib/actions/registry.ts` + `service.ts` types; Wave-1 = 6 disjoint agents (`dom/travel`, `dom/faction`, `dom/augmentation`, `dom/sleeve`, `sf4.ts`, `dev/selector_recon.ts`); Wave-2 integrates `act()` into the sequencer + Tier-1 (Playwright) + Tier-2 (Steam) verify. Resolve design/12 §8 open questions (apply-for-job isTrusted audit, MUI Select fiber, travel-confirm dialog) during Wave-1. **0 GB DOM path; SF4 via `ns_dodge`.**

### Round 3 — Autonomy depth (needs Round 2's `act()`)

Parallelizable; mostly disjoint manager files.

| Track | Scope | Owner file(s) | Size |
|---|---|---|---|
| 3A · Company work | apply + work via `act('apply-for-job')`/SF4 → unlock megacorp factions | new `player/company_manager.ts` + registry + sequencer | L |
| 3B · Aug strategy depth | SF11 cost multiplier; donation-based purchase via `act('donate-to-faction')` | `player/aug_planner.ts` | S+M |
| 3C · Grafting | `graftAugmentation()` behind `autoGrafting` + decision + New Tokyo travel via `act()` | `player/grafting_manager.ts` | S |
| 3D · Bladeburner Black Ops | surface `bladeOp` decision when rank threshold met | `player/bladeburner_manager.ts` | S |
| 3E · contract_solver slim | refactor 22 GB direct-Singularity imports to `ns_dodge`; enable auto-solve | `player/contract_solver.ts` | L |
| 3F · Stock↔hack coupling | coordinator reads `PORT_STOCK`, biases grow/hack toward positions | `compute/coordinator.ts`, `stock/main.ts` | M |

After Round 3 the brain plays a full BitNode end-to-end with all unlocked subsystems active.

---

## §5 RAM budget discipline (from audit §3)

Always design to the home-RAM tier. Resident floor: `game_agent` ~6.65 GB is always up.

| Home RAM | What co-fits |
|---|---|
| 8 GB | game_agent only (+ thin workers) |
| 16 GB | + sequencer (~3.3 GB) + reserve — Thread-P online |
| 18+ GB | + hacknet_manager (~9.45 GB) |
| 64+ GB | + coordinator (~15.85 GB) — MID-phase HWGW |

Rules: every Singularity call goes through `ns_dodge` (the caller pays ~0; the temp script pays the real cost and must fit free home RAM *at launch* — the nav layer pre-checks this). The nav DOM path is 0 GB and always preferred. `contract_solver` (22 GB) is the one violator and gets the `ns_dodge` refactor in Round 3.

---

## §6 Verification spine

Every round is proven with [[13-test-harness-and-script-audit]]: surgical cheat (unlock only the gated feature under test) → launch → read `status/screen.txt`/`notifications.txt` → check pass criteria. **Tier-1** = Playwright/claude-in-chrome against the `localhost:8000` dev build; **Tier-2** = the live Steam game via the RFA bridge. The §4.3 runtime smoke runs after every `ns-augment.d.ts` or `compute/*` change. No round is "done" on a green `tsc` alone.

---

## §7 Autonomy posture

Irreversible actions (install/reset, BitNode choice, scarce spends) default to **human-surfaced** via the decision queue, and are individually toggleable to full-auto (`autoReset`, `autoBitNode`, `autoBuyAugs`, …). Round 1 builds the *capability* to execute them; the toggles decide *who pulls the trigger*. (Note: the dev game currently has all toggles ON — fine for testing once the reset call is gated and safe, but it means a running sequencer will self-reset.)

---

## §8 Open questions for the user

1. **Round order** — recommended: **Round 1 now** (closes the loop; small + high-leverage), then Round 2 (nav), then Round 3. Alternative: nav first if you want to *see* the brain clicking sooner. Default = Round 1 first.
2. **Reset autonomy for first validation** — when we test the closed loop, run it with `autoReset` ON (brain installs on its own) or keep it decision-gated (human approves the first few)? Default = decision-gated until we trust it.
3. **BitNode strategy** — any preferred BitNode order, or let the scorer choose by SF-gap/reward? Default = scorer picks, surfaced for approval.
