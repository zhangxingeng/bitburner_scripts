# Codebase Restructuring Plan

**Status:** `ready to build`

## Problem

The codebase has accumulated significant technical debt through organic growth: duplicated utility code (3 parallel util files for different RAM tiers), ambiguous folder naming (`less_used/`, `basic/`), inconsistent patterns (classes vs inline functions), monolithic scripts (908-line `batch_hack.ts`), and duplicate implementations of the same logic (`isServerPrepared` exists 4×, `findBestWorkType` exists 2×, `calculateServerValue` exists 3×). There is no clear contract between library code and executable scripts — everything lives under `src/` in loosely-named folders.

53 source files across 8 folders, with no test infrastructure and disabled lint rules (`no-unused-vars` is off), making it easy for dead code to accumulate unnoticed.

## Root cause

1. **RAM-based file organization** (`util_low_ram.ts` / `util_normal_ram.ts` / `util_high_ram.ts`) was the original design intent — Bitburner charges in-game RAM per function. But the RAM difference between async and sync BFS is negligible compared to the maintenance cost of maintaining two near-identical copies of 15+ functions.
2. **No refactoring pass** after extracting `hack_lib/` classes from the monolithic `batch_hack.ts` — both the old inline version and the new class version still exist.
3. **No lifecycle for experimental code** — `less_used/` is an ambiguous dumping ground with no signal about what's maintained vs deprecated.
4. **Mixed JS/TS** — `purchase_server.js` (122 lines) and `purchase_server.ts` (287 lines) coexist because the JS version has lower RAM overhead in early game.

## Approach

### Phase 1: Library merge (highest impact, changes 0 imports)

Merge the 3 utility files into functionally-named modules. This is pure consolidation — no import paths change yet.

**`lib/network.ts`** ← `util_normal_ram.ts` scan functions (sync, the simpler implementation)
- `scanNetwork`, `findAllPaths`, `findAllServers`, `getServerPath`, `getPaths`, `serverExists`, `regexMatch`

**`lib/format.ts`** ← identical formatting functions from either util file
- `formatRam`, `formatMoney`, `shortNumber`, `formatPercent`, `formatTime`, `pad`, `padNum`

**`lib/server.ts`** ← `util_normal_ram.ts` server functions (sync, direct NS calls)
- `calculateServerValue`, `calculateWeakenThreads`, `calculateGrowThreads`, `calculateHackThreads`, `getHackableServers`

**`lib/connect.ts`** ← `util_high_ram.ts`
- `traverse`, `autoConnect`, `checkOwnSF`

**`lib/script.ts`** ← `utils_extra.ts` + `isSingleInstance` from `util_low_ram.ts`
- `copyScripts`, `ensureScriptExists`, `distributeThreads`, `isSingleInstance`

**`lib/types.ts`** ← `ns_types.ts` (unchanged, just relocated)

### Phase 2: Rename folders (changes folder names, not contents)

| Old path | New path | Reason |
|----------|----------|--------|
| `hack_lib/` | `engine/` | Shorter, clearer — it's the hacking engine |
| `stock_lib/` | `stock/` | Redundant suffix, only stock code lives there |
| `basic/` | `tools/` | "Tools" communicates intent better than "basic" |
| `remote/` | `deploy/` | "Deploy" captures what happens to these scripts |
| `less_used/` | `archive/` | Clear lifecycle signal — not maintained |

File renames within folders (shorter names, still self-documenting):

| Old | New |
|-----|-----|
| `engine/hack_config.ts` | `engine/config.ts` |
| `engine/server_target_manager.ts` | `engine/server_manager.ts` |
| `engine/thread_distribution_manager.ts` | `engine/thread_manager.ts` |
| `stock/stock_config.ts` | `stock/config.ts` |
| `stock/stock_market.ts` | `stock/market.ts` |
| `stock/stock_trader.ts` | `stock/trader.ts` |
| `stock/forecast_helper.ts` | `stock/forecast.ts` |
| `tools/basic_hacknet.ts` | `tools/hacknet.ts` |
| `tools/buy_port_opener.ts` | `tools/port_openers.ts` |
| `tools/upgrade_home_server.ts` | `tools/upgrade_home.ts` |
| `tools/remove_all_files.ts` | `tools/clean.ts` |
| `deploy/solve-contracts.ts` | `deploy/contracts.ts` |
| `info/print_augs.ts` | `info/augmentations.ts` |
| `info/print_script_ram.ts` | `info/script_ram.ts` |
| `info/print_server_stat.ts` | `info/servers.ts` |

### Phase 3: Move top-level scripts

Top-level executable scripts (those with `main()`) move to grouped folders:

| Old | New | Rationale |
|-----|-----|-----------|
| `batch_hack.ts` | `contracts/batch_hack.ts` | Orchestration script |
| `mid_game_hack.ts` | `contracts/midgame_hack.ts` | Orchestration script |
| `start_hack.ts` | `contracts/start_hack.ts` | Launcher |
| `auto_crime.ts` | `contracts/crime.ts` | Orchestration script |
| `auto_faction.ts` | `contracts/faction.ts` | Orchestration script |
| `stockmaster.ts` | `contracts/stock.ts` | Orchestration script |
| `backdoor_all.ts` | `contracts/backdoor.ts` | Orchestration script |
| `goto.ts` | `contracts/goto.ts` | Utility, but has `main()` |
| `lib/autonuke.ts` | `tools/autonuke.ts` | Has `main()`, belongs with other tools |
| `lib/scan_nuke.ts` | `tools/scan_nuke.ts` | Has `main()`, belongs with other tools |

`template.ts` stays at root for discoverability (it's the entry point for creating new scripts).

### Phase 4: Delete and archive

- **Delete** `purchase_server.js` — `purchase_server.ts` is the canonical version. Update `batch_hack.ts` and `mid_game_hack.ts` to reference the `.ts` path.
- **Soft-delete** old util files to `.old_code/` (per coding principles § soft-delete convention): `util_low_ram.ts`, `util_normal_ram.ts`, `util_high_ram.ts`, `utils_extra.ts`, `ns_types.ts`
- **Keep** `archive/` contents as-is (already deprecated/experimental)

### Phase 5: Update all imports

Every file that imported from the old paths gets its imports updated. This is the bulk of the work — approximately 25-30 files need import path updates. Key mappings for import updates:

| Old import | New import |
|------------|------------|
| `'./lib/util_low_ram'` | `'../lib/format'` or `'../lib/network'` or `'../lib/server'` |
| `'./lib/util_normal_ram'` | `'../lib/format'` or `'../lib/network'` or `'../lib/server'` |
| `'./lib/util_high_ram'` | `'../lib/connect'` |
| `'./lib/utils_extra'` | `'../lib/script'` |
| `'./hack_lib/*'` | `'../engine/*'` |
| `'./stock_lib/*'` | `'../stock/*'` |
| `'./basic/*'` | `'../tools/*'` |

### Phase 6: Verify

Run `npx tsc --noEmit` to verify all imports resolve and types are correct. Fix any residual issues.

## What does NOT change

- **Script contents** — this is pure reorganization, no logic changes (except deduplication of the merged util files)
- **`deploy/` scripts** — these are self-contained workers that run on remote servers; they import only `@ns`
- **`stock/` class internals** — already well-structured, only folder/file names change
- **`auto_crime.ts` and `auto_faction.ts`** — well-structured internally, only location and imports change
- **`simple_through_file.ts`** — the bridge mechanism stays; it's necessary for low-RAM environments
- **`experiment.tsx`** — React experiment stays where it is (it's a UI experiment, not a contract)

## Open decisions

1. **`contracts/` vs `scripts/`**: Which folder name better communicates "executable orchestration scripts"? `contracts` is Bitburner terminology but may not be obvious to readers who don't play the game. `scripts` is more generic but overlaps with the Bitburner concept of "scripts you run."

2. **Where to put `info/` scripts**: Currently `print_augs.ts`, `print_script_ram.ts`, `print_server_stat.ts` are top-level display scripts. They could go in `contracts/`, `tools/`, or stay as a separate `info/` folder. They're read-only display tools, distinct from both orchestration contracts and server tools.

3. **`purchase_server.ts` location**: Currently in `tools/` (it's a utility), but `batch_hack.ts` and `mid_game_hack.ts` exec it as a subprocess. Keep in `tools/` or move to `contracts/`?

4. **`engine/batch_hack_manager.ts` vs `contracts/batch_hack.ts`**: The `batch_hack_manager.ts` class (634 lines) duplicates much of the standalone `batch_hack.ts` (908 lines). Should we remove the class and keep only the standalone script? Or keep both and mark the class as the canonical implementation? The class is imported by `batch_hack_manager.ts` but the current `batch_hack.ts` doesn't use the class — it reimplements the logic inline. This is identified as a future cleanup item, not part of this restructuring.

## Verify

- `npx tsc --noEmit` passes with zero errors
- Every import path resolves to an existing file
- No file references a deleted path (check `purchase_server.js` references)
- The `.old_code/` directory exists with the legacy util files
- `git status` shows the expected set of renames, deletions, and new files
