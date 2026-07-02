# Research Synthesis — What the Four Reference Repos Teach Us

> Cross-repo synthesis of `docs/reference/research_report/*.md`. Source repos: **Jrpl** (minimal early-game),
> **Zharay** (mid-scale botnet + side-engines), **inigo** (modern TypeScript architecture),
> **alainbryden** (full end-game autopilot). Per-repo detail lives in `docs/reference/research_report/`.

---

## 1. The Big Answers (our open questions, resolved)

### Q: How do full-auto scripts perform Player-thread actions?
**Singularity API everywhere** (`ns.singularity.commitCrime / workForFaction / travelToCity /
purchaseAugmentation / installAugmentations / destroyW0r1dD43m0n`). The **only** DOM-clicking
is `casino.js` (blackjack). Both alainbryden and inigo confirm this independently.

The catch — Singularity calls cost **16×** RAM under SF4.1. alainbryden's answer is the
**`getNsDataThroughFile` RAM-dodge**: spawn a temp 1-GB script, run the costly call there, write
the result to a file, parent reads it back. This is the single most important pattern to adopt —
it makes Singularity affordable on modest home RAM. **(Thread-P implementation = Singularity + RAM-dodge.)**

### Q: What about early game, before SourceFile-4?
Your memory was right. Pre-SF4, player automation **is not available** — alainbryden's
`work-for-factions.js` / `ascend.js` / `faction-manager.js` literally self-terminate. The bridge:
**casino blackjack ($10B via DOM) → stocks (`stockmaster.js`)**. Stock APIs (`ns.stock.*`) do
**not** require SF4. So **pre-SF4 income is stocks + hacking, not player automation.** Early-game
Thread-P = notify-and-wait + user-invoked modules.

### Q: How is the reset/install loop decided?
File-driven threshold. `faction-manager.js` writes affordable-aug count to a temp file;
`autopilot.js` polls it every 2s and triggers reset when count ≥ threshold (default 8, **time-decays
−0.5/hour** so it eventually resets even with few augs). Reset = `ascend.js` liquidates → buys
RAM/Stanek/augs/cores → `installAugmentations(autopilot.js)` → autopilot restarts itself.
**For us: compute this recommendation and NOTIFY; auto-trigger only in the later full-auto phase.**

### Q: Phase detection?
**Nobody has a real state machine.** alainbryden uses scattered inline flags/thresholds
(homeRam==8, <32, <64, hack≥8000, etc.); inigo has a binary bootstrap→launchAll split.
**Every report flags this as the thing to formalize.** → We build a proper phase enum. See `02-system-architecture.md`.

---

## 2. Coordination Mechanism — three styles observed

| Repo | IPC | Parallelism | Notes |
|------|-----|-------------|-------|
| alainbryden | **files** (`/Temp/*.txt`, `reserve.txt`) + arg-position encoding | parallel | RAM-dodge doubles as IPC |
| inigo | **ports** (21 named constants, `libPorts.ts`) | **sequential** orchestrators | clean but no parallel compute |
| Zharay | **port message bus** (all 20 ports): published global state + daemon inboxes + **self-registering daemons + distributed locks + task-event reporting** | parallel | most sophisticated live coordination |

**Verdict:** adopt **Zharay's port message-bus model** (self-registering daemons, locks,
START/DONE task events for zero-poll accounting) with **inigo's named-constant discipline**.
Keep files only for (a) the MCP bridge we already have and (b) the Singularity RAM-dodge.

---

## 3. Income Engine — early vs late

- **Early / low-RAM (copy Jrpl):** ultra-thin workers — `sleep(delay)` + one `ns.hack/grow/weaken`,
  ~1.6 GB + op cost. ALL logic (thread counts, timing) precomputed in the orchestrator and passed as
  exec args. `little_hack()` fallback scales a divisor until threads fit usable RAM — directly
  applicable to 8 GB home. **Our `simple_hack_loop` should become this distributed thin-worker model.**
- **Late / HWGW (build, skeleton from inigo + math from alainbryden):** inigo's `AttackController`
  / `TargetFinder` classes are the cleanest batching reference (Formulas API, multi-batch concurrency,
  auto-reprime). alainbryden contributes the timing math worth copying outright: `getScheduleTiming`
  (absolute-time scheduling), the `additionalMsec` trick (bundle delay into the op instead of sleep),
  `optimizePerformanceMetrics` (binary-search steal %), `arbitraryExecution` (RAM bin-packing).

---

## 4. Infrastructure & RAM Scaling (copy alainbryden's mechanisms)

- **maxTargets auto-scale:** start `2 + totalRam/500TB`, scale up when utilization <80%, down when >95%.
- **recoveryThreadPadding:** extra grow/weaken threads (1×→10×) as a self-healing buffer against misfires.
- **homeReservedRam:** 32 GB, doubles at 512 GB home.
- **host-manager time-decay budget:** spend aggressively early in an aug cycle, conservatively later.
- **Purchased servers:** inigo buys in RAM tiers by hack level; alainbryden uses the decay budget. Adopt the budget concept.

---

## 5. Side-Engines — classification (Thread C/P, when relevant)

| Engine | Thread | Decidable? | When | Reference / verdict |
|--------|--------|-----------|------|---------------------|
| **Stocks** | C | stat | **early (primary pre-SF4 income)** | alainbryden pre-4S cycle model + Zharay 4S `profitPotential` signal + **stock↔hack market-manipulation coupling** (grow longs / hack shorts). HIGH PRIORITY. |
| **Hacknet** | C | stat (ROI) | early | build our own ROI loop; both repos simple |
| **Gang** | C (after creation) | stat | mid (Karma −40K gate) | copy Zharay `gang-nullsec` (`ns.formulas.gang`, wanted≤0 while maximizing money) |
| **Sleeve** | C | stat | mid+ (SF10) | inigo state machine + alainbryden; mirrors player work |
| **Bladeburner** | C | stat | late (SF7) | alainbryden success-threshold action selection |
| **Stanek** | C | stat | situational (SF13) | alainbryden monopolizes RAM for charge value |
| **Corp** | **Hybrid** | **partly judgment** | late | ~30 min manual bootstrap + `trickInvest` timing = Thread P; rest Thread C. Low priority, complex. |
| **Casino** | P (DOM) | mechanical | bootstrap once | $10B blackjack via DOM; one-time, user-invoked |

---

## 6. Copy-vs-Build Matrix (the "steal these" list)

**COPY near-verbatim (port into our TS):**
1. `getNsDataThroughFile` RAM-dodge — *essential* (alainbryden)
2. Thin worker scripts (Jrpl)
3. Named port constants + helpers (inigo `libPorts`)
4. Port message-bus: self-register + locks + task-events (Zharay)
5. HWGW timing math: `getScheduleTiming`, `additionalMsec`, `optimizePerformanceMetrics`, `arbitraryExecution` (alainbryden)
6. Aug purchase ordering: cascading-cost sim, cheapest-rep-faction-first, dependency ordering (alainbryden + inigo)
7. Stock signals: pre-4S cycle detection + 4S `profitPotential` + stock↔hack coupling (alainbryden + Zharay)
8. Sleeve state machine (inigo `selectSleeveTask`)

**BUILD our own (better design on top of their ideas):**
- Phase **state machine** (everyone lacks one)
- HWGW batcher using inigo's class skeleton + alainbryden's math (don't copy the 1800-line `daemon.js` monolith — author calls it "a mess")
- Coordinator/scheduler with RAM auto-scaling + recoveryThreadPadding baked in
- Target selector (phase-aware: payback-period ranking late, per-thread efficiency early)
- pserv/hacknet/home-upgrade managers with time-decay budget
- Monitoring dashboard + notification bus (built as the control console, see [08-control-console.md](08-control-console.md); original scratch notes `docs/archive/ui_plan.md`)

**TOOLCHAIN:**
- Evaluate **viteburner** (inigo) — file-save hot-push to game. Possible upgrade to our bridge.
- Use `fmt` tagged-template style but **avoid deprecated `ns.nFormat`** (use `ns.formatNumber`).

---

*Status: synthesis complete from 5 research reports. Drives `02-system-architecture.md`.*
