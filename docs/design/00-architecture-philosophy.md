# Architecture Philosophy (Document-First)

> **This is the source of truth.** Code is derived from this document, not the other way
> around. When behavior changes, change the doc first. All "wisdom-level" decisions live
> here or in a sibling `docs/design/*` file — never only in code.

---

## 1. The Two-Thread Model

Everything in Bitburner automation derives from orchestrating **two threads**:

### Thread C — Compute
- **What it is:** all RAM across all servers (home, purchased, rooted network).
- **Nature:** massively **parallel** (N servers × RAM running simultaneously). A scheduling problem.
- **Driven by:** pure stats/numbers. No human judgment required.
- **Examples:** hacking income (HWGW), prep (weaken/grow to min-sec/max-money), target
  selection, batch scheduling, server purchasing/upgrading, nuking/spreading, hacknet.
- **Automation stance:** **fully automate with code, cheaply.** This is the easy thread.

### Thread P — Player
- **What it is:** the single human-equivalent actor inside the game.
- **Nature:** strictly **serial** — the player can only focus on **one action at a time**
  (work a job, commit crime, train a stat, travel, study, interact with a faction). A
  priority-queue problem.
- **Driven by:** stats *plus* sometimes judgment.
- **Examples:** working for factions/companies, joining factions, buying programs,
  purchasing & installing augmentations, crime, training, travel.
- **Automation stance (current phase):** build each as an **invokable module** that the
  *user triggers*. Scripts compute the optimal action; the human still pulls the trigger
  until we trust them. Full-auto orchestration comes later.

> The asymmetry — **C is parallel, P is serial** — is *why* they are separate subsystems.
> C is a scheduler; P is a prioritizer.

---

## 2. The Automation Boundary

Three tiers. Every capability we build must be classified into exactly one.

| Tier | Rule | Examples |
|------|------|----------|
| **Auto (code)** | Decidable **purely from stats**, executable via API, no irreversible strategic commitment. | hacking, prep, targeting, server buys, hacknet, nuking, RAM allocation, *computing* which faction/aug/work is optimal |
| **Module (user-invoked)** | Scripted and ready, but a Player-thread action we don't yet fully trust. User triggers it. | auto-work, auto-faction-join, auto-buy-program, auto-buy-augs |
| **Notify (human decides)** | Judgment call **not** decidable from stats, or irreversible/strategic. Script computes a *recommendation*, surfaces a **notification**, and **waits** if it can do nothing else useful. | BitNode selection, when to reset/install augs, strategic augmentation path tradeoffs, anything ambiguous |

**Guiding heuristic:** *Simple things that can be done cleanly with code, we do with code.
Things that involve decision-making that cannot be settled purely by stats, we do not
auto-decide — we recommend and wait.*

---

## 3. The Notification System

When a Player-thread module needs an action it cannot or should not perform autonomously,
it must:
1. Compute the recommended action (with the numbers backing it).
2. Surface a **notification** (UI dashboard entry / toast / log).
3. **Yield or block** — if the script has nothing else useful to do, it waits for the human
   (or for conditions to change) rather than spinning or guessing.

**Open research question (highest priority):** How do existing full-auto scripts actually
*perform* Player-thread actions?
- Via the **Singularity API** (clean, but high RAM cost per call)?
- Via **DOM automation** (clicking real UI buttons — "cheaty window/document")?
- Via **notify-and-wait**?

The answer decides our entire Thread-P implementation strategy. See research wave.

---

## 4. Module Taxonomy (the pipeline pieces)

Draft — to be confirmed/refined by research.

**Thread C (Compute):**
- target selector — rank servers by $/sec potential
- prep — drive target to min-sec / max-money
- batcher / scheduler — HWGW timing & RAM packing across the botnet
- server purchaser — buy/upgrade pserv; home RAM upgrades
- root / spreader — nuke + propagate scripts as port-openers unlock
- hacknet manager — buy/upgrade nodes (or hashes) on ROI

**Thread P (Player):**
- faction manager — join eligible factions, choose work type
- work manager — company/faction work, reputation farming
- program acquirer — TOR + darkweb port openers (or create them)
- augmentation planner — compute optimal purchase set within budget
- crime / training — stat gains when idle
- travel — relocate for factions/companies

**Cross-cutting:**
- phase detector — classify game stage, switch strategy
- monitor / dashboard — see [ui_plan.md](../../ui_plan.md)
- notification bus — surface "human needed" actions

---

## 5. Phase Boundaries (to be defined by research)

We expect distinct strategies for **early (low RAM, low skill) → mid → late → end** game.
Research must find the natural boundaries and the signal used to detect each transition
(home RAM? hacking level? owned augs? available APIs/SourceFiles?).

---

## 6. Open Questions for Research — RESOLVED

See [01-research-synthesis.md](01-research-synthesis.md) §1 for detail. Short answers:

1. **Player-action mechanism:** Singularity API wrapped in a RAM-dodge
   (`getNsDataThroughFile`). DOM-clicking only for the casino. → Thread-P = Singularity + RAM-dodge.
2. **Early-game Player automation:** Confirmed — *unavailable* before SourceFile-4 (scripts
   self-terminate). Bridge is casino blackjack → stocks. Pre-SF4 income = stocks + hacking;
   Thread-P early = notify-and-wait + user-invoked modules.
3. **Phase detection:** Nobody has a real state machine (scattered flags). → We build one. See
   [02-system-architecture.md](02-system-architecture.md) §1.
4. **Copy vs build:** see [01-research-synthesis.md](01-research-synthesis.md) §6 matrix.

---

*Status: refined from research wave. Open questions resolved; see sibling design docs.*
