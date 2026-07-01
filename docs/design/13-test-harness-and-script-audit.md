# Design 13 — Test Harness & Script Audit

**Status:** RATIFIED 2026-06-30. Doc-first. No code written yet.

**Companions:** [[07-dev-loop-tooling]] (browser/Playwright setup), [[10-parallel-build-playbook]]
(wave structure for concurrent builds), [[04-player-automation-and-control]] (terminal injection
mechanism), [[11-subsystem-autonomy-and-console-v2]] (subsystem managers under test).

---

## §0 Motivating failure — why this doc exists

`src/types/ns-augment.d.ts` declared a fake `formatNumber()` on the `@ns` interface. `tsc`
passed. The call crashed at runtime: `"formatNumber: Function removed in 3.0.0"`.

**Lesson: type-check passing is NOT runtime-safety.** Augmentation files are a one-way promise from
the developer — not from the game engine. A wrong declaration silently patches the type system and
the bug only surfaces when the script runs.

**A second bug of the same class was found while writing this doc** (§5.2 below):
`getPurchasedServers()`, `getPurchasedServerCost()`, `getPurchasedServerLimit()`,
`purchaseServer()`, and `deleteServer()` are all declared directly on the `NS` interface in
`ns-augment.d.ts` — but they were also **removed in v3.0.0** (moved to `ns.cloud.*`). The scripts
that call them (`pserv_manager.ts`, `target_selector.ts`, `hwgw_batcher.ts`, `ram_manager.ts`,
`lib/servers.ts`, `program_acquirer.ts`) will crash at runtime. Fix: update `ns-augment.d.ts` to
remove these declarations and migrate callers to `ns.cloud.*`.

This doc builds the harness + audit that catches this class of bug and proves every script actually
runs.

---

## §1 The dev game / bridge / browser model

### §1.1 System topology

```
bitburner_scripts/src/
   │  npx tsc
   ▼
bitburner_scripts/dist/        ← compiled JS
   │  watch:remote (tsx build/game-bridge.ts)  [RFA WS :12525]
   ▼
Steam / game instance          ← files synced in via Remote File API
   │  game_agent.ts opens outbound WS to bridge :12527
   ▼
bridge :12527                  ← bidirectional control channel
   │  MCP tools (mcp__bitburner__terminal, etc.)
   ▼
Claude / agent                 ← judgment layer (architecture §3, design/02)
```

**RFA bridge** (`watch:remote` = `tsx build/game-bridge.ts`): WebSocket on port 12525. Syncs
`dist/` into the game on file change, exposes `push_file` / `read_file` / `list_files` MCP tools.

**Control channel** (`cross/game_agent.ts`): opens an outbound WS to the bridge on port 12527.
Handles `terminal`, `run`, `kill`, `ps`, `getPlayer`, `getServer`, `readPort`, `writePort`,
`peekPort`, `ping`, `decide` commands. Fallback: RFA file-relay via `status/.cmd.json` /
`status/.result.json`. The control channel gives sub-10 ms round-trips; the RFA fallback gives
~200 ms.

**Terminal injection** (`cross/launcher.ts`): DOM-based, `eval('document')` trick. Requires the
`game_agent` to be running on home so the command queue (PORT_LAUNCHER) and WS control channel are
active. When the control channel is DOWN, `mcp__bitburner__terminal` still falls back to
`PORT_LAUNCHER` → `processLauncherCommands` in the agent, which calls `runTerminalCommand`. But
both paths require game_agent to be alive.

### §1.2 The chicken-and-egg bootstrap problem

**The problem:** `mcp__bitburner__terminal` routes through the control channel (WS :12527) or
falls back to PORT_LAUNCHER, both of which live inside `game_agent`. MCP terminal injection
**cannot start the first script** because `game_agent` is not yet running.

**Resolution:** use the browser to click in the game terminal.

### §1.3 Canonical startup sequence (follow this order every session)

```
STEP 1 — Build (host terminal)
  cd /home/shane/workspace/bitburner_scripts
  npx tsc
  # Expected: zero errors. Any error = fix before proceeding.

STEP 2 — RFA bridge (host terminal, background)
  pnpm run watch:remote
  # Expected: "Listening on :12525" or similar.
  # Syncs dist/ → game automatically on every tsc output change.

STEP 3 — Bootstrap game_agent via browser
  # Option A — claude-in-chrome (preferred if Chrome session is live):
  #   Use mcp__claude-in-chrome__* to navigate to the Bitburner tab,
  #   click the terminal input, type: run /cross/game_agent.js
  #
  # Option B — Playwright (headless, isolated):
  #   mcp__playwright__browser_navigate("http://localhost:8000")   # dev build
  #   mcp__playwright__browser_click("#terminal-input")
  #   mcp__playwright__browser_type("run /cross/game_agent.js")
  #   mcp__playwright__browser_press_key("Enter")
  #
  # Option C — manual: human types it in the game terminal.
  #
  # The dev server (http://localhost:8000) is the bitburner-src webpack-dev-server
  # (design/07 §1). The Steam instance is a separate process — both require the
  # same manual bootstrap step; the WS addresses are the same (:12525, :12527).
  #
  # Pass: game_agent appears in ns.ps('home') output; bridge logs "control socket
  # connected"; mcp__bitburner__terminal ping round-trip succeeds.

STEP 4 — All subsequent MCP terminal commands now work
  # mcp__bitburner__terminal("run /brain.js")
  # mcp__bitburner__terminal("run /dev/cheat.js --sf 4")
  # etc.
```

**Why the browser works:** the browser can click `#terminal-input` and fire React keyboard events
directly on the DOM — the same mechanism `runTerminalCommand` uses internally. The browser instance
has the live DOM; no `game_agent` dependency.

**Why you cannot skip Step 3:** even `mcp__bitburner__write_port` cannot launch a script unless
something is already consuming PORT_LAUNCHER. `boot_agent` (a lighter relay on ports 1/2) is an
alternative if it is already running, but it also needs a one-time bootstrap click.

---

## §2 Surgical-cheat protocol

**Philosophy:** grant NOTHING by default. Each test run names exactly the capability it needs.
Blanket `--money 1e13 --exp 1e9` grants mask bugs that only surface under realistic resource
constraints. One knob at a time.

### §2.1 Cheat tool reference (`src/dev/cheat.ts`)

```
run /dev/cheat.js                        # no-op — prints usage
run /dev/cheat.js --help                 # full usage
run /dev/cheat.js --sf 4                 # unlock SF4 (Singularity) ONLY
run /dev/cheat.js --sf 2 --karma -54000  # unlock SF2 + set karma for gang
run /dev/cheat.js --sf 2,3,6 --level 3  # multiple SFs at level 3
run /dev/cheat.js --money 1e9            # set money only
run /dev/cheat.js --ram 256              # set home maxRam only
run /dev/cheat.js --exp 1e6             # dump exp into every skill
run /dev/cheat.js --karma -54000         # set karma only
```

Works ONLY in a dev build (`npm run start:dev` from `bitburner-src`). Production and Steam builds:
`globalThis.Bitburner.Player` is undefined → script no-ops with an error message. The guard IS the
dev/prod boundary.

### §2.2 SF → feature mappings (verified against game source)

| Feature | Required SF | Extra condition | Source file |
|---|---|---|---|
| Gang | SF2 | karma ≤ -54000 | `PersonObjects/Player/PlayerObjectGangMethods.ts:33` |
| Corporation | SF3 | — | `PersonObjects/Player/PlayerObjectCorporationMethods.ts:9` |
| Singularity API | SF4 | Without SF4: API works but at 16× RAM cost | BitNode 4 = Singularity |
| Stock 4S / TIX | SF5 | Without SF5: WSE account still purchasable; SF5 unlocks 4S | `NetscriptFunctions.ts:907` |
| Bladeburner | SF6 **or** SF7 | Either SF suffices | `NetscriptFunctions/Bladeburner.ts:35` |
| Hacknet servers | SF8 | Without SF8: only hacknet nodes | `Prestige.ts:161` |
| Sleeves | SF10 | +DevMenu click for sleeve count (see note) | `NetscriptFunctions/Sleeve.ts:52` |
| Grafting | SF10 | — | `PlayerObjectGeneralMethods.ts:canAccessGrafting` |
| Stanek's Gift | SF13 | — | `PlayerObjectGeneralMethods.ts:canAccessCotMG` |

**canAccessBitNodeFeature(n)** returns `Player.bitNodeN === n || Player.activeSourceFileLvl(n) > 0`
(`BitNodeUtils.ts:17`). Setting `Player.sourceFiles.set(n, level)` AND
`Player.bitNodeOptions.sourceFileOverrides.set(n, level)` then calling `reapplyAllSourceFiles()` is
what `cheat.ts --sf` does — this satisfies `activeSourceFileLvl(n) > 0` immediately.

**Sleeve note:** `recalculateNumberOfOwnedSleeves()` is module-scoped in the game engine; it
cannot be called from a script. After `--sf 10`, sleeves may show 0 in the UI. Workaround: open
DevMenu → SourceFiles → click SF10 once to trigger the recalculation.

### §2.3 Per-feature cheat recipes

```
# Gang unlock (SF2 + karma)
run /dev/cheat.js --sf 2 --karma -54000
# → then: run /player/gang_manager.js

# Corporation unlock (SF3 only — corp needs $150B to start, grant money separately)
run /dev/cheat.js --sf 3
run /dev/cheat.js --money 200e9
# → then: run /player/corp_manager.js

# Bladeburner unlock (SF6 OR SF7)
run /dev/cheat.js --sf 6
# → then: run /player/bladeburner_manager.js

# Sleeves (SF10 + DevMenu click for count)
run /dev/cheat.js --sf 10
# → then: DevMenu → SourceFiles → SF10 click → run /player/sleeve_manager.js

# Stanek's Gift (SF13)
run /dev/cheat.js --sf 13
# → then: run /player/stanek_manager.js

# Grafting (SF10)
run /dev/cheat.js --sf 10
# → then: run /player/grafting_manager.js

# Singularity API (SF4 reduces RAM cost from 16× to 1×; test at realistic SF4.1)
run /dev/cheat.js --sf 4 --level 1
# → then: run /cross/player_sequencer.js (exercises Singularity calls)

# Singularity without SF4 (vanilla RAM cost) — test the manager still loads
# (no cheat needed; just note the script's RAM requirement)

# Stock market 4S data
run /dev/cheat.js --sf 5
run /dev/cheat.js --money 1e10   # WSE account costs ~200M; 4S TIX API costs ~25B
# → then: run /stock/main.js
```

---

## §3 Per-script verification matrix

> **Legend:** ✓ = concrete pass criteria defined | ~ = template only (fill in on first run)
> Launch column assumes `game_agent` and `brain.js` are running unless noted.
> (Updated 2026-07-01: `bootstrap.js` no longer exists — its role was absorbed into `brain.js`
> via `lib/daemon_launcher.ts`, see [[14-roadmap-to-full-autoplay]] §1a. Rows below updated.)

### §3.1 Infrastructure / cross

| Script | How to launch | Cheat first | Expected observable | Pass criteria |
|---|---|---|---|---|
| `cross/game_agent.js` | Browser click → `run /cross/game_agent.js` | None | `ns.ps('home')` lists it; bridge logs WS connect; `status/heartbeat.txt` written within 1 s | ping round-trip via `mcp__bitburner__terminal` succeeds; `status/heartbeat.txt` `alive:true` |
| `cross/boot_agent.js` | `run /cross/boot_agent.js` | None | Appears in ps; PORT_CMD commands dispatched | Send `{id:"t1",method:"ps"}` to PORT_CMD, read PORT_RESULT: `success:true` |
| `cross/launcher.js <cmd>` | `run /cross/launcher.js run /brain.js` | None | Terminal shows the injected command running | `brain.js` appears in ps; no `ERROR [launcher]` in terminal |
| `cross/phase_detector.js` | `run /cross/phase_detector.js` | None | PORT_PHASE written; `status/heartbeat.txt` alive | peek(PORT_PHASE) returns a valid DesignPhase string |
| `cross/player_sequencer.js` | `run /cross/player_sequencer.js` | SF4 for Sing. calls | Decisions flow to `status/decisions.json`; PORT_DECISION populated | At least one decision entry appears within 10 s; no insta-crash |
| `cross/notification.js` | imported (not standalone) | — | — | — |
| `cross/reporter.js` | imported (not standalone) | — | — | — |

### §3.2 Entry point

| Script | How to launch | Cheat first | Expected observable | Pass criteria |
|---|---|---|---|---|
| `brain.js` | `run /brain.js` (via MCP terminal after game_agent up, or directly — has zero MCP dependency, see [[14-roadmap-to-full-autoplay]] §1a) | None | `ORCHESTRATOR: launched ...` tprints as home RAM allows; rooted servers list grows; pre-SF4, `[ui]`/`[brain]` prints show TOR/program/RAM/course purchase attempts | `ns.ps('home')` shows spawned daemons within 30 s; no crash; disconnecting MCP entirely does not affect behavior |

### §3.3 Compute stack

| Script | How to launch | Cheat first | Expected observable | Pass criteria |
|---|---|---|---|---|
| `compute/coordinator.js` | Auto-launched by brain.ts | None (but needs RAM ≥ 64 GB) | `--ram 64` then check ps | Batcher logic starts; worker spraying stops | `status/heartbeat.txt` alive; coordinator in ps |
| `compute/pserv_manager.js` | `run /compute/pserv_manager.js` | `--money 1e12`; **also fix ns.cloud.* bug first** (§5.2) | Purchases pserv-0 if money allows | Purchased server appears in `ns.cloud.getServerNames()` |
| `compute/hacknet_manager.js` | `run /compute/hacknet_manager.js` | `--money 1e9` | Buys hacknet nodes | Node count increments; no crash |
| `compute/target_selector.js` | imported (not standalone) | **fix ns.cloud.* bug first** | — | — |
| `compute/hwgw_batcher.js` | `run /compute/hwgw_batcher.js` | **fix ns.cloud.* bug first** | Batches start against target | Hack/grow/weaken workers dispatched |
| `compute/ram_manager.js` | `run /compute/ram_manager.js` | **fix ns.cloud.* bug first** | RAM allocation log | No crash; allocation visible in log |
| `compute/scheduler.js` | imported | — | — | — |
| `compute/allocator.js` | imported | — | — | — |
| `compute/spreader.js` | imported | — | — | — |
| `compute/formulas.js` | imported | — | — | — |
| `compute/exec_multi.js` | imported | — | — | — |

### §3.4 Player managers

| Script | How to launch | Cheat first | Expected observable | Pass criteria |
|---|---|---|---|---|
| `player/crime.js` | `run /player/crime.js` | None | Player begins committing crimes; `status/*.json` updated | No crash; crime activity in player state |
| `player/faction_manager.js` | `run /player/faction_manager.js` | None (SF4 for auto-join) | Decision pushed to PORT_DECISION when join prompt arises | No crash; decision entry in `status/decisions.json` |
| `player/aug_planner.js` | `run /player/aug_planner.js` | None | Aug purchase plan written | No crash; plan output visible in terminal |
| `player/program_acquirer.js` | `run /player/program_acquirer.js` | **fix ns.cloud.* bug first** | Buys programs / creates home scripts | No crash; programs appear in file list |
| `player/gang_manager.js` | `run /player/gang_manager.js` | `--sf 2 --karma -54000` | Gang creation; member recruitment | No crash; ns.gang.inGang() returns true |
| `player/corp_manager.js` | `run /player/corp_manager.js` | `--sf 3 --money 200e9` | Corp created | No crash; ns.corporation.hasCorporation() returns true |
| `player/bladeburner_manager.js` | `run /player/bladeburner_manager.js` | `--sf 6` | Bladeburner actions queued | No crash; ns.bladeburner.inBladeburner() returns true |
| `player/sleeve_manager.js` | `run /player/sleeve_manager.js` | `--sf 10` + DevMenu click | Sleeve tasks assigned | No crash; ns.sleeve.getNumSleeves() > 0 |
| `player/stanek_manager.js` | `run /player/stanek_manager.js` | `--sf 13` | Stanek fragment placed / charged | No crash; ns.stanek.giftWidth() > 0 |
| `player/grafting_manager.js` | `run /player/grafting_manager.js` | `--sf 10` | Grafting augmentation queued | No crash; ns.grafting.getGraftableAugmentations() non-empty |
| `player/hacknet_status.js` | imported | — | — | — |
| `player/stock_status.js` | imported | — | — | — |
| `player/contract_manager.js` | `run /player/contract_manager.js` | None | Contract solutions attempted | No crash; terminal shows solved / skip |
| `player/contract_solver.js` | imported | — | — | — |
| `player/goto.js` | imported | — | — | — |

### §3.5 Stock

| Script | How to launch | Cheat first | Expected observable | Pass criteria |
|---|---|---|---|---|
| `stock/main.js` | `run /stock/main.js` | `--sf 5 --money 1e10` | WSE account purchased; trades start | No crash; position data in `status/` |

### §3.6 Workers

| Script | How to launch | Cheat first | Expected observable | Pass criteria |
|---|---|---|---|---|
| `workers/simple_hack_loop.js n00dles` | `run /workers/simple_hack_loop.js n00dles` | None | Loops hack on n00dles | No crash; runs for 5 s |
| `workers/hack.js n00dles 1` | `run /workers/hack.js n00dles 1` | None | Single hack, exits | PID > 0; no crash |
| `workers/grow.js n00dles 1` | `run /workers/grow.js n00dles 1` | None | Single grow, exits | PID > 0; no crash |
| `workers/weaken.js n00dles 1` | `run /workers/weaken.js n00dles 1` | None | Single weaken, exits | PID > 0; no crash |
| `workers/share.js` | `run /workers/share.js` | None | Share loop running | PID > 0; in ps |
| `workers/auto_grow.js` | `run /workers/auto_grow.js` | None | Auto-grow on target | PID > 0; no crash |

### §3.7 UI / console

| Script | How to launch | Cheat first | Expected observable | Pass criteria |
|---|---|---|---|---|
| `ui/console_types.js` | imported only | — | — | — |
| Console panels | Launched by sequencer / brain.ts when UI is up | — | Panels rendered in game UI | No crash; panels visible in dev build |

### §3.8 Dev

| Script | How to launch | Cheat first | Expected observable | Pass criteria |
|---|---|---|---|---|
| `dev/cheat.js` | `run /dev/cheat.js --sf 4` | None (it IS the cheat) | tprint confirms grants | "DEV CHEAT applied" message; no error |

---

## §4 Type-safety ≠ runtime-safety guardrail

### §4.1 The audit rule

`src/types/ns-augment.d.ts` is a **liar file by construction**: it adds declarations that the game
engine may never have honored, or once honored and later removed. Treat it as suspect. Every
declaration there must pass both checks:

**Check A — canonical type:** does the declaration already exist in `NetscriptDefinitions.d.ts`?
If yes, the augmentation is redundant at best and conflicts at worst. Remove it from ns-augment.

**Check B — runtime existence:** does the API exist *in the game engine right now*? Verify via:
1. `grep -n "<apiName>" /home/shane/workspace/bitburner-src/src/utils/APIBreaks/3.0.0.ts` — if it
   appears, the API was removed in 3.0 and will crash.
2. `grep -rn "<apiName>" /home/shane/workspace/bitburner-src/src/NetscriptFunctions.ts` — the
   live surface. If absent, the API does not exist.
3. For Player properties: check `NetscriptDefinitions.d.ts`'s `Player` interface and
   `src/PersonObjects/Player/PlayerObject.ts` in the game source.

### §4.2 Current audit findings (verified 2026-06-30)

**🔴 LIVE BUGS — crash at runtime (same class as formatNumber):**

| Declaration in ns-augment.d.ts | Status | Correct v3 API |
|---|---|---|
| `NS.getPurchasedServers()` | Removed in v3.0.0 | `ns.cloud.getServerNames()` |
| `NS.getPurchasedServerCost(ram)` | Removed in v3.0.0 | `ns.cloud.getServerCost(ram)` |
| `NS.getPurchasedServerLimit()` | Removed in v3.0.0 | `ns.cloud.getServerLimit()` |
| `NS.purchaseServer(hostname, ram)` | Removed in v3.0.0 | `ns.cloud.purchaseServer(hostname, ram)` |
| `NS.deleteServer(host)` | Removed in v3.0.0 | `ns.cloud.deleteServer(host)` |

Source: `bitburner-src/src/utils/APIBreaks/3.0.0.ts` lines 438-450.

**Affected callers** (all crash when the relevant code path executes):
- `src/compute/target_selector.ts` — `ns.getPurchasedServers()`
- `src/compute/hwgw_batcher.ts` — `ns.getPurchasedServers()`
- `src/compute/pserv_manager.ts` — all five deprecated calls
- `src/compute/ram_manager.ts` — `ns.getPurchasedServers()`
- `src/lib/servers.ts` — `ns.getPurchasedServers()`
- `src/player/program_acquirer.ts` — `ns.getPurchasedServers()`

**Fix procedure:**
1. Remove all five declarations from `src/types/ns-augment.d.ts`.
2. Migrate callers: `s/ns\.getPurchasedServers()/ns.cloud.getServerNames()/g` etc.
3. `npx tsc --noEmit` → zero errors confirms migration is complete.
4. Run the runtime smoke (§4.3) to confirm the calls no longer crash.

**🟡 VERIFY before using — Player properties:**

| Declaration | Used via | Risk |
|---|---|---|
| `Player.workMoneyGainRate?` | `(player as any).workMoneyGainRate ?? 0` | `?? 0` fallback prevents crash; check actual runtime property name |
| `Player.workRepGainRate?` | Not used in code (only declared) | Low — unused; can remove |

Action: in the running game, open browser console, evaluate
`Player.workMoneyGainRate !== undefined` to confirm existence. If absent, remove the declaration
(the `?? 0` fallback already handles it; the declaration serves no purpose).

**🟢 SAFE (verified in NetscriptDefinitions.d.ts):** None of the remaining declarations in
`ns-augment.d.ts` appear already in `NetscriptDefinitions.d.ts`; the pserv ones were the only
conflicts. After the fix, `ns-augment.d.ts` should contain ONLY the corrected Player properties.

### §4.3 Runtime smoke procedure (make it repeatable)

Run after every change to `ns-augment.d.ts` or any `src/compute/*.ts` file:

```
# Step 1: build
npx tsc
# Expected: zero errors.

# Step 2: smoke the cheapest script that touches each dangerous API
# (pserv_manager — safe to run; will just see no servers to buy yet)
run /compute/pserv_manager.js
# Expected: runs for ≥ 3 s without "Function removed" crash.
# If it crashes, read the terminal output. "getPurchasedServers is not a function"
# or similar → the migration in Step 1 missed a caller.

# Step 3: smoke workers (catch any worker-level augment issues)
run /workers/simple_hack_loop.js n00dles
# Expected: no crash; let run for 5 s.

# Step 4: smoke the player sequencer (catches Singularity API issues if SF4 missing)
run /dev/cheat.js --sf 4
run /cross/player_sequencer.js
# Expected: sequencer runs ≥ 10 s without crash.

# Step 5: check terminal for any "removed" or "is not a function" lines.
# If clean: smoke passed.
```

**How to make it repeatable:** this procedure can be encoded as a MCP terminal script sequence
that a dev agent fires after each build. The agent reads `status/screen.txt` 10 s after each
launch to check for crash strings.

### §4.4 Ongoing protection

1. **Never add to `ns-augment.d.ts` without running Check A + Check B first.**
2. **After a Bitburner version upgrade:** re-run Check B on every declaration in ns-augment
   against the new `APIBreaks/*.ts` files. The game has a history of removing top-level APIs
   between minor versions (3.0.0 removed a large batch).
3. **Add a CI comment:** above each declaration in `ns-augment.d.ts`, add a comment citing the
   source that proves runtime existence, e.g. `// runtime: NetscriptFunctions.ts:1567 (cloud.*)`.

---

## §5 Concurrency-ready build plan

Reference: [[10-parallel-build-playbook]] for the full wave structure and gotchas (especially the
Wave-0 push-before-fan-out rule).

### §5.1 When to use this

Any time the audit (§4) or the script matrix (§3) reveals multiple disjoint files that need
updating: run Wave 0 solo to freeze the contract, then fan out agents in Wave 1.

### §5.2 Immediate task: ns.cloud.* migration (do this before spawning anything)

This is a pre-wave fix because it affects a shared type file. Do it solo:

```
Wave 0 (solo, ~15 min):
  1. Remove the five pserv declarations from src/types/ns-augment.d.ts.
  2. Update all six callers to ns.cloud.*:
       ns.getPurchasedServers()   → ns.cloud.getServerNames()
       ns.getPurchasedServerCost() → ns.cloud.getServerCost()
       ns.getPurchasedServerLimit() → ns.cloud.getServerLimit()
       ns.purchaseServer()        → ns.cloud.purchaseServer()
       ns.deleteServer()          → ns.cloud.deleteServer()
  3. npx tsc → zero errors.
  4. Push to origin/main (required by §3 of design/10 before fan-out).

Wave 1 (agents if other files also need work):
  - Each agent owns ONE file. Brief them with the frozen cloud.* API.
  - Verify: npx tsc --noEmit passes in each worktree.

Wave 2 (solo):
  - Integrate, run runtime smoke (§4.3), commit.
```

### §5.3 Acceptance criteria for any parallel build

Per [[10-parallel-build-playbook]] §4:

- `npx tsc --noEmit` → zero errors on `main` after integration.
- `npx tsc` (emit) → `dist/` updated with no errors.
- `node --check dist/<changed>.js` → zero syntax errors.
- Runtime smoke (§4.3) passes for every changed script.
- `ns-augment.d.ts` audit (§4.1) passes: all declarations have a Check A + Check B comment.

---

## §6 Agent operating procedure (summary for dev agents)

An agent following this doc should execute in this order:

```
1. Startup sequence (§1.3): build → bridge → browser-bootstrap game_agent.
2. Verify game_agent is running: mcp__bitburner__terminal ping.
3. For each script under test:
   a. Apply the cheat recipe from §2.3 if the script is SF-gated.
   b. Launch via MCP terminal.
   c. Wait ≥ 5 s; read status/screen.txt or status/notifications.txt.
   d. Check pass criteria from §3 matrix.
   e. On crash: read terminal output; check for "removed"/"not a function" strings.
      If found: run ns-augment audit (§4.1 Check B) on the called API.
4. After any code change:
   a. npx tsc → zero errors.
   b. Runtime smoke (§4.3).
5. Before a wide fan-out build: push Wave 0 commit to origin (design/10 §3).
```

---

## §7 Open questions / TODO

- [ ] Confirm `Player.workMoneyGainRate` runtime existence via browser console eval.
- [ ] After ns.cloud.* migration: re-run the full §3 matrix to confirm no other deprecated calls.
- [ ] Encode §4.3 smoke as a repeatable MCP command sequence (a shell script or saved agent step).
- [ ] After next Bitburner version bump: re-audit ns-augment against new `APIBreaks/*.ts`.
- [ ] Determine whether `workRepGainRate` (declared but never used in code) should be removed.

---

## §8 Live-validation findings (first harness run, 2026-06-30)

A Sonnet agent ran §1.3 startup + the §2/§3 smoke against the dev build. **All smoke targets passed:** `dev/cheat.js --sf 4` ran with no `formatNumber` crash; the sequencer produced `status/player_state.json` + `status/subsystems/{gang,hacknet,stock}.json` + heartbeat (confirming the "stale console = no producer running" diagnosis); and after `--sf 2 --karma -54000` + faction membership, `gang.json` went `available:true, running:true` ("Slum Snakes — 3 members"). The §4.2/§5.2 `ns.cloud.*` migration is **DONE** (commit `58e135a`), so those 🔴 rows are resolved.

Operational gotchas to fold into the harness procedure:

1. **RFA port not persisted across game loads.** Fresh load → `get_status` shows `game:false`; reconnect via Options → Remote API → Port 12525 → Connect. Ordering matters: connect → `game:true` → only then does `push_file` work.
2. **claude-in-chrome may be absent** (extension not installed) → fall back to `mcp__playwright__*`. Both are valid Step-3 bootstrap browsers.
3. **⚠ Terminal submit — CONFIRMED BUG (source-verified 2026-06-30).** `launcher.ts` `runTerminalCommand` calls `handlers.onChange({target:{value:cmd}})` then `handlers.onKeyDown({key:'Enter'})` **synchronously**. But the game's `TerminalInput.tsx` `onKeyDown` reads the command from `value` (React **state**, line 244), and the captured `onKeyDown` closure still holds the PRE-`onChange` value (the `setValue` hasn't re-rendered yet) — so Enter submits the stale/empty value: the text shows in the input box but nothing runs. **Blast radius:** `runTerminalCommand` is called only by `game_agent` (the MCP/control channel) and `launcher`'s own helpers — the brain launches daemons via `ns.exec`/`ns.run`, so **autoplay is NOT blocked**; this breaks the dev/agent terminal path. **Fix direction:** use native events (native value-setter + dispatch a real `input` event, then a real `keydown` Enter), OR re-read `handlers` off the fiber after a render tick so `onKeyDown` closes over the fresh `value`. Verify the fix by running it, not on a green tsc. Same React-synthetic-vs-native theme as [[12-navigation-interaction-layer]] §1's isTrusted audit. [[mcp-act-path-gotchas]]
4. **`game_agent` ≈ 8 GB.** On a fresh 8 GB home it leaves no room for `cheat.js` (chicken-egg for `--ram`). Dev workaround: set `Player.getHomeComputer().maxRam` directly via Playwright before cheating. NOTE: `game_agent` is the MCP/attended control channel — NOT required for headless autoplay — so this is a dev-loop cost, not an autoplay blocker.
5. **Same chicken-egg, MCP-only variant (no browser attached, 2026-07-01).** If `game_agent.js` is the only thing consuming the RAM headroom (e.g. `brain.js` also can't fit alongside it on a fresh 8 GB home), you don't need Playwright — just have the human type the sequence directly in the game terminal, since killing `game_agent.js` drops the MCP control channel (and its file-relay fallback, which also depends on `game_agent.js` polling `status/.cmd.json`) mid-flight, so the agent can't inject the follow-up commands itself:
   ```
   kill /cross/game_agent.js
   run /dev/cheat.js --ram <n>
   run /cross/game_agent.js   # optional — only needed for MCP observability, not gameplay
   run /brain.js
   ```
   `get_status` will show `controlConnected:false` for the few seconds between the `kill` and the second `run` — that's expected, not a bug.
5. **No `notifications.txt` in steady state is HEALTHY** — the sequencer only notifies on events (e.g. "SF4 missing"); a quiet baseline = no news, not a failure.
6. **Playwright MCP `browser_click`/`browser_type` need a `target`/ref arg** not obvious from the tool name; `browser_evaluate` is the reliable fallback for in-page logic.
