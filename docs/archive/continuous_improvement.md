# Bitburner Automation — Continuous Improvement

## Philosophy: Hack the Game, Not the Browser

We play by the game's rules. The tools we have are exactly what a Bitburner player has — or automations of what a player *could* do manually.

### The Boundary

| ✅ IN-BOUNDS (player-level) | ❌ OUT-OF-BOUNDS (engine-level) |
|---|---|
| **Remote File API** — push/pull files via WebSocket (the game built this for external editors) | **Save file editing** — no `loadSave` RPC; modifying state directly |
| **Netscript API** (`ns.*`) — what any running script can do | **Sandbox escapes** — `requestAnimationFrame` persistence, `e.env.stopFlag` manipulation |
| **DOM / UI** — `eval("document")` from scripts is a documented game mechanic (Source-File -1: Exploits). We can read the screen, click buttons, type into inputs — same as a player. | **CDP `Runtime.evaluate`** — injecting arbitrary JS into the game's main process context to access engine internals |
| **Browser automation** — Playwright/Puppeteer attaching to the game window to click, type, screenshot. This is automating what a player does with their mouse and keyboard. The player sees the UI; we can too. | **Source code modification** — custom game builds, patching `MessageHandlers.ts` to add RPC methods |
| **Files on servers** — reading/writing `.txt` and `.js` files | **Memory inspection** — reading game variables that aren't on screen |

### The Test

> If a player could do it by looking at the screen, typing in the terminal, clicking a button, or writing a script — it's fair game. If it requires a debugger attached to the game process, a hex editor on the save file, or a recompiled binary — it's out.

### The Stack

```
[Claude + MCP]  ←→  [Bridge:12526]  ←→  [Game:12525]
     ↕                                        ↕
[push_file / read_file]                [Game Agent (NS script)]
     ↕                                        ↕
[/status/.cmd.json]  ──→  agent polls  ──→  [ns.run() + DOM terminal injection]
                                                  ↕
                                        [ANY terminal command or script]

Future (if needed):
     ↕
[Playwright / Puppeteer]  ──→  attach to game window  ──→  click, type, screenshot
```

### Key Insight: The DOM IS the UI

Bitburner scripts have access to `eval("document")` — the full browser DOM. This means a running script can:
- **Read the screen** — scrape text from terminal output, sidebar stats, log windows
- **Type into the terminal** — set `terminal-input` value, simulate Enter keypress
- **Click buttons** — dispatch click events on UI elements
- **Inject visual overlays** — add custom HTML/CSS panels

Bitburner's own documentation covers HTML injection as an exploit technique. It's not a bug — it's part of the game. Combined with file I/O (our bridge to Claude), we can build a remote terminal that types whatever a player could type.

**Rule of thumb for all future agents:** Automate the player, not the engine. If you need `--remote-debugging-port` to access something a player can't see on screen, you're crossing the line. If you're clicking a button a player could click, you're fine.

---

## Goal: Fully Autonomous, Repeatable Gameplay

**The system must play Bitburner from a fresh start with zero human intervention** beyond connecting the game to the bridge. Every judgment call — what to hack, when to upgrade, how to spend RAM — must be encoded as a strategy that the in-game agent executes autonomously.

Claude's role is **architect and observer**, not player. Claude designs the strategies, deploys them, observes their performance via status files, and iterates. The in-game agent makes real-time decisions.

### The Autonomy Stack

```
┌─────────────────────────────────────────────────────────┐
│  CLAUDE (architect)                                     │
│  - Designs strategies                                   │
│  - Reads status/*.txt to observe results                │
│  - Identifies problems → writes plan → user gates       │
│  - Deploys new strategy code via push_file              │
└─────────────────────────────────────────────────────────┘
                          ↕ (MCP: push_file / read_file)
┌─────────────────────────────────────────────────────────┐
│  GAME AGENT (brain) — runs in-game, makes decisions     │
│  - Reads game state (ns.* APIs)                         │
│  - Executes current strategy                            │
│  - Adapts to conditions (RAM, money, unlocks)            │
│  - Writes status snapshots + decision log               │
└─────────────────────────────────────────────────────────┘
                          ↕ (ns.exec / ns.run)
┌─────────────────────────────────────────────────────────┐
│  WORKER SCRIPTS — lightweight, single-purpose            │
│  - hack.js, grow.js, weaken.js, share.js                │
│  - scan_nuke.js, auto_grow.js                           │
│  - purchase_server.js, port_openers.js                  │
└─────────────────────────────────────────────────────────┘
```

### Design Principles

1. **The agent is the brain.** It calls `ns.*` to read game state and makes decisions. Claude only reads `status/*.txt` snapshots — never makes real-time gameplay decisions.

2. **Strategies are code, not ad-hoc commands.** "Hack the highest-value target" is a function. "If home RAM < 20%, buy an upgrade" is a function. Claude designs and deploys these functions; the agent runs them.

3. **Condition-agnostic.** The same agent must work on a fresh 8GB home with 0 port openers AND on a late-game 1TB home with all unlocks. It reads the current state and picks the right strategy.

4. **Observable.** Every decision the agent makes is logged to a status file. Claude can read `status/decisions.txt` to understand WHY the agent did something, not just WHAT it did.

5. **Repeatable.** Reset the game, reconnect the bridge, push the agent, and it plays again — making appropriate decisions for whatever state it finds.

### Game Phases & Strategy Map

Each phase has a corresponding strategy module the agent loads based on current conditions.

| Phase | Condition | Strategy | Key Actions |
|---|---|---|---|
| **Bootstrap** | Home < 16 GB RAM, 0 servers rooted | Get a command relay running on the best available server | Deploy minimal boot agent, root 0-port servers, find largest rooted server, relay heavier agent there |
| **Snowball** | < 5 rooted servers, no port openers | Accumulate money for port openers | Simple hack loop on best available target, buy port openers in order |
| **Expansion** | Port openers available, servers unrooted | Root everything reachable | scan_nuke with port openers, deploy hack farm to all rooted servers |
| **Preparation** | Targets rooted but not at max money/min security | Prepare batch hack targets | auto_grow on best targets, wait for prep |
| **Batch** | Targets prepared, sufficient RAM farm | Run HWGW batch cycles | batch_hack with full engine stack |
| **Endgame** | High income, all servers rooted | Optimize for max $/s | Faction rep, augmentation, BitNode reset |

### What We're Building vs. What Claude Does

| Layer | Runs where? | Makes decisions? | Replaced by Claude? |
|---|---|---|---|
| Worker scripts (hack, grow, weaken) | Any rooted server | No — pure functions | No |
| Game agent (strategy engine) | Best rooted server | Yes — chooses targets, allocates RAM, decides when to upgrade | No |
| Status reporter | Alongside agent | No — writes snapshots | No |
| Claude | External (MCP) | Architectural only — what strategies to write, what bugs to fix | — |

---

## The Human-in-the-Middle Loop

This project runs as a **human-in-the-middle loop** where Claude plays the game, observes problems, and the user dispatches agents to plan and build fixes.

```
PLAY  →  OBSERVE  →  REPORT  →  USER  →  PLAN  →  BUILD  →  PLAY  →  ...
```

### Phase 1: PLAY & OBSERVE (Claude)
1. Read live game state via MCP tools (`read_file` on `status/*.txt`, `list_servers`, `list_files`)
2. Monitor processes, RAM usage, income rate, hacking progress
3. Identify problems: bottlenecks, logic bugs, missing capabilities, inefficiencies
4. Write problems down in this doc under the current wave's "Observations" section
5. **Do NOT write code during this phase.** Only observe and record.

### Phase 2: REPORT (Claude → User)
When problems are significant enough that they block progress or represent clear wins:
1. Present findings to the user: "Here are the N problems I found, ranked by impact"
2. Propose fixes for each problem
3. **STOP.** Wait for user to decide.

### Phase 3: PLAN (Independent Planning Agent)
User dispatches a **separate planning agent** that:
1. Reads the problems from this doc
2. Ground-truths every claim against actual source code and types
3. Produces an actionable plan with exact files, functions, and changes
4. Writes the plan into this doc

### Phase 4: BUILD (Independent Building Agent)
User dispatches a **separate building agent** that:
1. Reads the plan from this doc
2. Implements changes via subagents (NOT trunk edits)
3. Cleans up residue
4. Marks items complete in this doc

### Phase 5: `/compact`
After every phase, `/compact` to reset context. The next phase starts fresh by reading this file.

**Rule:** At the start of every session, open this file first. It is the single source of truth for what's done, what's next, and what's blocked.

### Why This Loop?

- **Separation of concerns** — observing, planning, and building are different mental modes
- **Human gating** — user decides when problems are worth fixing, preventing premature optimization
- **Independent verification** — planning agent ground-truths against real code; building agent implements against plan; neither hallucinates from observing agent's context
- **Context budget** — `/compact` between phases keeps each phase's context focused on its task

---

## Ground Rules (Standing — All Waves)

These apply to every wave without needing to re-establish them.

- **User controls process lifecycle.** Never start long-lived commands (watchers, servers, game bridges). The user runs `pnpm run watch:all`. Ask if unsure.
- **Hoist `ns.*` calls out of loops.** If a result is stable within a loop's lifetime, call it once before the loop. Every `ns.*` call has overhead in Bitburner's JS runtime.
- **Cache collections as Sets before membership checks.** `array.includes()` inside a loop is O(n²). `new Set(array)` + `.has()` is O(n).
- **Verify dead code has no imports before deleting.** Run grep on `src/` before removing a file.
- **Performance claims require observable evidence.** A code-reading argument ("this saves X GB") is a hypothesis. Only MCP tool output or in-game log output confirms it. Mark unverified claims as hypotheses.
- **No residue.** After every fix: check for unused variables, dead branches, or stale references introduced by the edit.

---

## Wave 1 — BUILD (2026-06-28)

### DONE

**API call reduction — repeated `ns.*` calls hoisted out of loops:**

| File | Fix |
|---|---|
| `src/engine/server_manager.ts` | `getPurchasedServers()` hoisted before filter; `Set.has()` replaces `Array.includes()` |
| `src/engine/batch_util.ts` | Same `getPurchasedServers().includes()` pattern in `getTargetServers()` |
| `src/engine/ram_manager.ts` | `getPurchasedServers()` called once at top of `updateRamInfo()`; reused as a `Set` for the per-server skip check (was called again per server in the loop) |
| `src/contracts/midgame_hack.ts` | `ns.ps('home')` hoisted before 71-server loop in `updateServerInfo()` — was 71 calls/tick, now 1 |
| `src/engine/auto_grow.ts` | `this.ns.ps()` hoisted before targets loop in `waitForPreparation()` — was N calls per iteration, now 1 |
| `src/engine/thread_manager.ts` | `getTotalFreeRam()` cached before debug log (was called twice per operation check) |

**Logic bugs fixed:**

| File | Bug | Fix |
|---|---|---|
| `src/engine/allocator.ts` | `free()` always reset `serverUtilization[i]` to 0. Root cause: computed `totalCapacity = this.availableAllocs[i]` *after* adding freed threads back, so `used = totalCapacity - this.availableAllocs[i]` was always 0. Server ranking based on utilization was broken after any free(). | Added `private readonly totalCapacity: number[]` stored at construction. Both `alloc()` and `free()` now use it as the stable denominator: `1 - (availableAllocs[i] / totalCapacity[i])`. |
| `src/engine/batch_hack_manager.ts` | `weaken2Time` was a duplicate `getWeakenTime()` call identical to `weaken1Time` | `weaken2Time = weaken1Time` |
| `src/engine/batch_hack_manager.ts` | `await ns.sleep(1)` inside batch allocation loop and hack thread search loop — added ~20ms latency per target per scheduling cycle with no benefit | Removed both sleeps |

**Dead code removed:**

| What | Why |
|---|---|
| `src/tools/autonuke.ts` (source deleted) | `scan_nuke.ts` was rewritten to inline nuke logic; `autonuke.ts` had no remaining callers |
| `tools/autonuke.js` (deleted from game server) | Same — deployed dead code |
| `src/tools/scan_nuke.ts` rewrite | Old version called `ns.run('/tools/autonuke.js', 1, host)` per server — up to 70 persistent 1.75 GB child processes per sweep. New version inlines the logic and checks port opener existence once upfront. |

**Other cleanups:**

| File | Fix |
|---|---|
| `src/contracts/batch_hack.ts` | `prepared` array was populated but never consumed — removed. Two-filter O(n) pattern (`targets.filter(isServerPrepared)` then `targets.filter(!isServerPrepared)`) replaced with single pass. |

### BLOCKER — Monitoring Gap

**None of Wave 1's performance claims have been verified.** We changed code we believe reduces API call overhead, but we have no instrumentation to confirm the effect.

Currently available MCP tools: `list_servers`, `list_files`, `read_file`, `calculate_ram`, `push_file`, `delete_file`, `get_save`, `get_status`

**Missing tools needed to observe the game:**

| Tool | Bitburner API | Purpose |
|---|---|---|
| `get_processes` | `ns.ps(server)` | See what scripts are running, thread counts, args |
| `get_server_ram` | `ns.getServerMaxRam` + `ns.getServerUsedRam` | Verify actual RAM usage; confirm batch jobs aren't piling up |
| `get_script_logs` | `ns.getScriptLogs(script, host, lines)` | Read live output from the batch hack loop |
| `get_player` | `ns.getPlayer()` | See hacking level, income rate, money |

Until these exist, every "optimization" claim is a hypothesis, not a result.

---

## Wave 2 — BUILD (2026-06-28) ✓ COMPLETE

### Plan Corrections (ground-truth audit before building)

| Claim in original PLAN | Reality |
|---|---|
| Add MCP tools calling `ps`/`getPlayer` to bridge | Bridge is transparent proxy; Bitburner remote API doesn't expose those. Correct: game-side status reporter → `.txt` files → existing `read_file` tool |
| Track B Issue 2: "four RAM loops at line 201" | Wrong — line 201 is unrelated. Real issue: `distributeThreads()` computed free RAM in sort comparator AND allocation loop |
| Track B Issue 3: "100×, max 10s poll" | Wrong — was `i < 1000`, not `i < 100`. Max **100 seconds**, not 10. |

### Code Fixes

| File | Fix | Impact |
|---|---|---|
| `src/contracts/midgame_hack.ts` | `distributeThreads()`: precompute `freeRamMap` before sort; comparator + allocation loop read from map | N API calls instead of N log N per scheduling cycle |
| `src/contracts/batch_hack.ts` | `nukeAll()`: replace 1000-iteration `isRunning` poll (max 100s) with `if (pid > 0) await ns.sleep(2000)` | Eliminates pointless 5–100s polling per nuke interval |

### Monitoring (Track A)

**New file:** `src/monitor/status_reporter.ts` — game-side daemon writing JSON snapshots every 5s:
- `status/player.txt` — `ns.getPlayer()`: hacking level, money, playtime, skills
- `status/ram.txt` — per-server `{ hostname, maxRam, usedRam, freeRam, admin }` + totals across rooted servers
- `status/processes.txt` — `ns.ps('home')`: `{ filename, threads, pid }`

**How to use** (via existing MCP tool):
```
read_file { filename: "status/player.txt" }
read_file { filename: "status/ram.txt" }
read_file { filename: "status/processes.txt" }
```

RAM cost: ~3.5 GB. Auto-launched idempotently from both `batch_hack.ts` and `start_hack.ts`.

### Residue Cleanup

| File | Removed |
|---|---|
| `src/contracts/batch_hack.ts` | `formatMoney` import, `formatBatchInfoPanel` import, `FormulaHelper` import + `formulas` construction (all dead) |
| `src/contracts/midgame_hack.ts` | `const player = ns.getPlayer()` (dead variable + wasted API call per tick) |
| `src/engine/batch_util.ts` | `Player` from `@ns`, `formatRam` and `formatPercent` from `'../lib/format'` (all unused) |

---

## Wave 3 — PLAY & OBSERVE (2026-06-28)

### Phase 1: Bug Discovery

Bugs found during startup and code audit — no gameplay observation possible yet (user hasn't run scripts).

#### B1: Bridge `ignoreInitial` prevents initial file sync
- **File:** `build/game-bridge.ts:136`
- **Bug:** `chokidar.watch` uses `ignoreInitial: true`. In daemon mode (which `pnpm run watch:all` runs), existing `dist/` files never get pushed on startup. Only *changes* trigger sync.
- **Symptom:** Fresh game start → 0 files on home → must manually push.
- **Fix:** Either set `ignoreInitial: false` or call `pushAllFiles()` on daemon startup.
- **Status:** Documented, not yet fixed.

#### B2: File sync is dumb-firehose, not intelligent sync
- **Current behavior:** Bridge watches `dist/` with chokidar (`ignoreInitial: true`), pushes on change. On first connect or reconnect, existing files are never pushed unless they happen to change. There's no comparison — it just fires and forgets.
- **What proper sync looks like:**
  1. On connection (or reconnect), fetch remote file list via `getAllFiles` (returns `{filename, content}[]` in one call)
  2. Hash/compare remote content vs local `dist/` content
  3. Push only files that are missing or differ
  4. Optionally delete remote files that don't exist locally
  5. After initial sync, the watcher handles incremental changes
- **Missing piece:** The game API already has `getAllFiles` (returns all files + content on a server). Our bridge (`game-bridge.ts`) and MCP (`index.ts`) don't use it. Adding it enables content-aware sync instead of blind push.
- **Impact:** High. Every fresh game start has 0 files until something changes in `src/`. Manual pushes required. Reconnects after disconnection leave the game in whatever state it was in.
- **Status:** Documented. Needs `getAllFiles` added to MCP + sync engine rewrite in bridge.

#### B3: No programmatic `run`/`exec` — fundamental limitation
- **Source:** `bitburner-src/src/RemoteFileAPI/MessageHandlers.ts:88-263`
- **Reality:** The remote API handler (`RFARequestHandler`) is a hardcoded whitelist of 11 methods. `Remote.ts:122` rejects unknown methods with "Unknown message received". There is no remote execution capability.
- **No exploits available** through the WebSocket layer — no command injection via filenames, no save file upload, no port-based communication.
- **Resolution path:** Either (a) game-side agent polling command files, (b) DOM injection, or (c) Chrome DevTools Protocol.

---

### Phase 1b: Attack Surface Analysis — All Routes to Programmatic Control

How do we execute code in the game without typing in the terminal? Five routes identified.

#### Route A: File Bridge + Game Agent ✅ IN-BOUNDS
**How:** Push `.cmd.json` via `push_file` → game agent polls every 200ms → `ns.run()` / `ns.exec()` → writes `.result.json` → MCP reads it.

| Aspect | Detail |
|---|---|
| Setup | Run `game_agent.js` once manually |
| Latency | ~200ms |
| Reliability | High — simple file I/O, no DOM dependency |
| Risk | Low — uses public NS API |
| File | `src/monitor/game_agent.ts` |

**Command format:**
```json
{"id": "cmd-1", "method": "run", "script": "/tools/scan_nuke.js", "threads": 1}
```
**Result format:**
```json
{"id": "cmd-1", "success": true, "pid": 42}
```

Supported methods: `run`, `exec`, `kill`, `killall`, `ps`, `getPlayer`, `getServer`.

**Verdict:** Works today. The one-time manual `run game_agent.js` is the only human step.

---

#### Route B: DOM Terminal Injection ✅ IN-BOUNDS
**How:** A running script uses `eval("document")` to access the terminal input element, set its value to any command, and simulate an Enter keypress. This runs ANY terminal command as if the user typed it.

```javascript
const doc = eval("document");
const input = doc.getElementById("terminal-input");
const key = Object.keys(input)[1];
input.value = "run /tools/scan_nuke.js";
input[key].onChange({target: input});
input[key].onKeyDown({key: 'Enter', preventDefault: ()=>0});
```

| Aspect | Detail |
|---|---|
| Setup | Run injector script once manually |
| Latency | Near-zero (synchronous DOM manipulation) |
| Reliability | Medium — depends on DOM structure not changing |
| Risk | Low — Bitburner officially documents this as an exploit (Source-File -1) |
| Reference | `bitburner.readthedocs.io/en/latest/netscript/advancedfunctions/inject_html.html` |

**Verdict:** Viable alternative to Route A. Faster (no polling), but more fragile. Could be used as the execution backend for the game agent instead of `ns.run()` — letting us run ANY terminal command, not just `ns.run()`-compatible ones.

---

#### Route C: Chrome DevTools Protocol (CDP) — SPLIT VERDICT
**How:** Start Bitburner with `--remote-debugging-port=9222` (Steam launch option). External tool connects via CDP WebSocket.

**Two uses, different verdicts:**

| Use | Mechanism | Verdict |
|---|---|---|
| **Playwright/Puppeteer UI automation** | CDP used to connect browser automation. Clicks buttons, types in terminal, takes screenshots. Automating what a player's hands/eyes do. | ✅ IN-BOUNDS |
| **`Runtime.evaluate` into engine** | CDP used to inject arbitrary JS into game process. Access internal variables, call private functions. | ❌ OUT-OF-BOUNDS |

**Verdict:** CDP-as-transport for UI automation is fine — it's just automating mouse/keyboard. CDP-as-code-injection is not. The problem is that without the `--remote-debugging-port` flag, neither works. And even with it, the game must be the Steam version (web version can't accept launch flags easily). So practical use is limited.

---

#### Route D: Sandbox Escape (persistent) ❌ OUT-OF-BOUNDS
**How:** Use `({}).constructor.constructor('return this')()` to escape the NS sandbox, then `requestAnimationFrame` to persist code execution after the script is killed, with `e.env.stopFlag = false` and spoofed RAM costs.

| Aspect | Detail |
|---|---|
| Setup | Run escape script once |
| Latency | Frame-synchronized (~16ms) |
| Reliability | Low — fragile, may break on game updates |
| Risk | Medium — accessing internal game state unsafely |
| Reference | GitHub issue #2195 on danielyxie/bitburner |

**Verdict:** Clever but fragile. More useful for specific exploits than as a reliable bridge.

---

#### Route E: Save File Editing ❌ OUT-OF-BOUNDS
**How:** `getSaveFile` → modify save JSON → reload game. Could inject running processes, modify player state, add money/skills.

| Aspect | Detail |
|---|---|
| Setup | Manual save reload each time |
| Latency | Very high (full game restart) |
| Reliability | Unknown — save format may change |
| Risk | Save corruption |

**Verdict:** Not suitable for live control. Useful for one-time state modifications.

---

### Planned Improvements (prioritized for next BUILD wave)

These are the actionable items discovered during Wave 3 PLAY/OBSERVE.

#### P1: Proper File Sync Engine
**Goal:** Files sync automatically — if remote doesn't have a file or hash differs, push. Otherwise idle.

**Changes needed:**
1. **Add `getAllFiles` to MCP** (`build/game-bridge-mcp/src/index.ts`) — thin wrapper around the game's existing `getAllFiles` RPC, returns `{filename, content}[]` for a server
2. **Rewrite bridge sync logic** (`build/game-bridge.ts`):
   - On game connect: call `getAllFiles('home')`, compare each file's hash against local `dist/`, push mismatches
   - On watcher change: push single file (existing behavior, keep this)
   - On watcher add/delete: push/delete single file (existing behavior)
   - Remove `ignoreInitial: true` — the comparison-based sync makes it unnecessary
3. **Add `getAllFiles` to MCP tool list** — useful for debugging sync state

**Result:** Fresh game start → all files synced in one pass. Reconnect → differential sync. No manual pushes ever.

#### P2: DOM Terminal Injection Backend for Game Agent
**Goal:** Replace `ns.run()` in game_agent.ts with DOM terminal injection to support ALL terminal commands.

**Why:** `ns.run()` can only launch scripts. DOM injection can run `connect`, `backdoor`, `buy`, `scp`, and any other terminal command. This turns the game agent from a script runner into a full remote terminal.

**Changes needed:**
1. Add `eval("document")`-based terminal typing helper to `game_agent.ts`
2. Add `method: "terminal"` to the command format — passes raw string to terminal input
3. Keep existing `ns.run()`-based methods as fallback

#### P3: CDP Bridge (Optional, Long-Term)
**Goal:** True external control via Chrome DevTools Protocol — no in-game scripts needed.

**Why:** If we can connect via CDP, we can evaluate arbitrary JS in the game's global context. This bypasses the remote API entirely.

**Setup:** User adds `--remote-debugging-port=9222` to Steam launch options (one-time), bridge connects to `ws://127.0.0.1:9222`.

**Effort:** Medium — needs a CDP client in the bridge or a separate process. The `esbuild-bitburner-plugin` already demonstrates this pattern.

---

### Recommendation

| Priority | Item | Why | Bounds |
|---|---|---|---|
| **P1** | File sync engine | Fixes the "files not there on fresh start" root cause. Enables everything else. | ✅ In-bounds — uses Remote File API |
| **P2** | DOM terminal backend | Unlocks full terminal control. Game agent types commands into terminal via documented exploit. | ✅ In-bounds — `eval("document")` is a game feature |
| ~~P3~~ | ~~CDP bridge~~ | ~~Removed — accesses browser internals, not a player tool~~ | ❌ Out-of-bounds |

**The winning stack** (all in-bounds):
```
MCP push_file → game agent polls → DOM types into terminal → any command executes
```
This combines the Remote File API (legitimate), the NS API (legitimate), and DOM terminal injection (documented exploit — part of the game). Zero out-of-bounds dependencies.

---

---
     
## Wave 4 — PLAN: Strategy Engine (2026-06-28)

### Problem Statement

**Current state:** We have a command relay (`game_agent.ts` / `boot.js`) that can execute individual commands, but it has no brain. Every gameplay decision — which server to hack, when to buy port openers, how to allocate RAM — requires Claude to push a command via MCP. This does not scale, is not autonomous, and breaks the "repeatable gameplay" goal.

**Goal:** The in-game agent must make real-time gameplay decisions autonomously. Claude's role is architect and observer — designing strategies, deploying them, and reading decision logs to understand outcomes. The agent reads game state, picks a strategy, and executes it.

**Constraint:** Must work on a fresh game start (home = 8 GB RAM). The strategy engine must be lightweight enough to run alongside the boot agent or on a relayed server.

### 4.1 Architecture Decision: Strategy Functions in the Agent

After evaluating several approaches (detailed below), the chosen design is:

```
┌──────────────────────────────────────────────┐
│  GAME AGENT (runs on best available server)   │
│                                              │
│  main loop:                                  │
│    1. snapshotGameState(ns)  → GameState      │
│    2. detectPhase(state)     → Phase          │
│    3. strategy[phase](state) → Action[]       │
│    4. executeActions(actions)                 │
│    5. writeDecisionLog(state, phase, actions) │
│    6. writeStatusSnapshots()                  │
│    7. sleep(1000)                             │
└──────────────────────────────────────────────┘
```

**Why this vs. alternatives:**

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **A) Strategy functions in agent** | Single process, no IPC overhead, phase transitions are instant | Agent RAM cost must be kept low | ✅ CHOSEN |
| **B) Separate strategy scripts** per phase | Each strategy can be heavy, launcher is lightweight | Need to kill/restart scripts on phase transition, coordination overhead | ❌ Over-engineered for early game |
| **C) Claude-driven decision loop** | Maximum flexibility, easy to iterate | Requires Claude to be connected/active, latency per decision, not autonomous | ❌ Violates autonomy goal |
| **D) Behavior tree / decision tree** | Well-understood pattern, debuggable | Overly complex for 6 phases, adds RAM cost for tree evaluation | ❌ Over-engineered |

### 4.2 Phase Detection Algorithm

The phase detector is a **stateful** function: `detectPhase(state: GameState, prev: Phase, stability: PhaseStability) → Phase`. It runs every cycle (~1s). Purely computational (0 GB RAM — no ns.* calls inside, uses already-snapshotted state).

**Key design decisions (from audit F1, F2, F14):**

1. **Hysteresis** — phase transitions require N consecutive ticks of the new condition before switching. This prevents oscillation (e.g., PREPARATION ↔ BATCH every tick as hacks degrade targets).

2. **Regression allowed** — any phase can fall back to SNOWBALL (the safe default). If BATCH crashes or a server gets un-rooted, the agent drops to a simple hack loop rather than idling.

3. **SNOWBALL runs scan_nuke** — the strategy itself calls scan_nuke periodically (not just waiting for rootedCount to magically increase). Phase exit is based on having port openers AND having tried nuking, not a raw rootedCount threshold.

```typescript
enum Phase {
  BOOTSTRAP,    // Home ≤ 16 GB, need relay on bigger server
  SNOWBALL,     // Simple hack loop, accumulate money, buy port openers
  EXPANSION,    // Root everything with port openers available
  PREPARATION,  // Prepare batch targets (auto_grow)
  BATCH,        // Full HWGW batch cycles via batch_hack.js
}

// Hysteresis: must see N consecutive ticks of a new phase before switching
interface PhaseStability {
  candidate: Phase | null;       // candidate phase we might switch to
  consecutiveTicks: number;      // how many ticks we've seen this candidate
  readonly REQUIRED_TICKS: 5;    // ticks needed before switching (5s at 1s cycle)
}
```

```typescript
function detectPhase(s: GameState, prev: Phase, stab: PhaseStability): Phase {
  let target: Phase;

  // BOOTSTRAP: Home RAM ≤ 16 GB AND no relay established on another server.
  // Once a relay is confirmed running on a non-home server, exit bootstrap.
  if (s.homeMaxRam <= 16 && !s.relayRunningOn) {
    target = Phase.BOOTSTRAP;
  }
  // SNOWBALL: No port openers OR haven't finished rooting.
  // The strategy itself runs scan_nuke — the phase condition checks RESULTS.
  // Exit: we have port openers AND have scanned recently AND unrootedNukable == 0.
  else if (!s.hasAnyPortOpener || s.unrootedNukable > 0 || s.rootedCount < 5) {
    target = Phase.SNOWBALL;
  }
  // EXPANSION: Have port openers, unrooted servers exist AND we can nuke them.
  // This phase runs when we CAN expand but haven't finished.
  else if (s.unrootedNukable > 0) {
    target = Phase.EXPANSION;
  }
  // PREPARATION: Servers rooted, but targets not at min security / max money.
  // Hysteresis prevents oscillation: only enter if unprepared for 5+ consecutive ticks.
  else if (s.unpreparedTargets > 0 && prev === Phase.PREPARATION) {
    target = Phase.PREPARATION;  // Stay in PREPARATION if already there
  }
  else if (s.unpreparedTargets > 0) {
    // First tick seeing unprepared — stay in current phase, start stability count
    target = prev;  // don't switch yet
  }
  // BATCH: Targets prepared and stable. The default end-state.
  else {
    target = Phase.BATCH;
  }

  // ── Hysteresis gate ──
  if (target !== prev) {
    if (stab.candidate === target) {
      stab.consecutiveTicks++;
      if (stab.consecutiveTicks >= stab.REQUIRED_TICKS) {
        // Commit the phase transition
        stab.candidate = null;
        stab.consecutiveTicks = 0;
        return target;
      }
      return prev;  // not enough ticks yet
    } else {
      stab.candidate = target;
      stab.consecutiveTicks = 1;
      return prev;
    }
  } else {
    // Same phase — clear any pending candidate
    stab.candidate = null;
    stab.consecutiveTicks = 0;
  }

  return target;
}
```

**Regression path:** BATCH can fall back to PREPARATION (if targets degrade), and PREPARATION can fall back to SNOWBALL (if servers get un-rooted or port openers lost). This is handled by the top-down check order — earlier conditions always win.

**State snapshot** (collected once per cycle — no repeated ns.* calls):

```typescript
interface GameState {
  // Player
  hackingLevel: number;
  money: number;
  incomeRate: number;            // $/s from getPlayer()

  // Home
  homeMaxRam: number;
  homeUsedRam: number;
  homeFreeRam: number;

  // Relay (for bootstrap tracking)
  relayRunningOn: string | null; // hostname where strategy agent is running (or null if still booting)

  // Network
  rootedServers: string[];       // hostnames of rooted servers
  rootedCount: number;
  unrootedServers: string[];     // hostnames of reachable unrooted servers
  unrootedNukable: number;       // how many we CAN root (have enough ports AND port openers)

  // Per-server state (keyed by hostname)
  serverFreeRam: Map<string, number>;        // free RAM per rooted server
  hasDeployScripts: Map<string, boolean>;     // hack/grow/weaken deployed on this server?

  // Port openers
  hasBruteSSH: boolean;
  hasFtpCrack: boolean;
  hasRelaySmtp: boolean;
  hasHttpWorm: boolean;
  hasSqlInject: boolean;
  hasAnyPortOpener: boolean;
  maxPorts: number;              // how many ports we can open right now

  // Hack targets
  hackableServers: string[];     // rooted, money > 0, hacking level ≥ required
  bestTarget: string | null;     // highest-value target (cached)
  preparedTargets: string[];     // at min security + max money (90% money, +3 security)
  unpreparedTargets: number;     // count of hackable but not prepared

  // Running state
  isBatchHackRunning: boolean;   // is /contracts/batch_hack.js running?
  isRelayRunning: boolean;       // is the strategy agent running on a non-home server?

  // Economy
  totalRamPool: number;          // total free RAM across all rooted servers

  // Programs
  hasFormulas: boolean;
}
```

### 4.3 Strategy Functions (Per Phase)

Each strategy is a pure function: `(state: GameState, api: AgentAPI) → Action[]`. The function receives snapshotted state (no ns.* calls inside strategy) and an AgentAPI for executing actions. **All run/exec calls check return values (audit F7).**

**Defined constants** (audit F9):

```typescript
const BOOT_AGENT_RAM = 3.3;        // boot.js RAM cost (GB) — run + read + write + rm + sleep
const STRATEGY_AGENT_RAM = 4.5;    // strategy_agent.js RAM cost (GB)
const WORKER_SCRIPT_RAM = 1.75;    // hack.js / grow.js / weaken.js RAM cost (GB)
const MAX_PREP_TARGETS = 4;        // max simultaneous auto_grow targets
const MAX_AUTOGROW_PER_SERVER = 2; // max auto_grow threads per target per server
const SCAN_NUKE_COOLDOWN = 60;     // seconds between scan_nuke runs
const HACK_FRACTION = 0.5;         // fraction of money to steal per hack cycle in snowball
```

**AgentAPI** — the bridge between strategy decisions and ns.* execution:

```typescript
interface AgentAPI {
  run(script: string, threads?: number, ...args: any[]): number;   // returns pid (0 = fail)
  exec(script: string, host: string, threads?: number, ...args: any[]): number;
  kill(script: string, host: string): boolean;
  scp(script: string, dest: string, source?: string): boolean;
  log(message: string): void;
  lastScanNukeTime: number;  // timestamp of last scan_nuke run
}
```

#### Strategy: BOOTSTRAP

**Goal:** Get the strategy agent running on the largest available rooted server (not home). Home may only have 8 GB and our scripts need headroom. **Uses boot.js (verified exists) not boot2.js (ghost file — audit F8).**

**Logic:**
1. If strategy agent is already confirmed running on a non-home server (via `relayRunningOn`) → done
2. Find the largest rooted server (not home) with free RAM > STRATEGY_AGENT_RAM
3. If found: scp strategy_agent.js there, exec it, then log success
4. If not found: run scan_nuke to discover more servers
5. Do NOT run any hack scripts yet — conserve home RAM for the bootstrap

```typescript
function strategyBootstrap(s: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // Already bootstrapped?
  if (s.relayRunningOn) {
    return []; // Phase detector will transition to SNOWBALL
  }

  // Find best relay target (non-home, rooted, free RAM > strategy agent cost)
  const candidates = s.rootedServers
    .filter(h => h !== 'home')
    .filter(h => (s.serverFreeRam.get(h) ?? 0) > STRATEGY_AGENT_RAM)
    .sort((a, b) => (s.serverFreeRam.get(b) ?? 0) - (s.serverFreeRam.get(a) ?? 0));

  if (candidates.length > 0) {
    const target = candidates[0];
    actions.push({ type: 'SCP', script: '/monitor/strategy_agent.js', dest: target });
    actions.push({ type: 'EXEC', script: '/monitor/strategy_agent.js', host: target, threads: 1 });
    api.log(`BOOTSTRAP: Deploying strategy agent to ${target} (${s.serverFreeRam.get(target)} GB free)`);
  } else {
    // Need more servers — run scan_nuke to root 0-port servers
    if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN * 1000) {
      actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
      api.log('BOOTSTRAP: Running scan_nuke to find relay targets');
    }
  }

  return actions;
}
```

#### Strategy: SNOWBALL

**Goal:** Generate money to buy port opening programs. Simple hack loop on the single best target. **Runs scan_nuke periodically (audit F1) to root more 0-port servers.**

**Logic:**
1. Run scan_nuke every 60s to discover newly-accessible servers (F1 fix)
2. Identify the single best hack target (highest value, prepared)
3. If best target not prepared: weaken + grow until ready
4. Run simple hack loop (hack → weaken → grow → weaken) using deploy scripts
5. Check if we can afford the next port opener → log intent (actual purchase requires terminal — audit F3)
6. Deploy worker scripts to all rooted servers
7. Phase exit: hasAnyPortOpener AND rootedCount >= 5 AND scan_nuke has run recently

```typescript
function strategySnowball(s: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // ── Periodic scan_nuke (F1 fix: SNOWBALL must root servers) ──
  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN * 1000) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  // ── Port opener purchasing (F3: requires terminal or SF-4) ──
  // Log purchase intent — actual purchase via terminal injection or manual buy.
  // ns.singularity.purchaseProgram() only works with SF-4 (BitNode-4 completion).
  const OPENERS = [
    { file: 'BruteSSH.exe', cost: 500_000, key: 'hasBruteSSH' },
    { file: 'FTPCrack.exe', cost: 1_500_000, key: 'hasFtpCrack' },
    { file: 'relaySMTP.exe', cost: 5_000_000, key: 'hasRelaySmtp' },
    { file: 'HTTPWorm.exe', cost: 30_000_000, key: 'hasHttpWorm' },
    { file: 'SQLInject.exe', cost: 250_000_000, key: 'hasSqlInject' },
  ];
  for (const opener of OPENERS) {
    const hasIt = (s as any)[opener.key] as boolean;
    if (!hasIt && s.money > opener.cost * 1.5) {
      actions.push({ type: 'BUY_PROGRAM', program: opener.file, cost: opener.cost });
      api.log(`SNOWBALL: Purchase intent — ${opener.file} ($${opener.cost.toLocaleString()})`);
      break; // One purchase per cycle
    }
  }

  // ── Hack the best target ──
  if (s.bestTarget) {
    if (!s.preparedTargets.includes(s.bestTarget)) {
      // Prepare the target: weaken then grow
      actions.push({ type: 'EXEC', script: '/deploy/auto_grow.js', host: 'home', args: [s.bestTarget] });
    } else {
      // Simple sequential hack loop on the prepared target
      // Use hack.js + grow.js + weaken.js directly (they already exist in dist/)
      const host = s.rootedServers.find(h => (s.serverFreeRam.get(h) ?? 0) > WORKER_SCRIPT_RAM * 3) ?? 'home';
      actions.push({ type: 'EXEC', script: '/deploy/hack.js', host, threads: 1, args: [s.bestTarget] });
      actions.push({ type: 'EXEC', script: '/deploy/grow.js', host, threads: 1, args: [s.bestTarget] });
      actions.push({ type: 'EXEC', script: '/deploy/weaken.js', host, threads: 1, args: [s.bestTarget] });
    }
  } else if (s.hackableServers.length === 0) {
    // No hackable servers — keep scanning
    api.log('SNOWBALL: No hackable servers. Waiting for scan_nuke or hacking level...');
  }

  // ── Deploy worker scripts ──
  for (const host of s.rootedServers) {
    if (!(s.hasDeployScripts.get(host) ?? false)) {
      actions.push({ type: 'DEPLOY', host });
    }
  }

  return actions;
}
```

#### Strategy: EXPANSION

**Goal:** Root every reachable server using available port openers. Run scan_nuke, distribute hack scripts.

**Logic:**
1. Run scan_nuke every 60s (it checks port openers inline)
2. Deploy hack/grow/weaken scripts to newly rooted servers
3. Buy next port opener when affordable
4. Once all nukable servers are rooted → transition to PREPARATION

```typescript
function strategyExpansion(s: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // Nuke all reachable servers periodically
  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN * 1000) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  // Deploy worker scripts to every rooted server that doesn't have them
  for (const host of s.rootedServers) {
    if (!(s.hasDeployScripts.get(host) ?? false)) {
      actions.push({ type: 'DEPLOY', host });
    }
  }

  // Continue buying port openers (same logic as SNOWBALL)
  // (BUY_PROGRAM actions work the same way)

  return actions;
}
```

#### Strategy: PREPARATION

**Goal:** Prepare batch targets (max money, min security) using auto_grow. **Capped deployment per target (audit H2).**

**Logic:**
1. Identify top N targets (by server value) that need preparation
2. For each unprepared target: run auto_grow with limited threads per server
3. Monitor preparation progress via isServerPrepared() checks
4. Once enough targets are prepared for 5+ consecutive ticks → hysteresis gates transition to BATCH

```typescript
function strategyPreparation(s: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // Prepare the best unprepared targets (capped at MAX_PREP_TARGETS)
  const targetsToPrep = s.hackableServers
    .filter(t => !s.preparedTargets.includes(t))
    .slice(0, MAX_PREP_TARGETS);

  // Track how many auto_grow processes we're launching per server
  const perServerCount = new Map<string, number>();

  for (const target of targetsToPrep) {
    for (const host of s.rootedServers) {
      const current = perServerCount.get(host) ?? 0;
      if (current >= MAX_AUTOGROW_PER_SERVER) continue; // Cap per server (H2 fix)

      const freeRam = s.serverFreeRam.get(host) ?? 0;
      const threads = Math.floor(freeRam / WORKER_SCRIPT_RAM / (MAX_AUTOGROW_PER_SERVER + 1));
      if (threads > 0) {
        actions.push({
          type: 'EXEC', script: '/deploy/auto_grow.js',
          host, threads, args: [target],
        });
        perServerCount.set(host, current + 1);
      }
    }
  }

  if (targetsToPrep.length > 0) {
    api.log(`PREPARATION: Preparing ${targetsToPrep.length} targets across ${s.rootedServers.length} servers`);
  }

  return actions;
}
```

#### Strategy: BATCH

**Goal:** Run full HWGW batch cycles on prepared targets using the existing engine. **Checks RAM before launch (audit H4).**

**Logic:**
1. If batch_hack.js is not running and enough RAM exists → launch it
2. The existing orchestrator handles HWGW, maintenance, and RAM violation recovery
3. If batch_hack crashes or RAM runs out → phase detector will regress to PREPARATION (F14 fix)
4. Periodically run scan_nuke for newly-accessible servers

```typescript
function strategyBatch(s: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // Launch batch_hack if not running (with RAM check — H4 fix)
  if (!s.isBatchHackRunning) {
    // Check: is there enough free RAM on home to launch it?
    const homeFree = s.homeMaxRam - s.homeUsedRam;
    const batchHackRam = WORKER_SCRIPT_RAM; // batch_hack runs on 1 thread as orchestrator
    if (homeFree > batchHackRam) {
      actions.push({
        type: 'RUN', script: '/contracts/batch_hack.js', threads: 1,
        // Note: --homeRam is read by batch_hack.ts via ns.args (F11 fix)
        args: ['--homeRam', String(Math.floor(s.homeMaxRam * 0.25))],
      });
      api.log('BATCH: Starting HWGW batch hack system');
    } else {
      api.log(`BATCH: Insufficient RAM to launch batch_hack (need ${batchHackRam}GB, have ${homeFree}GB free)`);
    }
  }

  // Periodic scan_nuke maintenance
  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN * 1000) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  return actions;
}
```

### 4.4 Action Execution

Actions are executed with **pid verification** (audit F7) and **RAM budget checks** (audit H4). Every `ns.run()`/`ns.exec()` return value is checked — failures are logged to the decision log.

```typescript
type Action =
  | { type: 'RUN'; script: string; threads?: number; args?: (string | number)[] }
  | { type: 'EXEC'; script: string; host: string; threads?: number; args?: (string | number)[] }
  | { type: 'KILL'; script: string; host: string }
  | { type: 'SCP'; script: string; dest: string; source?: string }
  | { type: 'BUY_PROGRAM'; program: string; cost: number }
  | { type: 'DEPLOY'; host: string };

function executeActions(ns: NS, actions: Action[], ramBudget: Map<string, number>, logger: DecisionLogger): void {
  for (const action of actions) {
    let pid = 0;
    switch (action.type) {
      case 'RUN': {
        pid = ns.run(action.script, action.threads ?? 1, ...(action.args ?? []));
        if (pid === 0) logger.warn(`RUN failed: ${action.script} (RAM or missing script)`);
        else logger.ok(`RUN: ${action.script} pid=${pid}`);
        break;
      }
      case 'EXEC': {
        pid = ns.exec(action.script, action.host, action.threads ?? 1, ...(action.args ?? []));
        if (pid === 0) logger.warn(`EXEC failed: ${action.script} on ${action.host} (RAM or missing script)`);
        else logger.ok(`EXEC: ${action.script} on ${action.host} pid=${pid}`);
        break;
      }
      case 'KILL': {
        const ok = ns.scriptKill(action.script, action.host);
        if (!ok) logger.warn(`KILL failed: ${action.script} on ${action.host}`);
        else logger.ok(`KILL: ${action.script} on ${action.host}`);
        break;
      }
      case 'SCP': {
        const ok = ns.scp(action.script, action.dest, action.source ?? 'home');
        if (!ok) logger.warn(`SCP failed: ${action.script} → ${action.dest}`);
        else logger.ok(`SCP: ${action.script} → ${action.dest}`);
        break;
      }
      case 'BUY_PROGRAM': {
        // F3/F6 fix: Attempt ns.singularity.purchaseProgram() if SF-4 is available.
        // On fresh game (no SF-4), this logs the intent — Claude executes via terminal injection.
        try {
          const purchased = (ns as any).singularity?.purchaseProgram?.(action.program);
          if (purchased) {
            logger.ok(`BOUGHT: ${action.program} ($${action.cost.toLocaleString()})`);
          } else {
            logger.info(`PURCHASE_INTENT: ${action.program} ($${action.cost.toLocaleString()}) — needs terminal or SF-4`);
          }
        } catch {
          logger.info(`PURCHASE_INTENT: ${action.program} ($${action.cost.toLocaleString()}) — Singularity unavailable`);
        }
        break;
      }
      case 'DEPLOY': {
        // F5 fix: Actually copy worker scripts to the target server.
        const workerScripts = ['/deploy/hack.js', '/deploy/grow.js', '/deploy/weaken.js'];
        let copied = 0;
        for (const script of workerScripts) {
          if (ns.scp(script, action.host, 'home')) copied++;
        }
        if (copied === workerScripts.length) {
          logger.ok(`DEPLOY: ${copied} scripts → ${action.host}`);
        } else {
          logger.warn(`DEPLOY: Only ${copied}/${workerScripts.length} scripts → ${action.host}`);
        }
        break;
      }
    }
  }
}
```

### 4.5 RAM Budget Analysis (Verified Costs — Audit F4 Corrected)

RAM costs sourced from official Bitburner docs (verified via `docs/bitburner_reference.md`). Each `ns.*` function import adds its fixed RAM cost to the script. The base script cost is ~1.6 GB.

**Critical optimization (audit finding): Replace file I/O with port I/O.**

| File-based (heavy) | Port-based (light) | Savings |
|---|---|---|
| `ns.read()` = 1.0 GB | `ns.peek(port)` = 0 GB | 1.0 GB |
| `ns.write()` = 1.0 GB | `ns.writePort(port, data)` = 0 GB | 1.0 GB |
| `ns.rm()` = 1.0 GB | (not needed — ports auto-overwrite) | 1.0 GB |
| `ns.scriptKill()` = 1.0 GB | `ns.kill(pid)` = 0.5 GB | 0.5 GB |
| **Total file I/O:** 4.0 GB | **Total port I/O:** 0.5 GB | **3.5 GB saved** |

Game ports (1–20) are global in-memory queues. The strategy agent writes to port 1 for broadcast, port 2 for commands. Boot agent reads port 2. This is the community standard for inter-script IPC (see Zharay's 17-port system).

**Key optimization: `ns.getServer(host)` = 0.3 GB** returns ALL server properties. Six individual getters would cost 0.55 GB total:
- `getServerMaxRam`: 0.1 GB, `getServerUsedRam`: 0.1 GB, `getServerMaxMoney`: 0.1 GB
- `getServerRequiredHackingLevel`: 0.1 GB, `getServerMinSecurityLevel`: 0.1 GB, `hasRootAccess`: 0.05 GB
- **Savings:** 0.25 GB per cycle by using `getServer()` instead of 6 individual getters.

**boot_agent (runs on home — command relay only):**

| Function | RAM | Purpose |
|---|---|---|
| `run(script, threads, ...args)` | 1.0 GB | Launch scripts on current server |
| `exec(script, host, threads, ...args)` | 1.3 GB | Launch scripts on remote servers |
| `sleep(millis)` | 0 GB | Polling loop |
| `print(...args)` | 0 GB | Logging |
| `disableLog(fn)` | 0 GB | Suppress log noise |
| `readPort(port)` | 0 GB | Read commands (port-based IPC) |
| `writePort(port, data)` | 0 GB | Write results |
| `fileExists(filename)` | 0 GB | Check for files |
| **Function RAM** | **2.3 GB** | |
| Base script overhead | ~1.6 GB | |
| **Total boot_agent** | **~3.9 GB** | ✅ Fits on 8 GB home with ~4 GB free |

**strategy_agent (runs on best non-home server — brain + strategy):**

| Function | RAM | Purpose |
|---|---|---|
| `getServer(host)` | 0.3 GB | All server properties in one call |
| `getPlayer()` | 0.3 GB | Money, hacking level, skills |
| `scan(host)` | 0.2 GB | Network traversal |
| `run(script, ...)` | 1.0 GB | Launch scripts locally |
| `exec(script, host, ...)` | 1.3 GB | Launch scripts remotely |
| `scp(files, dest, source?)` | 0.6 GB | Copy scripts between servers |
| `kill(pid)` | 0.5 GB | Kill by PID (lighter than scriptKill) |
| `readPort(port)` | 0 GB | IPC receive |
| `writePort(port, data)` | 0 GB | IPC send |
| `fileExists(filename)` | 0 GB | Check port opener existence |
| `sleep(millis)` | 0 GB | Main loop |
| `print(...args)` | 0 GB | Logging |
| `disableLog(fn)` | 0 GB | Suppress log noise |
| `brutessh/ftpcrack/relaysmtp/httpworm/sqlinject/nuke` | 0 GB | Port opening (all free!) |
| **Function RAM** | **4.2 GB** | |
| Base script overhead | ~1.6 GB | |
| **Total strategy_agent** | **~5.8 GB** | ✅ Fits on foodnstuff (16 GB) with 10+ GB free for workers |

**Deployment targets:**

| Script | RAM | Can Run On | Free RAM Needed |
|---|---|---|---|
| boot_agent | ~3.9 GB | home (8 GB), any rooted server ≥ 8 GB | ≥ 4 GB |
| strategy_agent | ~5.8 GB | foodnstuff (16 GB), purchased servers ≥ 16 GB | ≥ 6 GB |
| hack/grow/weaken workers | ~1.75 GB each | Any rooted server | ≥ 2 GB per worker |

**Bootstrap deployment sequence (verified feasible):**
1. Fresh game: home 8 GB, 0 scripts
2. Claude pushes boot_agent.js (3.9 GB) to home via MCP push_file
3. User runs `run /monitor/boot_agent.js` once (or bridge auto-pushes on connect after P1 fix)
4. boot_agent polls for commands, free RAM: ~4 GB remaining
5. Claude pushes strategy_agent.js and scan_nuke.js to home
6. Claude sends command via port: `{method: "exec", script: "/tools/scan_nuke.js", host: "home"}`
7. scan_nuke roots 0-port servers (n00dles, foodnstuff, etc.)
8. Claude sends: `{method: "scp", script: "/monitor/strategy_agent.js", dest: "foodnstuff"}`
9. Claude sends: `{method: "exec", script: "/monitor/strategy_agent.js", host: "foodnstuff", threads: 1}`
10. strategy_agent running on foodnstuff — autonomous from here

**For 4 GB servers like n00dles:** Neither agent fits. foodnstuff (16 GB) is the correct relay target. If foodnstuff is unavailable, any rooted server ≥ 16 GB works (sigma-cosmetics, joesguns, etc.).

### 4.6 Decision Logging

Every strategy decision is logged to `status/decisions.txt`:

```json
[
  {"tick": 1, "phase": "BOOTSTRAP", "decision": "Relay deployed to foodnstuff", "ts": 12345},
  {"tick": 2, "phase": "SNOWBALL", "decision": "Hacking n00dles (value: 42)", "ts": 13345},
  {"tick": 3, "phase": "SNOWBALL", "decision": "Bought BruteSSH.exe for $500k", "ts": 14345},
  ...
]
```

Claude reads this file to understand what the agent is doing and why — without making the decisions.

### 4.7 Code Cleanup: Consolidation Plan

Before building the strategy engine, we should clean up existing redundancy:

| Action | File(s) | Reason |
|---|---|---|
| **Remove** | `src/monitor/status_reporter.ts` | Superseded by game_agent.ts (which does everything it does + command relay). Verified: zero importers across entire src/ (audit). |
| **Remove** | `src/contracts/midgame_hack.ts` | Duplicates engine logic. The strategy engine replaces its early-game role. Verified: zero importers (audit). |
| **Remove** | `src/contracts/start_hack.ts` | Thin launcher that the strategy agent replaces. Verified: zero importers (audit). |
| **Fix** | `src/lib/server.ts:calculateServerValue()` | Missing growth factor — `batch_util.ts` version includes it, this one doesn't. Duplicate function. |
| **Fix** | `src/engine/server_manager.ts:84-85` | `moneyThreshold: 0.9` and `securityThreshold: 3` hardcoded — should read from HackingConfig. Wire config into ServerTargetManager constructor. |
| **KEEP** | `src/lib/script.ts` | **NOT removed (audit F12).** `distributeThreads()` imported by `thread_manager.ts:3,445`. `ensureScriptExists()` imported by `exec_multi.ts:2,123`. Both are active engine files. |
| **Add to repo** | `src/monitor/boot_agent.ts`, `src/monitor/strategy_agent.ts` | Boot chain source files. These are NEW files (not the old boot.js/boot2.js — those were ad-hoc. We're building properly designed versions). |
| **Add to repo** | `src/deploy/simple_hack_loop.ts` | Lightweight hack→weaken→grow→weaken loop for SNOWBALL phase. Needed before strategy engine can function. |
| **Fix** | `src/contracts/batch_hack.ts` | Read `--homeRam` from `ns.args` to override `HackingConfig.minHomeReserve`. Currently hardcoded to 100 GB — ignores CLI args. |

### 4.8 Implementation Order

Dependencies matter. Each step builds on the previous. **Revised after audit (corrected effort, added missing steps).**

| Step | What | Depends On | Effort | Produces |
|---|---|---|---|---|
| **P1** | Fix file sync engine — `getAllFiles` + hash compare in `build/game-bridge.ts`, remove `ignoreInitial: true` | Nothing | 2–3h | Files auto-sync on game connect |
| **P2** | Add `getAllFiles` to MCP — `build/game-bridge-mcp/src/index.ts` | Nothing (parallel with P1) | 30min | Can verify sync state from Claude |
| **S0** | Write `src/deploy/simple_hack_loop.ts` — lightweight sequential H→W→G→W for SNOWBALL phase | Nothing | 1h | Income generation for early game |
| **S1** | Code cleanup: remove status_reporter, midgame_hack, start_hack. Fix calculateServerValue(). Wire config into ServerTargetManager. Fix batch_hack.ts --homeRam parsing. | P1 (files must be sync'd) | 1h | Clean slate |
| **S2** | Write `src/monitor/boot_agent.ts` and `src/monitor/strategy_agent.ts` — boot chain + strategy engine core | S0 (simple_hack_loop must exist) | 4–5h | Autonomous agent with phase detection + all 5 strategies |
| **S3** | Replace game agent references — batch_hack.ts launches strategy_agent instead of game_agent | S2 | 30min | Strategy agent is the daemon |
| **S4** | RAM optimize: port-based IPC instead of file I/O, lazy snapshot, ns.getServer() optimization | S2 | 1h | Agent fits on foodnstuff with verified RAM budget |
| **S5** | Test: fresh game start → observe autonomous play via decision log | S4 | 2h | Verify bootstrap → snowball → expansion autonomy |
| **S6** | Test: expansion → preparation → batch transition | S5 | 1h | Verify full phase progression |

**Total estimated effort:** ~12–15 hours (corrected from original 10–12h to account for simple_hack_loop + port IPC migration).

**Parallelization opportunities (audit M2, M3):**
- P1 and P2 can run in parallel (different files, different processes)
- S0 can run in parallel with P1/P2 (no dependency)
- S1 and S2 could be parallelized if different agents handle each (S1 = cleanup, S2 = new code)

### 4.9 Community Research Findings

Research completed 2026-06-28. Key takeaways from the Bitburner scripting community.

#### What the Community Has Built

Two production-grade full-automation frameworks dominate:

| Project | Stars | Architecture | Key Files |
|---|---|---|---|
| **[alainbryden/bitburner-scripts](https://github.com/alainbryden/bitburner-scripts)** | 604+ | `autopilot.js` orchestrator + `daemon.js` hacking engine | 2s monitoring loop, coordinates gang/corp/stock/bladeburner/sleeves |
| **[inigo/bitburner-scripts](https://github.com/inigo/bitburner-scripts)** | — | `bootstrap.js` → `launchAll.js` → `completeBitnode.js` pipeline | TypeScript, starts from zero, casino cheating via DOM |
| **[Zharay/BitburnerBotnet](https://github.com/Zharay/BitburnerBotnet)** | — | 17-port inter-script IPC, all-in-one botnet | Works from scratch (32GB RAM, no Formulas.exe) |

**Common pattern:** All three use a **master orchestrator** that coordinates worker scripts. This validates our "agent is the brain" architecture.

#### Target Selection: Community Standard

The community converges on **money per RAM-second** as the key metric:

```
profitability = (maxMoney × growthFactor) / (weakenTime × totalRAMcost)
```

Our current `calculateServerValue()` in `batch_util.ts` uses a multiplicative score (`moneyScore × securityScore × timeScore × chanceScore × growthScore`), which is a reasonable proxy. The community formula is more directly tied to economic efficiency.

**Multi-stage filtering** (from alainbryden's daemon):
1. `canHack()` — player level ≥ required level
2. `shouldHack()` — has money, not owned
3. `isPrepped()` — at min security, max money
4. Rank by `getMoneyPerRamSecond()`

Our `ServerTargetManager` does steps 1–4 correctly. The one improvement: our server value formula doesn't account for RAM cost per operation.

#### HWGW Batch Timing: We're On Track

The community's HWGW algorithm matches our `batch_hack_manager.ts`:
- All 4 operations start simultaneously with calculated delays
- Weaken anchors the batch (longest operation)
- Step sizes: community uses 200–500ms; we use 20ms step + 80ms batch gap (aggressive)
- Thread calculations use the same security constants (hack: 0.002/thread, grow: 0.004/thread, weaken: 0.05/thread)

**Key difference:** Our step time (20ms) is much tighter than the community standard (200–500ms). This is more efficient but more prone to timing drift. The community recommendation for avoiding drift: always anchor to `Date.now()`, never chain `ns.sleep()`. Our `thread_manager.ts` uses `sleep()` chaining — this may be a source of batch misfires.

#### RAM Optimization: Pass Values as Args

The community's #1 RAM optimization: **pre-compute expensive values in the controller and pass them as arguments to worker scripts.** Our deploy scripts (`hack.js`, `grow.js`, `weaken.js`) are already minimal (just the one ns.* call + args), so we're doing this correctly.

**RAM dodging** (the community term for what our `simple_through_file.ts` does): Write a temp script, run it, read result from file. Keeps main script RAM minimal. Our implementation is correct but slow (50×100ms = 5s timeout). The community uses this for Singularity calls specifically.

#### What We're Missing vs. the Community

| Feature | Community | Us | Gap |
|---|---|---|---|
| Full BitNode automation | ✅ alainbryden autopilot | ❌ | Long-term: need BitNode completion + restart logic |
| Casino cheating (DOM-based) | ✅ inigo bootstrap | ❌ | Not needed yet — early game hack income is enough |
| Gang management | ✅ alainbryden gang.js | ❌ | BN2 locked, not yet relevant |
| Corporation management | ✅ alainbryden corp.js | ❌ | BN3 locked, not yet relevant |
| Stock market | ✅ alainbryden stockmaster.js | ✅ We have stock module | Our stock module is complete but untested in live play |
| Singularity integration | ✅ in SF4 unlocks | ⚠️ We use simple_through_file | Singularity-dependent scripts need SF4 first |
| Port-based IPC | ✅ Zharay (17 ports) | ✅ File-based (status/*.txt) | Our file-based approach is simpler and works via MCP |
| Coding contract solver | ✅ Daemon213 (25 types) | ✅ We have contracts.ts (12 types) | Our solver covers the common types |

#### Actionable Improvements from Research

1. **Adopt community target ranking:** Replace multiplicative score with `moneyPerRamSecond` formula. More accurate, matches community best practice.
2. **Loosen batch timing:** Consider increasing `stepTime` from 20ms to 100–200ms to reduce misfire risk. The community's more conservative timing is battle-tested.
3. **Add `Date.now()` anchoring** to `thread_manager.ts` scheduler instead of `ns.sleep()` chaining.
4. **Add port-based IPC** for inter-script communication within the game (not Claude ↔ game). Useful for the strategy agent to coordinate with worker scripts without file I/O.
5. **Study alainbryden's daemon.js** for advanced features: dynamic batch count optimization, utilization-based target deprioritization, stock-coordinated hacking.

#### Key Mechanics (from `docs/bitburner_reference.md`)

Full API reference written to `docs/bitburner_reference.md` — consulted during strategy design.

**Critical RAM costs for strategy agent design:**
- `ns.exec()`: 1.3 GB, `ns.run()`: 1.0 GB, `ns.scp()`: 0.6 GB
- `ns.read()`: 1.0 GB, `ns.write()`: 1.0 GB, `ns.rm()`: 1.0 GB
- `ns.getServer()`: 0.3 GB (returns all properties in one call)
- `ns.getPlayer()`: 0.3 GB, `ns.scan()`: 0.2 GB
- Port openers (`brutessh`, `nuke`, etc.): all 0 GB
- `ns.fileExists()`, `ns.sleep()`, `ns.print()`: all 0 GB

**Implication:** File I/O is expensive. The boot agent (which does heavy file I/O for command relay) costs ~3.3 GB. The strategy agent (which adds state snapshotting) costs ~4.5 GB. This forces a two-tier architecture where the strategy agent runs on a larger server, not home.

**Home RAM upgrade formula:**
```
Cost = currentRam × 32,000 × 1.58^numUpgrades × BitNode.multiplier
```
Each upgrade doubles RAM (8→16→32→64→128→256→512→1024→...). Max: 2^30 = 1 PB.
First upgrade (8→16 GB): 8 × 32,000 × 1.58^0 = **$256,000**.
Second upgrade (16→32 GB): 16 × 32,000 × 1.58^1 = **$808,960**.
This informs the SNOWBALL phase upgrade timing — buy the first upgrade as soon as we have ~$300k.

#### Reference Code (Local Clones)

All repos cloned to `example_code_dump/` (gitignored — not committed to our repo):

| Directory | Key Files | What to Read |
|---|---|---|
| `example_code_dump/alainbryden-bitburner-scripts/` | `autopilot.js`, `daemon.js`, `helpers.js` | Master orchestrator, target selection, full BitNode automation |
| `example_code_dump/inigo-bitburner-scripts/src/` | `bootstrap.ts`, `launchAll.ts` | Zero-to-hero bootstrap, TypeScript patterns |
| `example_code_dump/Zharay-BitburnerBotnet/` | Port IPC system | Inter-script communication via game ports |
| `example_code_dump/Jrpl-Bitburner-Scripts/` | Master/worker scripts | Minimal master/worker pattern for early game |

Future agents: consult these before implementing strategy code. The community has already solved most of the problems we face.

### 4.10 Design Questions Resolved (Post-Audit)

All 4 open questions resolved:

1. **Simple hack loop for SNOWBALL:** ✅ **Resolved.** Write `src/deploy/simple_hack_loop.ts` — a minimal ~50-line script that runs H→W→G→W sequentially on one target. Uses only `ns.hack()`, `ns.grow()`, `ns.weaken()`, `ns.sleep()`. RAM ~1.8 GB. Added to implementation order as step S0 (prerequisite for S2). Does NOT import from midgame_hack or engine.

2. **Port opener purchasing without Singularity:** ✅ **Resolved.** `ns.singularity.purchaseProgram()` requires SF-4 (BitNode-4 completion). On BN-1, this is UNAVAILABLE. The BUY_PROGRAM action handler uses a try/catch: attempts `ns.singularity.purchaseProgram()` (works with SF-4), falls back to logging `PURCHASE_INTENT` to the decision log (without SF-4). Claude reads the log and can execute via DOM terminal injection (`buy BruteSSH.exe` in terminal). The agent itself never makes the purchase without SF-4 — it signals intent. This is a conscious design trade-off: BN-1 requires one manual step (port opener purchases) until SF-4 is unlocked.

3. **Deploy script distribution:** ✅ **Resolved.** The DEPLOY action handler in the strategy agent handles this directly — calls `ns.scp()` for hack.js, grow.js, weaken.js from home to the target server. No separate deploy script needed. The `ns.scp()` cost (0.6 GB) is already in the strategy agent's RAM budget.

4. **Boot chain persistence:** ✅ **Resolved (Phase 2).** The strategy agent on the relay server writes a heartbeat to port 3 every cycle. The boot_agent on home reads port 3. If no heartbeat for 30s, boot_agent attempts to re-establish the relay (re-scp, re-exec). If the relay server itself is gone, boot_agent falls back to scan_nuke + find new target. This watchdog logic is a post-MVP enhancement — the initial build focuses on phase 1–5 autonomy. Documented as a future improvement.

---
     
## Open Questions (from Wave 2, not yet answered)

Answerable now via monitoring (read `status/*.txt` from the game):

- Is the batch_hack or midgame_hack contract active? Which scripts are running on home?
- Did the allocator `free()` fix change server selection? (Compare `ram.txt` over time)
- Are `ns.sleep(1)` removals causing timing issues? (Observe batch misfires via processes.txt)
- What is the actual income rate? (Read `player.txt`)

---

## File Index (Post Wave-4 Plan)

Key files and what they do:

| File | Role | Status |
|---|---|---|
| **Strategy Engine (to be built)** | | |
| `src/monitor/boot_agent.ts` | Lightweight command relay on home (~3.9 GB). Port-based IPC. | **NEW** — S2 |
| `src/monitor/strategy_agent.ts` | Autonomous brain — phase detection + 5 strategies (~5.8 GB). | **NEW** — S2 |
| `src/deploy/simple_hack_loop.ts` | Minimal H→W→G→W loop for SNOWBALL phase (~1.8 GB). | **NEW** — S0 |
| **Engine (existing, active)** | | |
| `src/contracts/batch_hack.ts` | Main batch hack orchestrator — uses engine classes. | Active |
| `src/engine/batch_hack_manager.ts` | HWGW batch scheduling and strategy calculation. | Active |
| `src/engine/allocator.ts` | Thread allocator across servers with utilization tracking. | Active |
| `src/engine/ram_manager.ts` | RAM accounting per server, home reservation. | Active |
| `src/engine/server_manager.ts` | Target server discovery, value ranking, prepared status. | Active |
| `src/engine/thread_manager.ts` | Scheduled operation execution, HWGW timing. | Active |
| `src/engine/auto_grow.ts` | Prepares servers to max money / min security before batch. | Active |
| `src/lib/script.ts` | `distributeThreads()`, `ensureScriptExists()` — used by engine. | **KEEP** (audit F12) |
| `src/lib/server.ts` | `calculateServerValue()` — missing growth factor, needs fix. | Needs fix |
| `src/tools/scan_nuke.ts` | BFS network scan + inline nuke. | Active |
| **To be removed (S1)** | | |
| `src/monitor/status_reporter.ts` | Superseded by strategy_agent. Zero importers. | **REMOVE** |
| `src/contracts/midgame_hack.ts` | Superseded by strategy engine + batch_hack. Zero importers. | **REMOVE** |
| `src/contracts/start_hack.ts` | Thin launcher, replaced by strategy_agent. Zero importers. | **REMOVE** |
| **Build Tooling** | | |
| `build/game-bridge.ts` | WebSocket bridge daemon (port 12525 game, 12526 admin). | Needs P1 fix |
| `build/game-bridge-mcp/src/index.ts` | MCP server — bridge between Claude and the game. | Needs P2 fix |
| **Reference (read-only)** | | |
| `docs/bitburner_reference.md` | Full API reference with verified RAM costs. | Reference |
| `docs/continuous_improvement.md` | This file — living plan document. | Active |
| `example_code_dump/` | Cloned reference repos (gitignored). | Reference |
