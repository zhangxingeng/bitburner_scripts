# S1 Build Spec — Code Cleanup

**Source:** `docs/continuous_improvement.md` Section 4.7 (Consolidation Plan) + Section 4.8 (S1 row)

---

## 1. Files to Remove — Importer Verification

All three files confirmed **zero importers** across the entire `src/` tree.

### 1a. `src/monitor/status_reporter.ts`

- **Grep `status_reporter` across `src/`:** Only match is self-referencing doc comment at line 10.
- **Verdict:** Zero importers. Safe to remove.
- **RAM cost kept in mind:** ~3.5 GB from `getPlayer`, `getServerMaxRam`, `getServerUsedRam`, `ps`. The strategy agent replaces its role with `ns.getServer()` (0.3 GB) + `ns.getPlayer()` (0.3 GB) — lighter and more targeted.

### 1b. `src/contracts/midgame_hack.ts`

- **Grep `midgame_hack` across `src/`:** No matches.
- **Verdict:** Zero importers. Safe to remove.
- **Note:** Contains its own local `calculateServerValue()` (signature: `(maxMoney, minSecurity, requiredLevel, hackChance) => number`) at line 268 — entirely different from the two `ns`-based versions in `lib/server.ts` and `batch_util.ts`. This local version is not imported anywhere and will be removed along with the file.

### 1c. `src/contracts/start_hack.ts`

- **Grep `start_hack` across `src/`:** No matches.
- **Verdict:** Zero importers. Safe to remove.
- **Note:** Thin launcher file (75 lines). References `game_agent.js`, `cross_server_hack.js`, `share_farm.js` — dead scripts in the current architecture, superseded by the strategy agent.

---

## 2. `calculateServerValue()` — Diff Between Two Versions

There are exactly **two active** duplicative versions (the `midgame_hack.ts` one is removed along with that file):

### Version A: `src/lib/server.ts` lines 5–12 (IMPORTED by `server_manager.ts`)

```typescript
export function calculateServerValue(ns: NS, target: string): number {
    const maxMoney = ns.getServerMaxMoney(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const hackChance = ns.hackAnalyzeChance(target);
    const hackTime = ns.getHackTime(target);

    return maxMoney * (1 / (minSecurity + 1)) * (1 / (hackTime / 1000 + 1)) * hackChance;
}
```

**Formula:** `moneyScore * securityScore * timeScore * chanceScore`
**Missing:** `growthFactor` — not read at all.

### Version B: `src/engine/batch_util.ts` lines 26–43 (USED internally by `getTargetServers()`)

```typescript
export function calculateServerValue(ns: NS, target: string): number {
    const maxMoney = ns.getServerMaxMoney(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const hackChance = ns.hackAnalyzeChance(target);
    const hackTime = ns.getHackTime(target);
    const growthFactor = ns.getServerGrowth(target);

    const moneyScore = maxMoney;
    const securityScore = 1 / (minSecurity + 1);
    const timeScore = 1 / (hackTime / 1000 + 1);
    const chanceScore = hackChance;
    const growthScore = growthFactor / 100;

    const score = moneyScore * securityScore * timeScore * chanceScore * growthScore;
    return score;
}
```

**Formula:** `moneyScore * securityScore * timeScore * chanceScore * growthScore`
**Extra:** `growthFactor` read via `ns.getServerGrowth(target)`, then `growthScore = growthFactor / 100`.

### Identical lines (byte-for-byte match):
- `const maxMoney = ns.getServerMaxMoney(target);`
- `const minSecurity = ns.getServerMinSecurityLevel(target);`
- `const hackChance = ns.hackAnalyzeChance(target);`
- `const hackTime = ns.getHackTime(target);`
- `const securityScore = 1 / (minSecurity + 1);`
- `const timeScore = 1 / (hackTime / 1000 + 1);`
- `const chanceScore = hackChance;`
- `const moneyScore = maxMoney;`

### Diff:
Version B adds five lines (growth factor + growthScore), and the final score multiplies by `growthScore`:
```diff
+   const growthFactor = ns.getServerGrowth(target);
+   const growthScore = growthFactor / 100;
+
-   return moneyScore * securityScore * timeScore * chanceScore;
+   const score = moneyScore * securityScore * timeScore * chanceScore * growthScore;
+   return score;
```

### Callers of each version:

| Version | Imported by | Internal callers |
|---|---|---|
| `lib/server.ts` | `server_manager.ts:53` | — |
| `batch_util.ts` | (none — self-contained) | `batch_util.ts:164,165` (in `getTargetServers()`) |

### Fix needed:
Consolidate into one function. The `batch_util.ts` version is more complete (includes growth factor). Choose ONE approach:

**Option A (recommended — minimal diff):** Update `lib/server.ts` to include growth factor (matching `batch_util.ts`), then change `batch_util.ts` to import and call the `lib/server.ts` version instead of defining its own duplicate. Delete the duplicate definition from `batch_util.ts`.

**Option B (simpler, keeps batch_util.ts as-is):** Update `lib/server.ts` to match `batch_util.ts`, move the import in `server_manager.ts` to `../engine/batch_util` instead of `../lib/server`, then delete `lib/server.ts` entirely. (But `lib/server.ts` also has `calculateWeakenThreads`, `calculateGrowThreads`, `calculateHackThreads`, `getHackableServers` — so it shouldn't be deleted.)

**Recommendation: Option A.** Keep `lib/server.ts` as the canonical location, update it to include growth factor, and make `batch_util.ts` delegate to it.

---

## 3. `server_manager.ts` — Hardcoded Thresholds

### Current code (`src/engine/server_manager.ts` lines 83–97):

```typescript
isServerPrepared(target: string): boolean {
    const moneyThreshold = 0.9;   // hardcoded
    const securityThreshold = 3;  // hardcoded

    const server = this.ns.getServer(target);
    const currentMoney = server.moneyAvailable || 0;
    const maxMoney = server.moneyMax || 1;
    const currentSecurity = server.hackDifficulty || 100;
    const minSecurity = server.minDifficulty || 1;

    return (
        currentMoney >= maxMoney * moneyThreshold &&
        currentSecurity <= minSecurity + securityThreshold
    );
}
```

### Values already exist in `src/engine/config.ts`:

```typescript
// HackingConfig class, lines 96-103
readonly targetingConfig = {
    maxTargets: 4,
    moneyThreshold: 0.9,      // same value
    securityThreshold: 3,      // same value
};
```

### Current `ServerTargetManager` constructor (line 20):

```typescript
constructor(ns: NS) {
    this.ns = ns;
    this.formulas = new FormulaHelper(ns);
    this.refreshTargets();
}
```

### Fix needed:
1. Add `config?: HackingConfig` parameter to the constructor (optional, to avoid breaking existing callers).
2. Store the thresholds from config, falling back to the current hardcoded defaults if config is not provided.
3. Use `this.moneyThreshold` / `this.securityThreshold` in `isServerPrepared()` instead of local constants.

---

## 4. `batch_hack.ts` — `--homeRam` CLI Argument

### Current state:

`batch_hack.ts` has **NO** `--homeRam` CLI argument handling at all. There is no call to `ns.flags()` or `ns.args` processing for home RAM.

Home RAM reservation is currently handled entirely by `HackingConfig.getHomeRamReservation()` (line 140 of `config.ts`):

```typescript
getHomeRamReservation(ns: NS): number {
    const homeMaxRam = ns.getServerMaxRam('home');
    return Math.max(
        Math.min(
            homeMaxRam * this.ramConfig.homeRamReservePercent,  // 0.25
            this.ramConfig.maxHomeReserve                        // 128 GB
        ),
        this.ramConfig.minHomeReserve                            // 100 GB
    );
}
```

In `batch_hack.ts`, this is called via `config.getHomeRamReservation(ns)` — no CLI override path exists.

The only reference to `homeRam` in `batch_hack.ts` is at line 213:
```typescript
shareRemainingRam(ns, availServers, homeReserved, config.ramConfig.homeRamReservePercent);
```
This passes `homeRamReservePercent` (0.25) as the `maxShareFraction` parameter — completely unrelated to overriding the home reservation value.

### Fix needed:
Add `ns.flags()` parsing in `batch_hack.ts` `main()`:

```typescript
const args = ns.flags([
    ['homeRam', config.ramConfig.minHomeReserve],  // override for minHomeReserve
]);
const homeRamOverride = args['homeRam'] as number;
```

Then override `config.ramConfig`:
```typescript
if (homeRamOverride !== config.ramConfig.minHomeReserve) {
    // Override: adjust the config's minHomeReserve with the CLI value
}
```

**Problem:** `HackingConfig.ramConfig` is `readonly`. The config class needs to either:
- Make `ramConfig` fields mutable, or
- Add a `setHomeRamReservation(n: number)` method, or
- Accept the value as a parameter to `getHomeRamReservation()`.

**Recommendation:** Add `setHomeRamOverride(n: number): void` to `HackingConfig` that sets an internal `homeRamOverride` field. `getHomeRamReservation()` checks it: if set, returns `homeRamOverride` directly (skipping the percentage/min/max computation). Otherwise uses the existing logic.

---

## 5. File Inventory — Exact Paths and Line Numbers

### Remove files (delete entire file):

| # | Path | Lines | Reason |
|---|---|---|---|
| R1 | `src/monitor/status_reporter.ts` | 1-129 | Zero importers. Superseded by strategy_agent. |
| R2 | `src/contracts/midgame_hack.ts` | 1-539 | Zero importers. Superseded by strategy engine + batch_hack. Contains dead local `calculateServerValue()` at line 268. |
| R3 | `src/contracts/start_hack.ts` | 1-75 | Zero importers. Thin launcher replaced by strategy_agent. |

### Modify files:

| # | File | Lines | Change |
|---|---|---|---|
| M1 | `src/lib/server.ts` | 5-12 | Add `growthFactor` to `calculateServerValue()`: read `ns.getServerGrowth(target)`, compute `growthScore = growthFactor / 100`, multiply into final score. Match the `batch_util.ts` formula exactly. |
| M2 | `src/engine/batch_util.ts` | 26-43 | Delete duplicate `calculateServerValue()` function body. Replace with an import from `'../lib/server'` and re-export. Then verify `getTargetServers()` (lines 163-165) still calls it correctly. |
| M3 | `src/engine/server_manager.ts` | 20 (constructor), 83-97 (isServerPrepared) | Add optional `config?: HackingConfig` param to constructor. Store `config?.targetingConfig.moneyThreshold ?? 0.9` and `...securityThreshold ?? 3` as instance fields. Use them in `isServerPrepared()` instead of hardcoded local consts. |
| M4 | `src/engine/config.ts` | 140-150 | Add `private homeRamOverride: number | undefined` field + `setHomeRamOverride(n: number): void` method. Update `getHomeRamReservation()` to return `homeRamOverride` if set. |
| M5 | `src/contracts/batch_hack.ts` | ~141 (inside main()) | Add `ns.flags()` parsing for `--homeRam`. Call `config.setHomeRamOverride()` if CLI value differs from default. |

### Files NOT touched (verified no change needed):

| Path | Reason |
|---|---|
| `src/engine/server_manager.ts:3` | Import of `calculateServerValue` stays — only the implementation in `lib/server.ts` changes, not the import path. |
| `src/engine/server_manager.ts:53` | Call to `calculateServerValue(this.ns, target)` stays — signature doesn't change. |
| `src/lib/script.ts` | Verified active (imported by `thread_manager.ts` and `exec_multi.ts`). **KEEP.** |

### Summary of change count:

- **3 file deletions** (R1, R2, R3)
- **5 file modifications** (M1, M2, M3, M4, M5)
- **0 new files** (cleanup-only S1)

### Post-cleanup verification:

After all changes, run these checks:

1. **No remaining duplicates of `calculateServerValue`:**
```
grep -rn "calculateServerValue" src/ --include='*.ts'
```
Expected: 2 occurrences — one definition in `lib/server.ts`, one import in `server_manager.ts`. (The duplicate in `batch_util.ts` and the local one in `midgame_hack.ts` should both be gone.)

2. **No remaining references to deleted files:**
```
grep -rn "status_reporter\|midgame_hack\|start_hack" src/ --include='*.ts'
```
Expected: 0 matches.

3. **Build succeeds:** Run `pnpm run build` or the project's compile command to verify no broken imports.
