# Design 11 — Subsystem Autonomy + Console v2 (wide build, all three themes)

**Status:** PLAN (awaiting ratification 2026-06-30). Doc-first so it survives compaction. Built as ONE wave-based parallel round per [[10-parallel-build-playbook]] (now with `worktree.baseRef: head` set, so the unpushed Wave-0 seam reaches the agents).

**User direction (2026-06-30):** the next round covers **all three themes at once** — they're separate things, plan them well, fan out Sonnet agents concurrently like console v1.

- **T1 — Subsystem managers (self-play):** autonomous managers for the game's side-engines.
- **T2 — Deepen + harden the brain:** wire the existing-but-manual pieces into the sequencer, generalize the launch model, add tests.
- **T3 — Console v2:** surface every subsystem + richer display (overview, charts, audit log) and more decision types.

**Companions:** [[05-thread-p-sequencing]] (the brain), [[08-control-console]] (the surface), [[10-parallel-build-playbook]] (the process). Reference impls live in `example_code_dump/alainbryden-*`; analyses in `research_report/`.

---

## §1 Why one seam for all three

The themes are interdependent, so a flat fan-out would collide:
- Managers (T1) must publish status that the console (T3) renders → shared **status contract**.
- Managers need autonomy **toggles** (T2/settings) and **decision** wiring (big spends).
- The sequencer (T2) must launch each manager → if every manager edits the sequencer, they all collide.

**Fix:** Wave 0 freezes a seam where the sequencer walks a **manager registry** (data), so Wave-1 agents implement *only their own manager script* and never touch the sequencer or settings. Same disjoint-ownership discipline that made console v1 merge cleanly.

## §2 Inventory (recon 2026-06-30)

**Already autonomous:** compute (hacknet_manager, pserv, coordinator/HWGW batcher), stock engine (`stock/main.js`) — both auto-launched by `bootstrap.ts` via `DAEMON_CATALOG`, phase-gated, no settings toggle. Player: faction_manager, program_acquirer, aug_planner (all wired into player_sequencer); contract_solver **exists but is NOT wired** (`autoSolveContracts` toggle exists, default false, unused).

**Missing managers:** gang, corporation, bladeburner, sleeve, stanek, grafting.

**Reference implementations** (`example_code_dump/alainbryden-bitburner-scripts/`): `gangs.js`, `bladeburner.js`, `sleeve.js`, `stanek.js` (+`optimize-stanek.js`), `hacknet-upgrade-manager.js`, `stockmaster.js`, `spend-hacknet-hashes.js`. **No corporation script** — corp automation is the hardest and unreferenced (see §6).

**Validation reality:** gang/corp/bladeburner/sleeve/stanek/grafting are SF/BitNode-gated. We can BUILD them all (autonomy for when the SF is owned), but Tier-2 can only validate the ones whose SF this save has. Each manager must self-guard on availability and no-op cleanly when absent.

## §3 The frozen seam — Wave 0 (me, solo, 1 commit, compiles with stubs)

### 3.1 `settings.ts` — autonomy toggles (one place)
Add per-subsystem switches (default OFF for irreversible/scarce-spend leaning; safe ones may default ON):
`autoGang`, `autoCorp`, `autoBladeburner`, `autoSleeve`, `autoStanek`, `autoGrafting`, plus bring existing under the model: `autoContracts` (rename/alias the existing `autoSolveContracts`), and optional `autoHacknet`/`autoStock` (default ON — they already run). Each may carry a small tunable later; keep v1 boolean.

### 3.2 `src/lib/subsystem_state.ts` — generic status contract (NEW)
```ts
export interface SubsystemStatus {
  id: string;            // 'gang' | 'corp' | ...
  available: boolean;    // SF/BitNode present & feature usable
  enabled: boolean;      // settings toggle
  running: boolean;      // manager daemon alive
  headline: string;      // one-line state ("Respect 1.2m · 12 members")
  metrics: Record<string, number | string>;  // panel detail rows
  ts: number;            // ms epoch (0 = never published)
}
loadSubsystem(ns, id): SubsystemStatus     // status/subsystems/<id>.json; EMPTY on miss
saveSubsystem(ns, s): void
loadAllSubsystems(ns, ids): SubsystemStatus[]
```
Producer = each manager (writes its own file). Consumer = console (reads, 0 GB). Mirrors `player_state.ts`/`decisions.ts`.

### 3.3 `src/lib/manager_registry.ts` — the launch table (NEW; the key to disjointness)
```ts
export interface ManagerSpec {
  id: string; path: string; settingKey: keyof BrainSettings;
  // availability is checked by the manager itself; the sequencer only gates on the toggle
}
export const PLAYER_MANAGERS: ManagerSpec[] = [
  { id: 'gang',        path: SCRIPT_PATHS.gangManager,        settingKey: 'autoGang' },
  { id: 'corp',        path: SCRIPT_PATHS.corpManager,        settingKey: 'autoCorp' },
  { id: 'bladeburner', path: SCRIPT_PATHS.bladeburnerManager, settingKey: 'autoBladeburner' },
  { id: 'sleeve',      path: SCRIPT_PATHS.sleeveManager,      settingKey: 'autoSleeve' },
  { id: 'stanek',      path: SCRIPT_PATHS.stanekManager,      settingKey: 'autoStanek' },
  { id: 'grafting',    path: SCRIPT_PATHS.graftingManager,    settingKey: 'autoGrafting' },
  { id: 'contracts',   path: SCRIPT_PATHS.contractSolver,     settingKey: 'autoContracts' },
];
```
The sequencer walks this each tick with the existing crash-guard/relaunch pattern (faction_manager style). Adding a manager = add a `SCRIPT_PATHS` entry + a registry row (both in Wave 0) + the script (Wave 1). The sequencer file changes **once** (Wave 0).

### 3.4 `decisions.ts` — widen `DecisionKind`
Add subsystem big-spend kinds: `'corpInvest' | 'gangWarfare' | 'bladeOp' | 'graft' | …` (generic enough that managers reuse them). Pure type widening; the queue mechanics are unchanged.

### 3.5 `console_types.ts` + panel stubs (T3 seam)
- `ConsoleState.subsystems: SubsystemStatus[]` (loop reads `loadAllSubsystems`).
- New `Intent`s: `{kind:'toggleSubsystem', id, on}` (writes the settings toggle), and any subsystem one-shot actions later.
- Stub panels: `subsystems_panel.tsx` (overview: every subsystem's available/enabled/running/headline + a toggle), `charts_panel.tsx` (income/RAM sparkline from a rolling history file), `audit_panel.tsx` (action history). Registered in `PANELS` (tab order).

### 3.6 `SCRIPT_PATHS` (config.ts)
Add `gangManager`, `corpManager`, `bladeburnerManager`, `sleeveManager`, `stanekManager`, `graftingManager` → `/player/<x>_manager.js`.

### 3.7 Sequencer (player_sequencer.ts) — walk `PLAYER_MANAGERS`
One generalized loop replacing/augmenting the per-manager blocks: for each spec, if `settings[settingKey]`, ensure the daemon is alive (crash-guard + relaunch + notify), else ensure it's stopped. This is the ONLY sequencer edit; done in Wave 0 so Wave-1 manager agents never touch it.

### 3.8 Tests scaffold (T2)
A lightweight node-runnable harness dir (`test/`) + one example test (e.g. subsystem_state round-trip), so Wave-1 can add per-module tests against a known pattern.

**Wave 0 done when:** `tsc --noEmit` + `node --check` clean with all stubs; the sequencer compiles walking an all-stub registry (managers are stub scripts that just publish an `available:false` status and exit).

## §4 Wave 1 — parallel agents (worktrees, disjoint files)

Each manager agent: **study `example_code_dump/alainbryden-<x>.js` + `research_report/alainbryden-player.md` first**, implement `src/player/<x>_manager.ts` ONLY, self-guard on SF/BitNode availability (publish `available:false` + exit cleanly when absent), follow the faction_manager crash-guard/log shape, publish `SubsystemStatus` each loop, surface irreversible/scarce spends as decisions (don't auto-spend beyond safe rules). RAM-light; route Singularity/feature calls through `ns_dodge` where needed.

| Agent | Owns | Notes |
|---|---|---|
| A — Gang | `player/gang_manager.ts` | ref `gangs.js`; ascension/recruit/task/equip; warfare decision |
| B — Bladeburner | `player/bladeburner_manager.ts` | ref `bladeburner.js`; contracts/ops/skills; black-op = decision |
| C — Sleeve | `player/sleeve_manager.ts` | ref `sleeve.js`; assign tasks; shock recovery |
| D — Stanek | `player/stanek_manager.ts` | ref `stanek.js`/`optimize-stanek.js`; charge fragments |
| E — Grafting | `player/grafting_manager.ts` | Singularity grafting; queue by value; spend = decision |
| F — Corp | `player/corp_manager.ts` | **pending §6 decision** — no reference; large |
| G — Hacknet/Stock wiring | `player/hacknet_stock_status.ts` (status shim) | publish SubsystemStatus for the already-running engines; do NOT rewrite them |
| H — Subsystems panel | `ui/panels/subsystems_panel.tsx` | overview + per-subsystem toggle |
| I — Charts panel | `ui/panels/charts_panel.tsx` | income/RAM sparkline from a rolling history file |
| J — Audit panel | `ui/panels/audit_panel.tsx` | action/decision history feed |
| K — Tests | `test/*` | per-module tests against the §3.8 harness |

(Contract autonomy needs no new script — the registry row + existing `contract_solver.ts` cover it; if the solver needs an always-on loop wrapper, that's a small Wave-1 task.)

## §5 Wave 2 — integrate + verify (me, solo)
Integrate disjoint files (copy panels/managers; the sequencer + seam already merged in Wave 0). Add the new panels to the tab bar. Full verify (`tsc`, `node --check`). Then the SINGLE Tier-2 pass — validate each subsystem whose SF this save owns; the rest are confirmed to no-op cleanly (available:false) and are validated later when unlocked.

## §6 Open decisions (ratify before building)
1. **Corporation (Agent F):** include now or defer? It's the largest, has **no reference impl**, and is often unavailable/not-worth-it early. Recommend **defer** to a focused follow-up round; scaffold a stub manager (publishes available + a "corp automation not yet implemented" headline) so the registry/console slot exists.
2. **SF-gated build scope:** build **all** managers now (validate as SFs unlock) — recommended, since toggles default OFF and managers no-op when unavailable — vs build only what this save can validate.
3. **Default ON/OFF:** all new toggles default **OFF** (safe; user opts in per subsystem) — recommended — except `autoHacknet`/`autoStock` which already run (default ON to preserve current behavior).
