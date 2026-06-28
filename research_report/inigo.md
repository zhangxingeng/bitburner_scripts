# Inigo Bitburner Scripts — Architecture Research Report

## Summary

Full TypeScript repo using `viteburner` (Vite-based) for hot-reload dev workflow. Deeply modular: one subdirectory per domain (attack, spread, augment, crime, sleeve, hacknet, etc.) plus shared libs. Two-phase sequential orchestrators (`bootstrap.ts` → `launchAll.ts`) drive everything via a sequential run-and-poll loop. **Hacking uses proper HWGW batching** via an `AttackController` class with formulas-based math; early game uses a simpler spread pattern. **Player Thread is heavily automated via Singularity API** — factions, augmentations, sleeves, gang, company promotions, and even auto-completing bitnodes via DOM hacking. Goal system reads a `goal.txt` file to switch between hacking/bladeburner/stocks strategies per bitnode.

---

## src/ Architecture Map

```
src/
├── bootstrap.ts          # Phase 1 orchestrator: run first
├── launchAll.ts          # Phase 2 orchestrator: spawned by bootstrap
├── libFormat.ts          # Tagged template fmt(), PrettyTable
├── libLaunch.ts          # anyScriptRunning(), launchIfNotRunning()
├── libPorts.ts           # 21 named port constants + checkPort/setPortValue/popPort
├── libServers.ts         # BFS server discovery, findAll*, findHackable*
├── joinFaction.ts        # Faction joining + workForFaction via Singularity
├── joinDaedalus.ts       # Specialized Daedalus join
├── uiDashboard.ts        # Alt UI entry
├── attack/               # HWGW batching engine
│   ├── attack.ts         # Main attack loop driver (runs on each source server)
│   ├── libController.ts  # AttackController class: prime, batch, thread math
│   ├── libTargets.ts     # TargetFinder class: ranks targets by income/payback
│   ├── libAttack.ts      # Shared helpers, toIdealServer()
│   ├── launchAttackFromHome.ts
│   ├── launchAttacksFromPurchasedServers.ts
│   ├── purchaseAndAttack.ts  # Buy pserv and assign target
│   ├── hack.ts / grow.ts / weaken.ts  # Worker scripts
│   └── killAttacks.ts / reportAttacks.ts / listTargets.ts / setLogging.ts
├── spread/               # Early-game: spread H/G/W across all cracked servers
│   ├── spreadAttackController.ts  # Orchestrates spread on all cracked servers
│   ├── libSpread.ts      # Attack target port I/O
│   └── spreadHack.ts / spreadGrow.ts / spreadWeaken.ts / setTarget.ts
├── augment/              # Augmentation + bitnode completion
│   ├── buyAugments.ts    # Selects faction, buys augs, triggers restart
│   ├── completeBitnode.ts  # Installs backdoor + DOM click to start next BN
│   ├── augmentAndRestart.ts
│   ├── libAugmentations.ts  # getUsefulAugmentations, ordering, cost logic
│   └── libAugmentationInfo.ts
├── basic/                # Utility actions run each loop
│   ├── buyCracks.ts / crackAll.ts / installBackdoors.ts
│   ├── upgradeMemory.ts  # Buys home RAM via Singularity
│   ├── studyCs.ts        # Study CS to boost hack level
│   ├── cheatCasino.ts    # Casino exploit for early cash
│   └── timedHack.ts      # Simple timed hack script for early game
├── crime/                # Gang automation
│   ├── startGang.ts / manageGang.ts / gangControl.ts
│   ├── intermittentWarfare.ts
│   └── libCrime.ts / libGang.ts / libGangInfo.ts / reportGangStatus.ts
├── sleeve/               # Full sleeve automation
│   ├── selectSleeveTask.ts  # Sets sleeve tasks based on game state
│   ├── sleeveControl.ts / installSleeveAugments.ts
│   └── libSleeve.ts
├── hacknet/              # Hacknet node management
│   ├── upgradeNodes.ts / sellHashes.ts / selectHashTarget.ts
│   └── libHacknet.ts / libHashes.ts / hashControl.ts
├── company/
│   └── workForCompany.ts  # Promote through company positions (partially stubbed)
├── tix/                  # Stock trading
│   └── stockTrade.ts / libTix.ts / libShareSelling.ts
├── contracts/            # Contract solver
│   └── solveContracts.ts
├── goal/                 # Goal/strategy selection
│   ├── libGoal.ts        # Goal type: "hacking" | "bladeburner" | "stocks"
│   └── selectGoal.ts / setGoal.ts / libGoalSetting.ts
├── stanek/               # Stanek's gift management
├── bladeburner/          # Bladeburner automation
├── corp/                 # Corporation (mostly disabled/stubbed)
├── react/                # Custom UI dashboard (TSX/React)
├── reporting/            # Progress logging
├── speech/               # Text-to-speech
└── vendored/             # Vendored react.js
```

---

## Investigation Points

### 1. Project Structure

- **Domain-per-directory** layout. Each domain has a `lib<Domain>.ts` for shared types/logic and `<action>.ts` scripts for entry points.
- **Three shared libs** that nearly every script imports: `libPorts.ts`, `libServers.ts`, `libLaunch.ts`, `libFormat.ts`.
- **tsconfig.json** uses `"paths": { "@/*": ["src/*"] }` so all imports use `@/libPorts` style — no relative path hell.
- **Build**: `viteburner` (a Vite plugin for Bitburner) — `vite.config.ts` watches `src/**/*.{js,ts,tsx}`, transforms, and hot-pushes to game. No custom webpack/esbuild scripts.
- **Type discipline**: `strict: true`, `noImplicitReturns: true`. Types exported inline with logic files rather than a separate `types/` dir.
- **Tests**: `jest.config.js` + `tests/` directory present (unit tests for some logic, not all).
- `@ns` aliased to `./NetscriptDefinitions.d.ts` — avoids `../../NetscriptDefinitions` paths.

### 2. Control Flow

Two-phase orchestration via sequential scripts, not a daemon:

**Phase 1 — `bootstrap.ts`**
- Runs serially: stanek → studyCs → corps → gang → (optional casino) → loop.
- Inner loop: runs scripts one at a time, polling `anyScriptRunning()` to block until each finishes before starting the next. Order is explicit and deterministic.
- Transitions to Phase 2 when `isPhaseTwo()` returns true: `home >= 1024GB RAM && home > 1M money && allCracksBought(5)`.
- Uses `ns.spawn("launchAll.js")` to replace itself with Phase 2.

**Phase 2 — `launchAll.ts`**
- Same pattern: a `while(true)` sequential loop with ~15s sleep between iterations.
- Long ordered list of ~25 scripts, each run and polled to completion.
- Notable: `completeBitnode.js` is first in the list (must trigger before any restarts).
- Long-running daemons (stockTrade, manageGang, manageBladeburner, uiDashboard) are launched with `launchIfNotRunning()` — they persist between iterations.
- Restart trigger: after each loop iteration, checks port `AUGMENT_AND_RESTART`; if set, spawns `augmentAndRestart.js`.

**IPC**: All cross-script communication is via **ports** (`libPorts.ts`). 21 named port constants cover: attack target, gang control, sleeve instructions, augmentation trigger, do-not-restart flag, etc. Helpers: `checkPort()` (peek with transform), `setPortValue()` (clear+write), `popPort()` (read+remove).

### 3. Income Engine

**Early game — Spread pattern** (`spread/spreadAttackController.ts`):
- Copies `spreadHack/Grow/Weaken.js` to all cracked servers via `ns.scp`.
- Launches one hack server, then fills remaining servers with grow/weaken in a ~4:3.2 ratio.
- Single target selected via port (`HACKING_PORT`), changeable with `setTarget.ts`.
- Simple: no timing coordination, just saturate RAM with workers.

**Late game — HWGW batching** (`attack/libController.ts` + `attack/attack.ts`):
- `AttackController` class encapsulates all math:
  - `hackInfo()` → threads/time/securityGrowth/hackAmount using `ns.formulas.hacking.hackPercent`.
  - `growInfo()` → threads via manual log/rate formula (not `ns.growthAnalyze` — replicated internally for accuracy).
  - `weakenInfo()` → threads based on `0.05 * coreBonus * BitNodeMultipliers.ServerWeakenRate`.
  - `infoPerCycle()` → CycleInfo: total RAM, total time for one H/W/G/W batch.
  - `timingInfo()` → computes simultaneous attack count as `min(memoryConstrained, timingConstrained)`.
  - `primeServer()` → brings server to min security + max money before batching.
  - `launchAttackCycle()` → fires H, W1, G, W2 with staggered `endTime` using `bufferTimeWithinAttack` (60ms) delays.
- `attack.ts` runs on each source server; loop monitors running count via `runningAttacks()`, waits on port write when at max concurrency, re-primes if server drifts out of balance.
- Buffer times: `bufferTimeWithinAttack = 60ms`, `bufferTimeBetweenAttacks = 90ms`.
- Home reserves 100GB of RAM for other scripts.

**Target selection** (`attack/libTargets.ts`):
- `TargetFinder.listBestTargets()` ranks all hackable servers by `incomeWithinPeriodPerSecond` — accounts for initial prime time, hack success chance, simultaneous attack count, and memory fit.
- Filters targets already being attacked to avoid duplicate assignment.

**Purchased servers** (`attack/purchaseAndAttack.ts`):
- Tiered RAM purchases: 16K→64K→512K GB based on hackLevel (500/1000/1500 thresholds) and existing server count (3/6/12).
- Each purchased server runs its own `attack.js` instance on its best available target.

### 4. Infrastructure

- **Server discovery**: `libServers.ts` — recursive BFS via `ns.scan()`. `findAllServers()`, `findCrackedServers()` (excludes pserv/hacknet), `findAllHackableServers()` (rooted + has money).
- **Cracking**: `basic/buyCracks.ts` + `basic/crackAll.ts` (mentioned in orchestrators). Not read in detail but implied Singularity purchaseProgramFromDarkweb + standard crack sequence.
- **Backdoors**: `basic/installBackdoors.ts` — Singularity-based.
- **Home RAM**: `basic/upgradeMemory.ts` — uses Singularity `getUpgradeHomeRamCost()` / `upgradeHomeRam()`, funded by selling shares if needed.

### 5. Player Thread

**YES — extensive Singularity automation:**

| Module | What it automates |
|---|---|
| `joinFaction.ts` | Joins preferred faction in order (CyberSec→NiteSec→BitRunners→Daedalus), travels to cities for Tian Di Hui, calls `ns.singularity.workForFaction()` |
| `augment/buyAugments.ts` | Selects best faction (gang vs. non-gang), buys all installable augs, triggers restart via port |
| `augment/completeBitnode.ts` | Connects to w0r1d_d43m0n, installs backdoor, then **DOM click** to select next BN12 + runs `bootstrap.js` |
| `sleeve/selectSleeveTask.ts` | Full state machine: shock recovery → study CS → crime for karma → gang training → faction work mirror |
| `crime/manageGang.ts` | Gang management (territory warfare, task assignment) |
| `company/workForCompany.ts` | Company promotions via Singularity (partly stubbed, main work loop commented out) |

**DOM usage**: Only in `completeBitnode.ts` for post-bitnode navigation (clicking BN12 button + pressing Enter). No DOM-based faction/work automation — all via Singularity API. Also `speech/libSpeech.ts` (text-to-speech via window API).

**Sleeve coordination**: `selectSleeveTask.ts` mirrors the player's current faction work to sleeves — reads `ns.singularity.getCurrentWork()` and calls `ns.sleeve.setToFactionWork()`.

### 6. Phase Detection

- **Two explicit phases**: `isPhaseTwo()` in `bootstrap.ts` checks RAM >= 1024GB + money > 1M + all 5 cracks bought.
- **Goal system** (`goal/libGoal.ts`): reads `goal.txt` with format `<BN>x<iter>: <goal>` — explicit per-run goal setting. Defaults to "hacking". Switches orchestrators to use bladeburner or stocks focus.
- **Implicit sub-phases** in `purchaseAndAttack.ts`: hackLevel tiers (500/1000/1500) gate server purchases and RAM size.
- **No formal phase enum** — phase detection is spread across scripts via threshold checks.

### 7. TypeScript Patterns

**`fmt(ns)` tagged template** (`libFormat.ts`):
```ts
fmt(ns)`Money is £${money} and ram is ${ram}GB and time is ${time}s`
```
Infers format function from surrounding text: `£` prefix → `nFormat($0.00a)`, `GB` suffix → bytes formatter, `s` suffix → `tFormat`. Very clever and ergonomic.

**`AttackController` class** — stateful class encapsulating all HWGW math: thread calculations, timing, prime, batch launch. Constructor takes source server + target + RAM + buffer times. All formulas use `ns.formulas.hacking.*` so they're accurate without waiting for actual operations.

**`TargetFinder` class** — pure computation over NS state, no side effects.

**`PrettyTable`** — generic table renderer that infers format from column header text (e.g., headers containing `($)`, `(GB)`, `(s)` trigger auto-formatting).

**Named port constants** — 21 constants in one file, all documented. Makes port usage greppable and refactorable.

**`anyScriptRunning()`** — strips leading `/` for consistent filename comparison.

**`toIdealServer()`** — creates a synthetic `Server` object at min security + max money for accurate formulas without waiting for actual server state.

**Path aliases** — `@/libPorts` instead of `../../libPorts`. Both tsconfig paths and vite resolve aliases configured.

**React UI** — `src/react/newUiDashboard.tsx` compiled via viteburner's TSX support. Vendored react in `src/vendored/`.

**`autocomplete()` exports** — several scripts export `autocomplete` for game tab-completion.

---

## Copy vs. Build

### COPY (high value for our project)

| Pattern | Location | Why |
|---|---|---|
| `@/` path alias in tsconfig + vite | `tsconfig.json`, `vite.config.ts` | Eliminates relative import hell, matches our setup goal |
| `libPorts.ts` pattern | `src/libPorts.ts` | Named constants + peek/pop/set helpers — adopt verbatim |
| `libServers.ts` pattern | `src/libServers.ts` | BFS discovery + typed filter helpers — clean and minimal |
| `libLaunch.ts` helpers | `src/libLaunch.ts` | `anyScriptRunning()` / `launchIfNotRunning()` — tiny but used everywhere |
| `AttackController` class | `src/attack/libController.ts` | All HWGW math in one place, formulas-based, priming + batching. Best reference for our batching engine |
| `TargetFinder.listBestTargets()` | `src/attack/libTargets.ts` | Income-within-payback-period ranking with prime time deducted — proper target selection |
| `fmt(ns)` tagged template | `src/libFormat.ts` | Very ergonomic number/time/memory formatting with no per-call boilerplate |
| `viteburner` build setup | `vite.config.ts` | Hot-reload dev workflow — if we're not already using this, adopt it |
| Sequential `launchAll.ts` pattern | `src/launchAll.ts` | Simple, debuggable, no async coordination hell — good model for our P-Thread |
| `selectSleeveTask.ts` state machine | `src/sleeve/selectSleeveTask.ts` | Full sleeve logic to copy: shock → crime → gang → faction mirror |
| Augmentation selection ordering | `src/augment/libAugmentations.ts` | Dependency-aware augment ordering, goal-filtered aug sets |

### BUILD (don't adopt as-is)

| Pattern | Why rebuild |
|---|---|
| Sequential orchestrators | Both bootstrap/launchAll are serial — our Thread C should be parallel (multiple targets, distributed compute). Their pattern works for a simpler model. |
| `libFormat.ts` nFormat calls | Uses deprecated `ns.nFormat` — rebuild using `ns.formatNumber`, `ns.formatRam`, `ns.formatPercent` |
| `company/workForCompany.ts` | Largely stubbed/commented out — not a working reference |
| Corp code | Explicitly marked as bad, disabled entirely |
| DOM-based BN switching | `completeBitnode.ts` uses `document.querySelector` for BN selection — brittle; rebuild if needed |
| Goal via text file | Clever but opaque — consider a more typed config approach |

---

## Interesting Discoveries

1. **`completeBitnode.ts` auto-restarts into BN12**: Uses DOM to click the BN12 button and confirm, then runs `bootstrap.js` in the new node. Full end-to-end automation of the BN cycle with zero human interaction.

2. **Port-based `DO_NOT_RESTART`**: A dedicated port (port 21) can be set to prevent augment purchase + restart — a "pause automation" mechanism without killing scripts.

3. **`attack.ts` self-heals**: When home RAM changes (server upgrade) or server drifts out of balance (>10 consecutive unbalanced checks), it breaks the inner loop and re-primes from scratch.

4. **Sleeve mirrors player faction**: `selectSleeveTask.ts` reads `ns.singularity.getCurrentWork()` and assigns sleeves to the same faction — passive faction rep doubling with no manual coordination.

5. **`toIdealServer()`**: Creates a synthetic server at min security + max money for formulas calls — allows accurate thread/time math before priming is complete.

6. **Weighted stat training for murder**: `trainForMurder()` uses a weighted array `["Agility", "Dexterity", "Defense","Defense","Defense","Defense","Strength","Strength","Strength","Strength"]` — encodes the combat formula weights directly as a distribution.

7. **Port hash for uniqueness**: `AttackController.uniquePort()` hashes `sourceHostName + targetHostName` to a stable port number (10K-100M range) — unique per source/target pair without a registry.

8. **Casino bootstrap**: Phase 1 runs `cheatCasino.js` if home money < 300M or home RAM < 512GB — casino exploit as explicit early-game income source.

9. **`PrettyTable` header-driven formatting**: Column format (money/time/memory) inferred from `($/s)`, `(s)`, `(GB)` substrings in the header string — declarative table rendering with no per-column format code.

10. **`viteburner`** hot-reload: The entire dev workflow is `npm run dev` — file save → TypeScript compile → push to game instantly. No separate "build then upload" step.
