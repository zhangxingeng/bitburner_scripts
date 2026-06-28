# Existing Source Inventory — Migration Mapping

> Read-only audit of `src/` and `build/`. Prepared for migration planning against the Wave-2 design docs.

---

## 1. File Inventory Table

| Current Path | One-Line Purpose | New Module | Verdict | Target Path | Why |
|---|---|---|---|---|---|
| `src/deploy/hack.ts` | Timed hack worker with `additionalMsec` + loopingMode | thin workers (hack) | **KEEP** | `src/workers/hack.ts` | Already RAM-efficient timing logic; matches design |
| `src/deploy/grow.ts` | Timed grow worker with `additionalMsec` + loopingMode | thin workers (grow) | **KEEP** | `src/workers/grow.ts` | Same |
| `src/deploy/weaken.ts` | Timed weaken worker with `additionalMsec` support | thin workers (weaken) | **KEEP** | `src/workers/weaken.ts` | Same |
| `src/deploy/auto_grow.ts` | Prep thin worker: loop weaken→grow until min-sec/max-money then exit | prep worker | **KEEP** | `src/workers/auto_grow.ts` | Simple, correct, RAM-lean; preferred over engine/auto_grow.ts |
| `src/deploy/simple_hack_loop.ts` | Sequential H→W→G→W loop for BOOTSTRAP phase | thin workers (BOOTSTRAP) | **KEEP** | `src/workers/simple_hack_loop.ts` | Exactly what design calls for in BOOTSTRAP; already stripped of BFS |
| `src/deploy/share.ts` | `ns.share()` loop for faction rep boost | share worker | **KEEP** | `src/workers/share.ts` | Trivially correct |
| `src/deploy/contracts.ts` | Coding contract solver (stock/path/grid/etc algorithms) | standalone utility | **KEEP** | `src/player/contract_solver.ts` | No structural deps; move to player/ as standalone tool |
| `src/engine/config.ts` | HackingConfig class: HWGW params, RAM config, script paths | lib/config | **ADAPT** | `src/lib/config.ts` | Good structure but mixes HWGW with general config; needs single flat config |
| `src/engine/allocator.ts` | Thread bin-packing allocator (splittable + non-splittable) | HWGW batcher | **ADAPT** | `src/compute/allocator.ts` | Core algorithm is sound; utilization-aware sorting is good; minor cleanup only |
| `src/engine/batch_hack_manager.ts` | Batch orchestrator: calculate strategies, schedule+execute batches | HWGW batcher | **ADAPT** | `src/compute/hwgw_batcher.ts` | Heavy but contains timing math; needs port-bus integration and cleanup |
| `src/engine/batch_util.ts` | Utility functions: getAvailableServers, getTargetServers, isServerPrepared, status panels | coordinator/lib | **ADAPT** | merge into `src/lib/servers.ts` + `src/compute/coordinator.ts` | Useful helpers but scattered; consolidate server queries into lib/servers |
| `src/engine/exec_multi.ts` | Script execution helpers: execMulti, distributeExecution, getMaxThreads | coordinator/spreader | **ADAPT** | `src/compute/exec_multi.ts` | Solid primitives; keep but trim `ensureScriptExists` (already in lib/script) |
| `src/engine/formulas.ts` | FormulaHelper: wraps ns.formulas.* with fallbacks when Formulas.exe absent | HWGW batcher | **KEEP** | `src/compute/formulas.ts` | Clean fallback pattern; exact design requirement |
| `src/engine/ram_manager.ts` | RamManager class: track + reserve RAM across botnet | coordinator/scheduler | **ADAPT** | merge into `src/compute/coordinator.ts` | Good RAM accounting; integrate with port bus rather than standalone class |
| `src/engine/server_manager.ts` | ServerTargetManager: rank and refresh hack targets | targetSelector | **ADAPT** | `src/compute/target_selector.ts` | Class structure is fine; scoring imports lib/server (consolidate) |
| `src/engine/thread_manager.ts` | ThreadDistributionManager: schedule ops with timing, track active/scheduled | coordinator/scheduler | **ADAPT** | `src/compute/scheduler.ts` | Scheduling infrastructure reusable; needs bus integration |
| `src/engine/auto_grow.ts` | AutoGrowManager class: orchestrate prep across multiple targets | — | **ABANDON** | — | Duplicates `deploy/auto_grow.ts` functionality with extra complexity; thin-worker approach is cleaner |
| `src/lib/network.ts` | BFS scan, findAllServers, serverExists, getServerPath, isSingleInstance | lib/servers | **ADAPT** | `src/lib/servers.ts` | Core BFS is correct; add server cache + resetCaches() per design |
| `src/lib/format.ts` | formatRam, shortNumber, formatMoney, formatPercent, formatTime, pad, padNum | lib/format | **ADAPT** | `src/lib/format.ts` | Hand-rolled formatters; design says use `ns.formatNumber` for numbers — update to wrap ns.formatNumber |
| `src/lib/server.ts` | calculateServerValue, calculateWeakenThreads, calculateGrowThreads, getHackableServers | lib/servers + targetSelector | **ADAPT** | merge into `src/lib/servers.ts` | Scoring + thread-calc belong in lib/servers; scoring formula is primitive (needs $/s model) |
| `src/lib/script.ts` | copyScripts, ensureScriptExists, distributeThreads | lib utility | **KEEP** | `src/lib/script.ts` | Clean primitives; already correct |
| `src/lib/connect.ts` | traverse, autoConnect, checkOwnSF | lib utility | **KEEP** | `src/lib/connect.ts` | checkOwnSF is needed by stock/config; traverse used by backdoor |
| `src/lib/types.ts` | CrimeType, GymType, UniversityClassType, CrimeStats type definitions | player types | **KEEP** | `src/lib/types.ts` | Correct; keep in lib |
| `src/monitor/game_agent.ts` | File-relay MCP bridge: reads .cmd.json, executes NS commands, writes .result.json, mirrors ports 3/4 | TOOLCHAIN / notification bus | **KEEP** | `src/cross/game_agent.ts` | Critical MCP bridge; working; keep as-is, reclassify as cross/ |
| `src/monitor/boot_agent.ts` | Port-IPC relay daemon: port 1 → exec/kill/ps → port 2; monitors heartbeat port 3 | notification bus | **ADAPT** | `src/cross/boot_agent.ts` | Good port-IPC foundation; evolve toward named-port notification bus |
| `src/monitor/reporter.ts` | Temp snapshot script: player/RAM/process/port data → status/ files, then exits | monitor/UI dashboard | **ADAPT** | `src/cross/reporter.ts` | Pattern is correct (temp script frees RAM); needs dashboard redesign |
| `src/monitor/strategy_agent.ts` | Autonomous brain: 5-phase detection + strategy execution, heartbeat, port decisions | phaseDetector + coordinator | **ADAPT** | split → `src/cross/phase_detector.ts` + `src/compute/coordinator.ts` | Phase state machine logic is valuable (BOOTSTRAP→SNOWBALL→EXPANSION→PREPARATION→BATCH); split: phase detection → cross/, strategy execution → compute/ |
| `src/tools/scan_nuke.ts` | BFS scan + nuke all reachable servers, single-instance guard | spreader/rooter | **KEEP** | `src/compute/spreader.ts` | Clean, efficient, correct |
| `src/tools/hacknet.ts` | Hacknet upgrade manager: ROI-based buy/upgrade, hash-server aware | hacknetManager | **ADAPT** | `src/compute/hacknet_manager.ts` | Logic is solid; needs phase/config integration and isSingleInstance import |
| `src/tools/purchase_server.ts` | Buy/upgrade pservs with budget-aware power-of-2 RAM logic | pservManager | **ADAPT** | `src/compute/pserv_manager.ts` | Power-of-2 upgrade logic is good; add time-decay budget and merge upgrade_home |
| `src/tools/upgrade_home.ts` | Home RAM+cores upgrader via Singularity RAM-dodge | pservManager | **ADAPT** | merge into `src/compute/pserv_manager.ts` | Merge with purchase_server; both do infra buying |
| `src/tools/port_openers.ts` | Buy TOR + port openers via Singularity RAM-dodge | programAcquirer | **ADAPT** | `src/player/program_acquirer.ts` | Use lib/nsDodge instead of simple_through_file; merge with backdoor |
| `src/tools/simple_through_file.ts` | RAM-dodge via temp script files: write script, run, read output | lib/nsDodge | **ADAPT** | `src/lib/ns_dodge.ts` | THIS IS the RAM-dodge primitive; relocate from tools/ to lib/, expose as `executeCommand`/`getNsData` |
| `src/tools/clean.ts` | Delete .js files on current server, self-deleting utility | ABANDON | **ABANDON** | — | Debug/deploy utility; not part of runtime system |
| `src/contracts/batch_hack.ts` | Main HWGW orchestrator: prep servers, schedule batches, run maintenance (nuke/pserv/hacknet) | coordinator/scheduler | **ADAPT** | `src/compute/coordinator.ts` | This becomes the coordinator; split maintenance tasks to their own modules |
| `src/contracts/crime.ts` | Auto-crime: build crime ladder, train stats, commit crimes via Singularity | crime/train/travel | **ADAPT** | `src/player/crime.ts` | Logic is correct; swap simple_through_file for lib/nsDodge |
| `src/contracts/faction.ts` | Faction work: find optimal faction/aug target, work for rep via Singularity | factionManager + workManager | **ADAPT** | `src/player/faction_manager.ts` | Good logic; swap RAM-dodge lib; split faction join from work |
| `src/contracts/goto.ts` | Terminal nav: connect to server matching regex | utility | **KEEP** | `src/player/goto.ts` | Useful tool; keep as-is |
| `src/contracts/stock.ts` | Stock trading entry point: init + run StockMarket + StockTrader loop | stockEngine (entry) | **ADAPT** | `src/stock/main.ts` | Wire into phase system; currently standalone |
| `src/contracts/backdoor.ts` | Backdoor service: prioritize story/corp servers, install via Singularity | programAcquirer | **ADAPT** | `src/player/program_acquirer.ts` | Merge with port_openers; both are programAcquirer duties |
| `src/stock/stock.ts` | Stock data model: forecast, position, expectedReturn, timeToCoverSpread | stockEngine | **KEEP** | `src/stock/stock.ts` | Solid, tested model |
| `src/stock/market.ts` | StockMarket: refresh data, cycle detection, buy/sell, position sizing | stockEngine | **KEEP** | `src/stock/market.ts` | Pre-4S + 4S handling is good |
| `src/stock/trader.ts` | StockTrader: manage positions, execute buy/sell, trailing stop, 4S API buying | stockEngine | **KEEP** | `src/stock/trader.ts` | Well-structured |
| `src/stock/forecast.ts` | ForecastHelper: historical volatility + forecast estimate without 4S | stockEngine | **KEEP** | `src/stock/forecast.ts` | Solid estimation |
| `src/stock/config.ts` | StockConfig: all trading params, checkOwnSF for short-selling detection | stockEngine / lib/config | **ADAPT** | `src/stock/config.ts` | Keep separate; it reads SF via connect.ts, which is correct |
| `src/info/servers.ts` | Print purchased server RAM info | ABANDON | **ABANDON** | — | Debug one-liner; not runtime code |
| `src/info/augmentations.ts` | List augmentations by faction with rep/price, optionally purchase | augPlanner (seed) | **ADAPT** | `src/player/aug_planner.ts` | Has the data-gathering logic; needs full planner (optimal order, budget) |
| `src/info/script_ram.ts` | Print RAM costs for scripts (checks stale 'remote/*.js' paths) | ABANDON | **ABANDON** | — | Wrong paths; debug utility |
| `src/types/ns-augment.d.ts` | Type augmentation for @ns: adds getPurchasedServers, formatNumber, etc. | KEEP | **KEEP** | `src/types/ns-augment.d.ts` | Required for correct compilation |
| `src/template.ts` | Test/template file exercising executeCommand | ABANDON | **ABANDON** | — | Template only |
| `src/experiment.tsx` | Excluded from tsconfig, unused | ABANDON | **ABANDON** | — | Already excluded |
| `build/game-bridge.ts` | WebSocket bridge (port 12525): file-sync dist/→game + REPL | TOOLCHAIN/KEEP | **KEEP** | `build/game-bridge.ts` | Custom bridge already working; not replacing with viteburner |
| `build/game-bridge-mcp/src/index.ts` | MCP server: bridges Claude to game via admin port 12526 | TOOLCHAIN/KEEP | **KEEP** | `build/game-bridge-mcp/src/index.ts` | MCP integration is the Claude→game link |
| `build/config.js` | Bridge configuration (dist dir, allowed filetypes) | TOOLCHAIN/KEEP | **KEEP** | `build/config.js` | |
| `build/init.js` | Initialization script for watch system | TOOLCHAIN/KEEP | **KEEP** | `build/init.js` | |
| `build/watch.js` | File watcher for local sync | TOOLCHAIN/KEEP | **KEEP** | `build/watch.js` | |

---

## 2. Duplicates / Residue (Single-Source-of-Truth Violations)

### A. BFS scan — 4 implementations
- `src/lib/network.ts` — `scanNetwork()` generator (canonical)
- `src/monitor/strategy_agent.ts` — `findAllServers()` inline (duplicate)
- `src/monitor/reporter.ts` — `scanAll()` inline (duplicate)
- `src/deploy/contracts.ts` — `scanServerBFS()` inline (duplicate)

**Action:** All non-lib copies were inlined to save import RAM at the time of writing. Post-migration, replace all inline copies with `lib/servers.ts` import (or keep inline if the RAM cost of the lib import is measurable in a tight script).

### B. Server prep logic — 3 implementations
- `src/deploy/auto_grow.ts` — thin worker loop (KEEP, canonical)
- `src/engine/auto_grow.ts` — `AutoGrowManager` class (ABANDON, superseded)
- `src/contracts/batch_hack.ts` — `prepareServers()` inline (migrate to coordinator)

**Action:** Keep only the thin-worker approach; delete `engine/auto_grow.ts`; coordinator calls workers directly.

### C. RAM format — 2 implementations
- `src/lib/format.ts` — `formatRam()` (canonical)
- `src/engine/server_manager.ts` — `formatRamGb()` (duplicate, slightly different output)

**Action:** Delete `formatRamGb` from server_manager; import from lib/format.

### D. Port numbers — no named constants, magic numbers everywhere
- Port 1: boot_agent command in; Port 2: boot_agent result out; Port 3: heartbeat (strategy→boot); Port 4: decisions (strategy→game_agent/reporter)
- Scattered across `monitor/boot_agent.ts`, `monitor/strategy_agent.ts`, `monitor/reporter.ts`, `monitor/game_agent.ts`

**Action:** Create `src/lib/ports.ts` with named constants before anything else.

### E. RAM-dodge — present but misplaced
- `src/tools/simple_through_file.ts` — `executeCommand<T>()` (functional, correct)
- Used by: `src/contracts/crime.ts`, `src/contracts/faction.ts`, `src/tools/port_openers.ts`, `src/tools/upgrade_home.ts`, `src/template.ts`
- Not in lib/ — it's in tools/ which makes it harder to import cleanly

**Action:** Move to `src/lib/ns_dodge.ts`. Also check: `src/contracts/backdoor.ts` calls `ns.singularity.installBackdoor()` directly (not RAM-dodged) — this is the high-RAM call, needs dodge.

### F. Server availability queries — 2 overlapping implementations
- `src/engine/batch_util.ts` — `getAvailableServers()` (returns servers + rams + allocs)
- `src/engine/ram_manager.ts` — `updateRamInfo()` (builds same list internally)

**Action:** Consolidate into one place in `lib/servers.ts` or `compute/coordinator.ts`.

### G. Configuration split
- `src/engine/config.ts` — `HackingConfig` class (HWGW + RAM + script paths)
- `src/stock/config.ts` — `StockConfig` class
- No central config file

**Action:** Create `src/lib/config.ts` with phase boundaries, global thresholds. Keep stock config separate. Extract HWGW params into `src/compute/hwgw_config.ts` or merge into lib/config.

### H. Phase detection — embedded in strategy_agent, not a standalone module
- `src/monitor/strategy_agent.ts` has `detectPhase()`, `GameState`, `Phase` enum, stability hysteresis — all good
- But it's coupled to `executeActions()`, heartbeat, decision logging, deployment — cannot be imported separately

**Action:** Extract phase detection into `src/cross/phase_detector.ts` that publishes to port bus. Strategy execution moves to coordinator.

---

## 3. Toolchain Finding

### Build system: custom WebSocket bridge (NOT viteburner)

**Stack:**
```
TypeScript (src/) 
  → tsc -w → dist/          [typescript@^6.0.3, tsc watch]
  → build/watch.js           [chokidar file watcher, pushes dist/ changes locally]
  → build/game-bridge.ts     [WebSocket server port 12525, JSON-RPC, pushes to game]
  → game (/home/)
```

**MCP integration:**
```
Claude (MCP client)
  → build/game-bridge-mcp/src/index.ts  [MCP server, StdioServerTransport]
  → WebSocket admin port 12526
  → game-bridge.ts proxies RPC → game
```

**`pnpm run watch`** starts three concurrent processes:
1. `tsc -w` — TypeScript compile with watch
2. `node build/watch.js` — local file sync
3. `tsx build/game-bridge.ts` — bridge daemon

**Key finding:** This is NOT viteburner. It is a hand-rolled system equivalent to `bitburner-filesync`. The bridge is custom but proven working. There is no plan to replace it — it already serves as the MCP gateway.

### RAM-dodge primitive status

`src/tools/simple_through_file.ts` — `executeCommand<T>(ns, commandString)`:
- Writes a temp `.js` script to `/tmp/<timestamp>.js`
- Executes it with `ns.run()`
- Reads output from `/tmp/<timestamp>.txt`
- Cleans up both files
- Handles special values (Infinity, NaN, undefined) via custom JSON reviver

This IS the `getNsDataThroughFile` pattern (alainbryden-style). It's working and tested. The only issue: it lives in `tools/` not `lib/`. No other RAM-dodge primitive exists.

**Notable:** `src/monitor/game_agent.ts` provides a *second* RAM-dodge pathway (file-based command relay for MCP), but it's for Claude↔game, not for in-game singularity calls.

---

## 4. Migration Notes

### Import style
- All files: `import { NS } from '@ns'` via tsconfig path alias — keep this
- ESM modules (`"type": "module"` in package.json) — keep
- No barrel exports (index.ts files) — files import each other directly by path
- Path alias `@ns` is the only alias used in active code

### Naming conventions currently used
- **Files:** `snake_case.ts` (e.g., `batch_hack_manager.ts`, `simple_through_file.ts`)
- **Classes:** PascalCase (e.g., `BatchHackManager`, `StockMarket`, `RamManager`)
- **Functions:** camelCase (e.g., `findAllServers`, `calculateServerValue`)
- **Constants:** SCREAMING_SNAKE or camelCase depending on scope

### @ns types
- `src/types/ns-augment.d.ts` adds `getPurchasedServers()`, `formatNumber()`, etc. — MUST keep
- `NetscriptDefinitions.d.ts` at root is the game's type definitions — MUST keep

### RAM awareness
- `strategy_agent.ts` runs on non-home servers (e.g., foodnstuff) — tight RAM budget; inlining BFS was intentional
- `simple_through_file.ts`/ns_dodge calls each spawn a temp script for ~0.4s — not free
- Worker scripts (hack/grow/weaken) at 1.75 GB each — already minimal
- `contracts/backdoor.ts` calls `ns.singularity.*` directly (no RAM-dodge) — this inflates RAM; will need dodge in new design

### Missing modules (new design, not yet started)
- `lib/ports.ts` — does not exist; port numbers are magic literals
- `lib/nsDodge.ts` — exists as `tools/simple_through_file.ts`, needs relocation
- `lib/config.ts` — partial (engine/config.ts covers HWGW; no global config)
- `phaseDetector` as standalone — phase logic embedded in strategy_agent
- Port bus protocol (register/lock/event) — not implemented at all
- `stockEngine` integration with phase system — stock runs standalone

### Phase mapping (existing → design)
Current `strategy_agent.ts` phases map to design phases as:
| Existing | Design |
|---|---|
| BOOTSTRAP | BOOTSTRAP |
| SNOWBALL | EARLY (partial) |
| EXPANSION | EARLY (continued) |
| PREPARATION | MID (prep phase) |
| BATCH | MID (HWGW active) |

The existing phase detector does not cover LATE or RESET. It uses `homeMaxRam <= 16` and `rootedCount < 5` as boundaries rather than the design's tunable constants in lib/config.

### Key risk: strategy_agent.ts does too much
It handles phase detection, server scanning, worker deployment, batch launch, port openers intent logging, and heartbeating — all in one 600-line script. Migration benefit: split these concerns cleanly.
