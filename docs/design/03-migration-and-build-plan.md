# Migration & Build Plan

> Grounds [02-system-architecture.md](02-system-architecture.md) in code. Big picture +
> what's DONE (as references) + what's ACTIVE. Per-file migration history:
> `research_report/existing-src-inventory.md`. **Rule: single source of truth — no residue.**

---

## Target Folder Structure (current, on disk)

```
src/lib/      foundation: ports, ns_dodge (RAM-dodge), servers, config, format, script, connect, types
src/workers/  ultra-thin H/G/W + auto_grow, share, simple_hack_loop  (RAM-minimal, logic-free)
src/compute/  Thread C: coordinator, hwgw_batcher, scheduler, target_selector, allocator,
              exec_multi, formulas, ram_manager, pserv_manager, hacknet_manager, spreader
src/player/   Thread P (user-invoked): faction_manager, program_acquirer, aug_planner,
              crime, contract_solver, goto
src/cross/    phase_detector, game_agent, boot_agent, reporter, notification
src/stock/    main + config/forecast/market/stock/trader
src/types/    ns-augment.d.ts
```

Toolchain: `tsc -w` → `dist/` → custom WebSocket bridge (`build/game-bridge.ts`) → game; MCP
bridge for Claude. *(viteburner = optional future evaluation.)*

**Bus channels** (`lib/ports.ts`): 1 CMD, 2 RESULT, 3 HEARTBEAT, 4 DECISION, 5 BUS_REGISTER,
6 BUS_LOCK, 7 BUS_TASK, 8 PHASE, 9 NOTIFY, 10 STOCK, 11 AUGS.

---

## DONE — Phases 1–5 (migration complete, `tsc` green)

- **P1 Foundation** — `lib/*` established; `ns_dodge` = RAM-dodge primitive; `servers` merges BFS+enumeration+cache; `config` holds flat phase constants + `DesignPhase` enum + `SCRIPT_PATHS`.
- **P2a Compute engine** — `compute/*` from old `engine/`; `HackingConfig` + `batch_util` dissolved; `ram_manager` kept separate (breaks a circular dep).
- **P2b Workers + infra** — `workers/*`; `pserv_manager` (merged purchase_server+upgrade_home), `hacknet_manager`, `spreader`; all `/tools/` and `/deploy/` paths rewired.
- **P3 Cross-cutting** — `phase_detector` extracted from old `strategy_agent` (its remote-execution logic abandoned; phase-read folded into `coordinator`); `game_agent/boot_agent/reporter` moved; `notification` (notify-and-wait) added.
- **P4 Stock** — existing dual-mode 4S/pre-4S engine KEPT (already matches alainbryden 75-tick model); `contracts/stock.ts`→`stock/main.ts`; phase-gated launch in coordinator; positions published to `PORT_STOCK`; API-wait-loop fix.
- **P5 Player** — six Thread-P modules (Singularity via `ns_dodge`); `aug_planner` full impl (cascade ×1.9, topo deps, cheapest-rep-first) publishes `PORT_AUGS` → `phase_detector` RESET trigger.

Closed loops live: `phase_detector → PORT_PHASE → coordinator`; `aug_planner → PORT_AUGS → phase_detector`.

---

## ACTIVE WORKSTREAMS

### A. Integration & Launch  ← DOING NOW
Make the clean architecture actually run end-to-end and validate in-game.
- **Coordinator phase-aware strategy switch** (`compute/coordinator.ts` TODO): branch on `PORT_PHASE` — BOOTSTRAP/EARLY → thin-worker `simple_hack_loop`; MID/LATE → `hwgw_batcher`. *This is what makes the phase machine drive behavior.*
- **Launch/run doc** — how to start from a fresh BitNode (build → bridge → game_agent → coordinator) on 8 GB home.
- **game_agent redeploy** — live MCP relay must move `/monitor/game_agent.js` → `/cross/game_agent.js` (kill+rerun coordinator auto-launches it).

### B. Side-Engines (Phase 6)
gang (`ns.formulas.gang`, Zharay) → sleeve (inigo state machine) → bladeburner (alainbryden success-threshold) → stanek. Then **reset/aug-install recommender** (notify, doc 00 §3) → eventually full-auto orchestration.

### C. Dashboard UI
React monitoring dashboard per [ui_plan.md](../../ui_plan.md). Replaces `cross/reporter.ts` file-dump placeholder. DOM-injection (overview hooks), live server table, notification surface (`PORT_NOTIFY`).

### D. Quality Pass — deferred `TODO(design)` registry (single source of truth)
| File | Deferred item | Learn-from |
|------|--------------|-----------|
| compute/coordinator.ts | full bus: PORT_BUS_REGISTER self-register + PORT_BUS_TASK events; homeReservedRam doubling; consume PORT_STOCK → bias grow-long/hack-short | Zharay bus + coupling; alainbryden |
| compute/hwgw_batcher.ts | AttackController/TargetFinder objects; getScheduleTiming/additionalMsec/optimizePerformanceMetrics; recoveryThreadPadding; maxTargets auto-scale | inigo + alainbryden |
| compute/scheduler.ts | bus task-event accounting; arbitraryExecution bin-packing | alainbryden |
| compute/target_selector.ts | per-thread-efficiency (EARLY) / payback-period (LATE) ranking | inigo/Jrpl |
| compute/hacknet_manager.ts | hash-spend logic | alainbryden |
| cross/reporter.ts | → see workstream C | ui_plan.md |
| stock/main.ts | track purchase-time profitPotential → profitChange (sell signal) | Zharay |
| player/faction_manager.ts | company-work restore; idle karma-grind fallback; full 9-scope strategy | alainbryden |
| player/aug_planner.ts | SF11 cost-multiplier reduction; donation unlock; stat-desired filtering | alainbryden |
| player/program_acquirer.ts | createProgram() Singularity path (make vs buy) | — |

---

## Migration Safety Rules (still apply to every future wave)
1. Foundation/shared before dependents. 2. Move = update all importers + compile. 3. Delete on
completion (no residue). 4. Keep intentional RAM-inlining in tight workers. 5. Compile gate:
`npx tsc --noEmit` must be 0. 6. One config-writer per parallel wave (avoid `lib/config` races).

---

*Status: migration done; workstream A (integration & launch) active.*
