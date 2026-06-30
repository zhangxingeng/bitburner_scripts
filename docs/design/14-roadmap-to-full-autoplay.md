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
1. **The reset loop never closes** — `ns.singularity.installAugmentations(...)` is called *nowhere*. We buy augs and never install them. (audit gap #1)
2. **Terminal injection silently fails off the Terminal page** — `launcher.ts` doesn't call `ensureTerminal()` first (design/06 §6 step 4 never landed). A likely contributor to "is anything even running?". (gap #3)
3. **No action-level navigation** — the brain can switch sidebar pages but cannot click in-page controls (travel, apply-for-job, buy-aug, donate, assign-sleeve). → [[12-navigation-interaction-layer]]
4. **Crime never fires** — `crime.ts` works but isn't in the registry; karma grind (gates Daedalus, etc.) never happens. (gap #2)
5. **Company work missing** — megacorp faction invites never arrive → 8+ factions and their exclusive augs are unreachable. (gap #4)
6. **BitNode selection missing** — after a reset the brain would stall at the BitVerse. (gap #5)
7. Smaller: grafting is report-only (gap #7), aug pricing ignores SF11 + can't donate (gap #8), bladeburner Black Ops aren't surfaced (gap #6), `contract_solver` is 22 GB (gap #9), stock↔hack coupling unbuilt (gap #10).

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

Three of the four spine items (`ensureTerminal`, reset call, crime wiring) are **Small**. We can close the autonomy loop in Round 1.

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
| 1A · Reset loop | After `aug_planner --purchase` verifies, call `installAugmentations('/bootstrap.js')` via `ns_dodge`, gated by `autoReset`/decision; handle the reboot | `cross/player_sequencer.ts` | S | dev game: with augs owned + `autoReset` on, brain installs and reboots into bootstrap |
| 1B · BitNode select | Score BNs, pick next, `destroyW0r1dD43m0n(nextBN, '/bootstrap.js')` via `ns_dodge` gated by `autoBitNode`/decision (SF4 path; no DOM needed) | new `player/bitnode_selector.ts` + sequencer hook | M | with daemon beatable + `autoBitNode` on, brain enters next BN; else surfaces a decision |
| 1C · ensureTerminal | Call `ensureTerminal()` before every terminal injection | `cross/launcher.ts` | S | injection works regardless of current page (Tier-1) |
| 1D · Crime wired | Add `autoCrime` setting + `crime` entry to registry; sequencer launches it; faction_manager falls back to karma grind when idle | `lib/settings.ts`, `lib/manager_registry.ts`, `cross/player_sequencer.ts`, `player/faction_manager.ts` | S | dev game: idle brain commits crime; karma drops |
| 1E · Script audit pass | Execute the [[13-test-harness-and-script-audit]] §3 matrix under surgical cheats; record PASS/FAIL; file small disjoint fixes; encode §4.3 smoke as a repeatable MCP sequence | `docs/design/13` matrix + tiny fixes | M | every script in the matrix has a PASS or a logged, ticketed FAIL |
| 1F · Console "offline" | Console shows "⚠ sequencer offline / no producer" when `player_state.json` is stale, instead of silent stale dots | `ui/control_console.tsx`, `ui/panels/subsystems_panel.tsx` | S | with no sequencer running, panels say offline (the exact confusion that started this round) |
| 1G · Terminal submit | Verify `game_agent`/`launcher` actually SUBMIT injected terminal commands — live validation found the MCP path set the React input without firing submit (needed a native Enter); fix if the brain's `launcher` path shares the defect | `cross/game_agent.ts`, `cross/launcher.ts` | S | injected command runs without a native Enter (Tier-1); see design/13 §8.3 |

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
