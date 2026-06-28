# Audit Report: Wave 4 Implementation Order & Code Cleanup Plan

**Auditor:** Cold Auditor  
**Date:** 2026-06-28  
**Scope:** Sections 4.7 (Code Cleanup) and 4.8 (Implementation Order) of `continuous_improvement.md`

---

## 1. Code Cleanup Verification

### 1.1 File: `src/monitor/status_reporter.ts` — Remove

**Plan's claim:** "Superseded by game_agent.ts (which does everything it does + command relay)"

**Verdict: CORRECT.** Comparison confirms:
- `status_reporter.ts` (129 lines): writes player.txt, ram.txt, processes.txt every 5s. Only ps from 'home'.
- `game_agent.ts` (302 lines): writes same three files PLUS command relay (run/exec/kill/killall/ps/getPlayer/getServer). Also ps from ALL servers (not just home), adds `income` field to player snapshot.
- `status_reporter` is a strict subset of `game_agent` in both data and structure.

**Importers found:**
- Grep for `status_reporter` across `src/`: **ZERO imports.** Only self-reference (comment on line 10).

**Runtime references:**
- `start_hack.ts` references `/monitor/game_agent.js` (lines 46-47) — NOT status_reporter.
- `batch_hack.ts` references `/monitor/game_agent.js` (line 24) — NOT status_reporter.

**Will removal break anything?** No. Zero importers, zero runtime references.

**Migration path:** Not needed. `game_agent.ts` already covers all functionality.

**Importers the plan MISSED:** None. Correctly identified.

---

### 1.2 File: `src/contracts/midgame_hack.ts` — Remove

**Plan's claim:** "Duplicates engine logic. The strategy engine replaces its early-game role. batch_hack.ts replaces its late-game role."

**Verdict: CORRECT** (with caveat about timing gap).

**Importers found:**
- Grep for `midgame_hack` across `src/`: **ZERO imports.** No TypeScript file imports this module.

**Runtime references:**
- Only self-references (launch path in `SCRIPTS.batchHack = 'contracts/batch_hack.ts'` at line 77, and `ns.spawn(SCRIPTS.batchHack, 1)` at line 138).
- Its own `SCRIPTS.batchHack` string path (`.ts` extension) is unusual — this would try to `ns.spawn('/contracts/batch_hack.ts', 1)` which is the TypeScript source, not the compiled .js.

**Dependencies that midgame_hack.ts has (these are importers, not importees):**
- `../lib/format` — formatMoney, formatRam (engine still needs this)
- `../lib/network` — findAllServers (engine still needs this)
- `../engine/exec_multi` — execMulti (core engine, not being removed)
- `../engine/formulas` — FormulaHelper (core engine, not being removed)
- **`../lib/script` — ensureScriptExists** (see 1.6 — this creates a removal ordering constraint)

**CRITICAL GAP: midgame_hack.ts has its OWN LOCAL `distributeThreads()` function (line 397-458)**, which is separate from `lib/script.ts`'s `distributeThreads()`. This means midgame_hack's own thread distribution logic is NOT used elsewhere. However, midgame_hack also imports `ensureScriptExists` from `lib/script.ts` — so midgame_hack must be removed BEFORE or SIMULTANEOUSLY with `lib/script.ts`.

**Will removal break anything?** No direct breakage. But it creates a **~4.5-hour gap** (S1 removed, strategy engine not built until S3) where mid-game automation is missing.

**Importers the plan MISSED:** None (zero importers is correct).

---

### 1.3 File: `src/contracts/start_hack.ts` — Remove

**Plan's claim:** "Thin launcher that the strategy agent replaces."

**Verdict: CORRECT.**

**Importers found:**
- Grep for `start_hack` across `src/`: **ZERO imports.** No file imports this module.

**Runtime references:**
- None (no other file references `start_hack`).
- Self-references `/contracts/batch_hack.js` and `/monitor/game_agent.js` for launching.

**Will removal break anything?** No. Zero importers, zero runtime references.

**Migration path:** Not needed — the strategy agent replaces its launcher role.

**Importers the plan MISSED:** None.

---

### 1.4 File: `src/lib/server.ts` calculateServerValue() — Fix

**Plan's claim:** "Missing growth factor — batch_util.ts version includes it, this one doesn't. Duplicate function."

**Verdict: CORRECT.** Detailed comparison:

| Aspect | `lib/server.ts` | `batch_util.ts` | `midgame_hack.ts` (local) |
|--------|----------------|-----------------|---------------------------|
| Factors | maxMoney, 1/(minSecurity+1), 1/(hackTime/1000+1), hackChance | moneyScore, securityScore, timeScore, chanceScore, **growthScore** | (maxMoney/minSecurity) * hackChance |
| Growth factor | **MISSING** | Included: `growthFactor / 100` | **MISSING** |
| Signature | `(ns: NS, target: string)` | `(ns: NS, target: string)` | `(maxMoney, minSecurity, requiredLevel, hackChance)` |
| Weights | Flat multiplication | Named scores, same multiplication | Simpler ratio |

**Importers of `lib/server.ts` calculateServerValue:**
- `src/engine/server_manager.ts` line 3 (import), line 53 (call in `refreshTargets()`)
- `src/contracts/midgame_hack.ts` has its OWN LOCAL version (line 268) — not imported from lib/server.ts

**Users of `batch_util.ts` calculateServerValue:**
- `src/engine/batch_util.ts` itself (lines 164-165 for sorting, self-use)

**Fix direction:**
- Consolidating to `batch_util.ts` version is correct (it has growth factor).
- After removing midgame_hack.ts, its local duplicate disappears automatically.
- `server_manager.ts` currently imports from `lib/server.ts` — this import path must be updated to point to `batch_util.ts`.

**What the plan MISSED:** The plan says "Fix `src/lib/server.ts:calculateServerValue()`" but doesn't specify that `server_manager.ts`'s import path needs updating. The current import chain is `server_manager.ts → lib/server.ts → calculateServerValue`. After fix, should be `server_manager.ts → engine/batch_util.ts → calculateServerValue`.

---

### 1.5 File: `src/engine/server_manager.ts` lines 84-85 — Fix hardcoded thresholds

**Plan's claim:** "moneyThreshold: 0.9 and securityThreshold: 3 hardcoded — should read from config."

**Verdict: CORRECT.**

Lines 84-85:
```typescript
const moneyThreshold = 0.9; // 90% of max money
const securityThreshold = 3; // Within 3 of min security
```

These are hardcoded inside `isServerPrepared()`. Meanwhile:
- `batch_util.ts` has `isServerPrepared()` with configurable defaults (parameters `moneyThreshold = 0.9, securityThreshold = 3`)
- `batch_hack.ts` passes values from config: `config.targetingConfig.moneyThreshold` and `config.targetingConfig.securityThreshold` (lines 79, 100-101)

The server_manager.ts version should accept these as parameters or read from a config object. The `batch_util.ts` pattern (default parameters) is the better pattern.

---

### 1.6 File: `src/lib/script.ts` — Remove

**Plan's claim:** "distributeThreads() is only used by midgame_hack.ts. Once midgame_hack is removed, this is dead code."

**Verdict: INCORRECT.** The plan's claim about usage is wrong — this file has MORE consumers than stated.

**Functions in this file:**
1. `copyScripts(ns, scripts, fromServer, targetList)` — not used in any grep results outside this file
2. `ensureScriptExists(ns, script, targetServer)` — line 19
3. `distributeThreads(ns, script, threads, servers, ...args)` — line 27

**Importers of `ensureScriptExists` from `../lib/script`:**
- `src/contracts/midgame_hack.ts` line 6 (being removed in S1 — OK)
- **`src/engine/exec_multi.ts` line 2** — **PLAN MISSED THIS.** exec_multi.ts calls it at line 123 in `distributeExecution()`. This is used by batch_hack.ts.

**Importers of `distributeThreads` from `../lib/script`:**
- **`src/engine/thread_manager.ts` line 3** — **PLAN MISSED THIS.** thread_manager.ts calls it at line 445 in `executeOperation()`. This is a core engine class used by batch_hack.ts.
- `midgame_hack.ts` has its OWN LOCAL `distributeThreads()` (line 397) — NOT imported from lib/script.ts.

**Note on `copyScripts`:** Not imported by any file according to grep.

**Will removal break anything?** **YES, critically.** Removing `lib/script.ts` would break:
1. **`src/engine/exec_multi.ts`** (line 123) — `distributeExecution()` calls `ensureScriptExists()`. This function is used indirectly by `batch_hack.ts`.
2. **`src/engine/thread_manager.ts`** (line 445) — `executeOperation()` calls `distributeThreads()`. This is the core batch scheduler used by `batch_hack.ts`.

**Migration path required:**
- Inline `ensureScriptExists` logic into `exec_multi.ts` (simple 2-line scp check).
- Inline `distributeThreads` logic into `thread_manager.ts` (or reference a replacement).
- Alternatively, move these utility functions to a different lib file that will NOT be removed (e.g., `src/lib/network.ts` or `src/engine/batch_util.ts`).

**Importers the plan MISSED:**
1. `src/engine/exec_multi.ts` — imports `ensureScriptExists`
2. `src/engine/thread_manager.ts` — imports `distributeThreads`

---

## 2. Duplicate Code Verification

### 2.1 calculateServerValue()

**Three versions exist:**
1. `src/lib/server.ts:5` — 4 factors, NO growth factor. Signature: `(ns, target)`.
2. `src/engine/batch_util.ts:26` — 5 factors, HAS growth factor. Signature: `(ns, target)`.
3. `src/contracts/midgame_hack.ts:268` — 2 factors (simplified ratio). Signature: `(maxMoney, minSecurity, requiredLevel, hackChance)`.

All three are functionally different:
- #1 and #2 share the same signature but produce different scores (different factors/weights).
- #3 is a completely different formula using raw parameters instead of ns calls.

**Plan's fix direction is correct:** Consolidate to #2 (batch_util.ts version) since it has the growth factor and is used by the engine.

**Additional work needed (not in plan):** Update `server_manager.ts` import from `../lib/server` to `../engine/batch_util` after consolidation.

### 2.2 Hardcoded Thresholds in server_manager.ts

**Two versions of `isServerPrepared()` exist:**
1. `src/engine/server_manager.ts:83` — hardcoded `0.9` and `3`.
2. `src/engine/batch_util.ts:66` — defaults `0.9` and `3` but configurable via parameters.

These are near-duplicates with the same logic. The plan correctly identifies that server_manager.ts should read from config rather than hardcode.

---

## 3. Implementation Order Dependency Analysis

### Step-by-step walkthrough:

| Step | What | Effort | Dependencies | Can parallelize? |
|------|------|--------|-------------|-----------------|
| **P1** | Fix file sync engine (B1+B2) | 2-3h | Nothing | — |
| **P2** | Add `getAllFiles` to MCP | 30min | P1 | Could start after P1 design is done, or partially with P1 |
| **S1** | Remove files | 30min | P1 | Independent of P2 |
| **S2** | Add boot source files | 30min | P1 | Independent of S1, P2 |
| **S3** | Build strategy engine | 3-4h | S1, S2 | Must wait for S1+S2 |
| **S4** | Point batch_hack to strategy_agent | 30min | S3 | Must wait for S3 |
| **S5** | RAM optimization | 1h | S3 | Must wait for S3 |
| **S6** | Test | 2h | S5 | Must wait for S5 |

### Dependency analysis:

**P1 → P2 (correct):** P2 adds an MCP tool that lists files in the game. The file sync fix (P1) ensures the dist/ files reliably reach the game. P2 can't be tested without P1's sync working, so this dependency is real though weak — the MCP code itself doesn't import from the sync code.

**P1 → S1 (correct):** S1 removes files. Without P1, the sync won't push the cleanup to the game. But this is a source-code cleanup, so it's not strictly dependent — you could remove the files in source without P1 working. However, you need P1 to sync the changes into the game.

**P1 → S2 (correct):** S2 adds boot files to source. Same rationale as S1.

**S1 + S2 → S3 (partially correct):** S3 builds the strategy engine. It needs a clean codebase (S1) and the boot chain (S2). However:
- S3's design could START without S1/S2 complete (design the core agent, strategies).
- S3's implementation needs S2 (boot chain feeds the strategy agent's startup).
- S3 doesn't strictly need S1 (the strategy agent is a new file that replaces midgame_hack's role at runtime, not by removing the source file).

**S3 → S4 (correct):** batch_hack references game_agent; S4 points it to strategy_agent instead. Must wait for S3.

**S3 → S5 (correct):** RAM optimization applies to the strategy agent. Must wait for S3.

**S5 → S6 (correct):** Test the complete system. Must wait for all changes.

### Can any steps be parallelized?

- **P2 and S1 and S2** can all run in parallel once P1 is complete. They touch different parts (MCP vs contracts/monitor vs new boot files).
- **P2 and S1** could arguably start in parallel with P1 (the file sync fix is independent plumbing).
- **Maximum parallelism:** P1 first (2-3h), then P2 + S1 + S2 in parallel (30min), then S3 (3-4h), then S4 + S5 in parallel (30min-1h), then S6 (2h). Total: ~8-10h vs sequential ~10-12h.

### Is anything MISSING from the order?

**YES — 4 items are missing:**

1. **PREREQUISITE: Migration of `lib/script.ts` dependencies before removal.** The plan says to remove lib/script.ts in S1 but doesn't account for the two importers found in this audit (`exec_multi.ts` and `thread_manager.ts`). A "Migrate script.ts utilities" step must precede or be part of S1, or lib/script.ts cannot be safely removed.

2. **PREREQUISITE: Consolidation of `calculateServerValue` before server_manager.ts can work.** If `lib/server.ts` is fixed/removed, `server_manager.ts`'s import needs updating. This should happen alongside or before the removal.

3. **NO STEP for wiring config into server_manager.ts.** The plan says to fix the hardcoded thresholds but doesn't place this in the implementation order. This should be part of S1 or S3.

4. **NO STEP for writing `simple_hack.ts`.** Section 4.10 question 1 identifies the need for a "~50-line simple_hack.ts" for the SNOWBALL phase, since midgame_hack (538 lines) is too heavy. The removal of midgame_hack in S1 without a replacement creates a gap. This should be added as a step between S1 and S3, or within S3.

### Is the effort estimate (~10-12h) realistic?

**TIGHT but achievable with caveats:**

| Step | Plan | Audit-adjusted |
|------|------|---------------|
| P1 | 2-3h | 2-3h |
| P2 | 30min | 30min |
| S1 | 30min | **1-2h** (migration of lib/script.ts dependency + config wiring for server_manager.ts) |
| S2 | 30min | 30min |
| **NEW** | — | **1h** (write simple_hack.ts for SNOWBALL phase) |
| S3 | 3-4h | 3-4h |
| S4 | 30min | 30min |
| S5 | 1h | 1h |
| S6 | 2h | **3h** (more test scenarios needed) |
| **Total** | **~10-12h** | **~13-16h** |

---

## 4. Build Directory Impact

**Build system (`build/`) assessment:**

- **`build/game-bridge.ts`**: No references to any of the files planned for removal. It watches `dist/` for file changes and pushes to the game. It would push whatever JS files TSC generates from the TS source — it doesn't care about specific filenames. **No impact.**

- **`build/config.js`**: Only exports `dist`, `src`, and `allowedFiletypes` from `filesync.json`. **No impact.**

- **`build/game-bridge-mcp/src/index.ts`** (MCP server): Registers tools (`list_servers`, `list_files`, `read_file`, `calculate_ram`, `get_save`, `push_file`, `delete_file`, `get_status`). None of these reference the files being removed. The `read_file` tool reads any game file — later removal of status_reporter.txt output is transparent. **No impact.**

- **`build/init.js`**, **`build/watch.js`**: Not examined in detail but unlikely to reference specific source file paths. **No impact (likely).**

- **`package.json`**: Scripts reference `build/game-bridge.ts`, `build/watch.js`, `build/init.js`. No references to contracts/monitor/lib files. **No impact.**

- **`filesync.json`**: Only syncs `.js`, `.script`, `.txt` from `dist/`. **No impact.**

---

## 5. Test Gaps

What should be tested after each step that the plan doesn't mention:

### After P1 (Fix file sync):
- Verify that pushing a new .ts file → compiled .js appears in game
- Verify that deleting a file from src/ removes it from dist/ and game
- Verify behavior when game is disconnected then reconnected (pending sync flush)

### After P2 (getAllFiles MCP):
- Verify tool correctly lists all files on a given server
- Verify tool handles empty servers ("server has no files")
- Verify tool handles disconnected game state gracefully (no crash, clear error)

### After S1 (Remove files):
- **CRITICAL: Verify `src/engine/exec_multi.ts` compiles without `ensureScriptExists`** (or after migration)
- **CRITICAL: Verify `src/engine/thread_manager.ts` compiles without `distributeThreads`** (or after migration)
- Verify `src/engine/server_manager.ts` still works after `lib/server.ts` calculateServerValue is consolidated
- Verify `batch_hack.ts` still runs without midgame_hack.ts present (it only references it as a string path in config)
- Verify no TypeScript compilation errors across the whole project

### After S2 (Boot files):
- Verify boot.ts, boot2.ts, relay.ts compile successfully
- Verify they match the .js versions currently pushed to the game (if possible)

### After S3 (Strategy engine):
- Verify phase detection works correctly at various game states
- Verify all 5 strategies load and execute correctly
- Verify agent runs on the smallest acceptable server (RAM check)
- Verify agent handles server nuke/restart gracefully (reboot resilience)
- **Verify SNOWBALL phase has a working hack loop** (midgame_hack was removed in S1, simple_hack.ts may not exist yet)
- Verify agent correctly transitions between phases

### After S4 (Point batch_hack to strategy_agent):
- Verify batch_hack's game_agent reference successfully targets strategy_agent
- Verify both daemons don't conflict (double-launch prevention)
- Verify strategy_agent can launch batch_hack when conditions are right

### After S5 (RAM optimization):
- Verify agent runs on 16 GB server (or whatever constraint was targeted)
- Verify ns.ps() removal doesn't break server status tracking
- Verify lazy snapshot still provides useful data
- Verify no perf regression in decision loop

### After S6 (Full test):
- Fresh game start → observe bootstrap → SNOWBALL → BATCH phase transition
- Verify all status files are written and readable via MCP
- Verify decision log contains actionable choices
- **Test edge case: reset mid-game** — does the agent handle a reset at BATCH phase gracefully?
- **Test edge case: low RAM constraint** — does the agent still function on minimal hardware?
- **Test edge case: all servers prepped vs none prepped** — correct behavior in both extremes

---

## 6. Top 3 Risks in the Implementation Order

### Risk 1 (HIGH): `lib/script.ts` removal breaks `exec_multi.ts` and `thread_manager.ts`

The plan claims `distributeThreads` is "only used by midgame_hack.ts" — **this is false.** 
- `thread_manager.ts` (line 3, 445) imports and calls `distributeThreads` from `../lib/script`.
- `exec_multi.ts` (line 2, 123) imports and calls `ensureScriptExists` from `../lib/script`.
- Both are core engine modules used by `batch_hack.ts` (the active orchestration script).
- Removing `lib/script.ts` without migrating these dependencies will cause TypeScript compilation errors and break the running game's batch hacking.

**Mitigation:** Add a pre-S1 step to inline these two functions into the files that depend on them, or move them to a retained library module. This adds ~1-2h of work the plan doesn't account for.

### Risk 2 (MEDIUM): S1 creates a 4-5 hour gap in mid-game automation

S1 removes `midgame_hack.ts` (the only mid-game hack loop) but S3 (strategy engine replacement) is 3-4 hours later. During this gap, the game has no automated hacking for the SNOWBALL and mid-game phases. The only running script would be `batch_hack.ts`, which requires ~16GB+ home RAM (see `batchHackRamThreshold: 16384`).

- A fresh game start → `batch_hack.ts` may not run on 8GB home (it needs at minimum RAM for the agent + batch scheduler).
- If `midgame_hack.ts` was the transition script that detected when to switch to batch, removing it means nothing handles the early-to-mid game transition.

**Mitigation:** Either (a) keep midgame_hack.ts until S3 is complete, (b) write the simple_hack.ts replacement before removing midgame_hack, or (c) ensure batch_hack.ts has a fallback simple hack mode for low-RAM situations. The plan's Section 4.10 question 1 acknowledges this but doesn't add it to the implementation order.

### Risk 3 (LOW-MEDIUM): Missing step for config wiring in server_manager.ts

The plan correctly identifies the hardcoded thresholds (lines 84-85) as a problem but doesn't add "Wire config into server_manager.ts" as a step in the implementation order. Since S1 removes the files and S3 builds the strategy engine, the config wiring could fall through the cracks and remain as tech debt.

Additionally, if `lib/server.ts` is fixed/removed but `server_manager.ts` still imports `calculateServerValue` from it, the import breaks. The import path update must happen in the same step.

---

## Summary of Corrections Needed

| Issue | Severity | Section |
|-------|----------|---------|
| Plan claims `distributeThreads` only used by midgame_hack; `thread_manager.ts` also uses it | **HIGH** | 4.7 (lib/script.ts row) |
| Plan misses `exec_multi.ts` as importer of `ensureScriptExists` from lib/script.ts | **HIGH** | 4.7 (lib/script.ts row) |
| No migration path for lib/script.ts dependencies before removal | **HIGH** | 4.8 (S1) |
| S1 creates 4-5h gap in mid-game automation (no simple_hack.ts replacement) | **MEDIUM** | 4.8 (S1→S3 gap) |
| No step for wiring config into server_manager.ts | **MEDIUM** | 4.8 (missing step) |
| No step for updating server_manager.ts import path after calculateServerValue consolidation | **MEDIUM** | 4.8 (missing step) |
| Slight underestimation of total effort (~13-16h vs claimed ~10-12h) | **LOW** | 4.8 |
| P2, S1, S2 can be more parallelized than shown | **LOW** | 4.8 |
| No test steps for exec_multi.ts and thread_manager.ts after lib/script.ts removal | **MEDIUM** | 4.8 (S6, test gaps) |
