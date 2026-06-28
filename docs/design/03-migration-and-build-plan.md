# Migration & Build Plan (Actionable)

> Grounds [02-system-architecture.md](02-system-architecture.md) in our existing `src/`. Maps every
> existing file to a target, in build order. Detail per file: `research_report/existing-src-inventory.md`.
> **Rule: single source of truth.** When a target file is done, its sources/duplicates are deleted. No residue.

---

## Target Folder Structure

```
src/
├── lib/        shared, imported everywhere — ports, ns_dodge, servers, format, config, script, connect, types
├── workers/    ultra-thin HGW/prep scripts (RAM-minimal, logic-free)
├── compute/    Thread C — coordinator, scheduler, hwgw_batcher, allocator, target_selector,
│               spreader, pserv_manager, hacknet_manager, exec_multi, formulas
├── player/     Thread P — faction_manager, work_manager, program_acquirer, aug_planner, crime, goto, contract_solver
├── cross/      phase_detector, game_agent, boot_agent (→bus), reporter (monitor/UI), notification
├── stock/      stockEngine (keep as-is, wire to phase)
└── types/      ns-augment.d.ts
```

Toolchain unchanged: `tsc -w` → `dist/` → custom WebSocket bridge (`build/game-bridge.ts`) → game;
MCP bridge for Claude. *viteburner = optional future evaluation, not now.*

---

## Migration Safety Rules (every agent obeys)

1. **Foundation before modules.** No module agent starts until `src/lib/` is stable and `tsc` is green.
2. **Move = update all importers.** Relocating a file means fixing every `import` of it repo-wide, then compiling clean.
3. **Delete on completion.** Once a target absorbs a source, delete the source. Delete the ABANDON list.
4. **Don't break intentional RAM-inlining.** Some tight scripts inline BFS on purpose (RAM). Keep inline where the file's RAM budget demands it; note it. Single-source-of-truth applies to *libraries*, not forced into RAM-critical workers.
5. **Compile gate.** An agent's work isn't done until `tsc --noEmit` passes.

---

## PHASE 1 — Foundation (ONE agent, alone)

Establishes the import surface. Build/relocate all of `src/lib/`:

| Target | Source(s) | Action | Learn-from |
|--------|-----------|--------|-----------|
| `lib/ports.ts` | **NEW** (ports 1–4 are magic literals in 4 files today) | Build: named channel constants + peek/pop/set/clear helpers + room for bus protocol (register/lock/task-event) | inigo `libPorts.ts` (named-constant discipline); Zharay port-map schema |
| `lib/ns_dodge.ts` | `tools/simple_through_file.ts` | Move; keep tested API | alainbryden `getNsDataThroughFile` (already equivalent) |
| `lib/servers.ts` | merge `lib/network.ts` + `lib/server.ts` + `engine/batch_util.getAvailableServers` + `engine/ram_manager` enumeration | Consolidate BFS + botnet enumeration; add Server cache + `resetCaches()` per loop | alainbryden Server lazy-cache + resetCaches; $/s scoring model |
| `lib/format.ts` | `lib/format.ts` (adapt); delete dup `formatRamGb` in `engine/server_manager` | Wrap `ns.formatNumber` (NOT deprecated `nFormat`); single `formatRam` | inigo `fmt` tagged-template |
| `lib/config.ts` | `engine/config.ts` | Flatten; add **phase-boundary constants** + budgets + reserves (doc 02 §1) | alainbryden tunable thresholds centralized |
| `lib/script.ts`, `lib/connect.ts`, `lib/types.ts` | same | Move as-is | — |

Also: **delete the ABANDON list** (`engine/auto_grow.ts`, `info/servers.ts`, `info/script_ram.ts`,
`template.ts`, `experiment.tsx`, `tools/clean.ts`). Update all importers. `tsc --noEmit` must pass.

---

## PHASE 2 — Compute Core (fan out, disjoint file ownership)

| Target | Source(s) | Verdict | Learn-from |
|--------|-----------|---------|-----------|
| `workers/{hack,grow,weaken,auto_grow,share,simple_hack_loop}.ts` | `deploy/*` | KEEP, move | Jrpl thin-worker (keep ≤ op+sleep RAM) |
| `compute/coordinator.ts` | merge `contracts/batch_hack.ts` (entry) + `engine/ram_manager` + `engine/batch_util` leftovers | ADAPT | Zharay coordinator (self-register, locks, task-events) |
| `compute/scheduler.ts` | `engine/thread_manager.ts` | ADAPT + bus | alainbryden `arbitraryExecution` bin-packing |
| `compute/hwgw_batcher.ts` | `engine/batch_hack_manager.ts` (+ `engine/allocator.ts`, `compute/formulas.ts`) | ADAPT + bus | inigo `AttackController`/`TargetFinder`; alainbryden `getScheduleTiming`/`additionalMsec`/`optimizePerformanceMetrics` |
| `compute/target_selector.ts` | `engine/server_manager.ts` | ADAPT | inigo payback-period ranking; Jrpl per-thread-efficiency (early) |
| `compute/spreader.ts` | `tools/scan_nuke.ts` | ADAPT (clean) | Zharay `auto-spread-v2` |
| `compute/pserv_manager.ts` | merge `tools/purchase_server.ts` + `tools/upgrade_home.ts` | ADAPT | alainbryden host-manager **time-decay budget**; inigo RAM tiers |
| `compute/hacknet_manager.ts` | `tools/hacknet.ts` | ADAPT + phase/config | ROI loops (both repos) |
| `compute/exec_multi.ts`, `compute/allocator.ts`, `compute/formulas.ts` | same | move/cleanup | — |

RAM auto-scaling primitives to bake into coordinator/scheduler: **maxTargets auto-scale,
recoveryThreadPadding, homeReservedRam doubling** (alainbryden).

---

## PHASE 3 — Cross-cutting

| Target | Source(s) | Verdict | Learn-from |
|--------|-----------|---------|-----------|
| `cross/phase_detector.ts` | **EXTRACT** from `monitor/strategy_agent.ts` (decouple from execution) | ADAPT | our existing machine is solid; just isolate + publish to bus |
| `cross/game_agent.ts` | `monitor/game_agent.ts` | KEEP, move (MCP relay) | — |
| `cross/boot_agent.ts` | `monitor/boot_agent.ts` | ADAPT → named-port bus | Zharay bus |
| `cross/reporter.ts` + dashboard | `monitor/reporter.ts` + `ui_plan.md` | ADAPT (redesign later) | ui_plan.md React injection; alainbryden DOM patterns |
| `cross/notification.ts` | **NEW** | Build | notify-and-wait (doc 00 §3) |

## PHASE 4 — Stock Engine
`stock/*` mostly KEEP; `contracts/stock.ts`→`stock/main.ts`; wire to phase system.
Learn-from: alainbryden pre-4S cycle model; Zharay 4S `profitPotential` + **stock↔hack market-manipulation coupling**.

## PHASE 5 — Thread-P Modules (user-invoked; Singularity + lib/ns_dodge)

| Target | Source(s) | Learn-from |
|--------|-----------|-----------|
| `player/faction_manager.ts` (+ work) | `contracts/faction.ts` | alainbryden work-for-factions priority + scope expansion |
| `player/program_acquirer.ts` | merge `tools/port_openers.ts` + `contracts/backdoor.ts` | — |
| `player/aug_planner.ts` | `info/augmentations.ts` (seed) | alainbryden faction-manager cascading-cost + cheapest-rep-first + dependency ordering |
| `player/crime.ts` | `contracts/crime.ts` (swap to `lib/ns_dodge`) | — |
| `player/contract_solver.ts`, `player/goto.ts` | `deploy/contracts.ts`, `contracts/goto.ts` | move |

## PHASE 6 — Side-Engines (later)
gang → sleeve → bladeburner → stanek. Then RESET recommender (notify), then full-auto orchestration.

---

*Status: actionable plan ready. Execution begins Phase 1 (foundation), then fan-out per phase.*
