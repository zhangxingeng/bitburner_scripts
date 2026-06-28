# System Architecture — Our Design

> Derived from [00-architecture-philosophy.md](00-architecture-philosophy.md) (the two-thread
> model + automation boundary) and [01-research-synthesis.md](01-research-synthesis.md) (what to
> copy/build). This is the high-level design. Actionable per-module build specs come next (Wave 3).

---

## 1. Phase State Machine (the missing piece nobody had)

A single `phaseDetector` classifies game stage each tick and publishes it on the bus. Every module
reads the phase and adapts. Signals: home RAM, hacking level, money, SF4/SF availability, owned
augs, time-since-last-aug, port openers, total network RAM.

| Phase | Entry signal | Compute strategy | Player strategy | Income |
|-------|-------------|------------------|-----------------|--------|
| **BOOTSTRAP** | home = 8 GB, fresh | thin workers on n00dles/foodnstuff; manual/auto nuke | notify-and-wait only | simple hack loop |
| **EARLY** | network rooted, home < 64 GB | distributed thin workers across all rooted servers; small pservs; hacknet | user-invoked modules; mostly manual | hacking + **stocks** |
| **MID** | home ≥ 64 GB, HWGW viable | **HWGW batching**, multi-target, RAM auto-scale | faction/work/program/aug modules invokable (Singularity + RAM-dodge if SF4) | hacking + stocks + gang |
| **LATE** | home ≥ 512 GB, SF4, side-engines unlocked | full multi-target batching | side-engines auto (gang/sleeve/bladeburner/stanek); aug planner | all engines |
| **RESET** | affordable augs ≥ threshold (time-decay) | — | **recommend** aug buy+install+BN destroy (notify; auto only in full-auto phase) | — |

Boundaries are tunable constants in one config file, not scattered magic numbers.

---

## 2. The Two Threads as Subsystems

```
                         ┌─────────────────────┐
                         │   PORT MESSAGE BUS   │  (named constants, inigo-style)
                         │  + Singularity files │  (RAM-dodge, alainbryden-style)
                         └──────────┬──────────┘
              ┌─────────────────────┼─────────────────────┐
   ┌──────────┴──────────┐  ┌───────┴────────┐  ┌──────────┴──────────┐
   │   THREAD C (compute) │  │  CROSS-CUTTING │  │  THREAD P (player)  │
   │   parallel scheduler │  │                │  │  serial prioritizer │
   ├──────────────────────┤  ├────────────────┤  ├─────────────────────┤
   │ • coordinator/sched  │  │ • phaseDetector│  │ • factionManager    │
   │ • thin workers (HGW) │  │ • monitor/UI   │  │ • workManager       │
   │ • HWGW batcher       │  │ • notification │  │ • programAcquirer   │
   │ • targetSelector     │  │   bus          │  │ • augPlanner        │
   │ • spreader/rooter    │  │ • config       │  │ • crime/train/travel│
   │ • pservManager       │  └────────────────┘  │ • (gang/sleeve/BB/  │
   │ • hacknetManager     │                       │   stanek = C-driven │
   │ • stockEngine        │                       │   side-engines)     │
   └──────────────────────┘                       └─────────────────────┘
```

**Coordination:** Zharay-style bus — daemons self-register, pull shared state (targets, phase,
locks), report START/DONE task events for zero-poll RAM/thread accounting; distributed locks with
force-clear timeout. Files reserved for the MCP bridge + Singularity RAM-dodge only.

**Thread-P mechanism:** Singularity API wrapped in `getNsDataThroughFile`. Each P-module is
**user-invokable now**; computes the optimal action from stats; for judgment calls it emits a
notification and waits. Full-auto orchestration is a later phase.

---

## 3. Foundation Libraries (build first — everything depends on these)

- `lib/ports` — named port constants + peek/pop/set helpers + bus protocol (register/lock/event)
- `lib/nsDodge` — `getNsDataThroughFile` RAM-dodge wrapper (THE enabling primitive)
- `lib/servers` — BFS discovery, Server cache w/ resetCaches() per loop
- `lib/format` — `fmt` tagged template (use `ns.formatNumber`, not deprecated `nFormat`)
- `lib/config` — all tunable thresholds (phase boundaries, budgets, reserves) in one place
- `phaseDetector` — publishes current phase to the bus

---

## 4. Build Order (small pieces first, by game constraint)

Spine chosen by user = **Core loop end-to-end** before side-engines.

1. **Foundation libs** (§3) + phase detector
2. **Compute core:** thin workers → coordinator/dispatch → target selector → spreader. (Upgrades our current `simple_hack_loop` into the distributed thin-worker model.) Works BOOTSTRAP→EARLY.
3. **HWGW batcher** (inigo class skeleton + alainbryden timing math + bin-packing). Activates at MID.
4. **Infra managers:** pserv (time-decay budget), hacknet (ROI), home-upgrade, RAM auto-scale + recoveryThreadPadding.
5. **Stock engine** (primary early income; pre-4S model now, 4S + market-manipulation coupling later).
6. **Monitoring UI + notification bus** (`ui_plan.md`) — so we can watch everything above.
7. **Thread-P modules (user-invoked):** factionManager, workManager, programAcquirer, augPlanner (Singularity + RAM-dodge).
8. **Side-engines:** gang → sleeve → bladeburner → stanek.
9. **Reset/aug-install recommender** (notify) → eventually full-auto orchestration.

---

## 5. What We Are Explicitly NOT Doing Yet

- No auto-reset / auto-install (notify + recommend only) until trusted.
- No BitNode auto-selection (pure judgment — always human).
- No corporation automation initially (hybrid, ~30 min manual bootstrap, complex — defer).
- No full-auto Thread-P orchestration — modules are user-invoked first.

---

*Status: high-level design complete. Next: Wave 3 grounds each numbered build-order item into an
actionable spec (interfaces, ports, RAM budget, file layout) before any code is written.*
