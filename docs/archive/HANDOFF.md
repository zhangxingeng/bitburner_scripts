# Handoff — Bitburner Automation Rebuild

> For the next agent picking up this project. Read this first, then the design docs.
> Date of handoff: 2026-06-29. Platform: **Ubuntu** (repo at `/home/shane/workspace/bitburner_scripts`).

---

## TL;DR — where we are

- A full **architecture migration is DONE** (Phases 1–5) and committed. The codebase is reorganized
  around a **two-thread model** (Compute vs Player) with a **5-phase state machine**. `tsc` is clean.
- We were **mid first-launch validation** on a fresh BitNode and hit a **bootstrap RAM wall**
  (the `coordinator` needs 15.85 GB, won't fit 8 GB home). **The lean `bootstrap` entry is now
  BUILT** (`src/bootstrap.ts`, game-validated at **4.6 GB**) — see §4. It runs: roots the network, sprays workers.
- **NEW direction is live: the player-puppet launcher + MCP control surface (Workstream E).** Steps 1–4 and 6
  of `docs/design/04` are DONE and **in-game validated** (2026-06-29).  Key outcomes:
  - `bootstrap.ts` = lean permanent orchestrator (game-validated **4.8 GB**), spawns daemons via `ns.exec`
    as home RAM allows (gradual ramp, no 32 GB cliff).  `coordinator.ts` gutted to pure batch engine (MID-
    only).  `BOOTSTRAP_HANDOFF_RAM` retired.
  - Read-side: `status/screen.txt` live (terminal rendered text mirrored ~1 s; `#terminal` selector
    confirmed on v3.0.2).  Write-side: `PORT_LAUNCHER=12` → MCP inject loop proven end-to-end.
  - Read+write loop closed: the agent perceives screen output and injects commands over MCP.
  - Bug fixed: spreader removed from `DAEMON_CATALOG` (one-shot utility, not a persistent daemon).
  - Step 5 built (`tsc` green): PORT_NOTIFY mirrored to `status/notifications.txt`; double-spawn guard
    in `processLauncherCommands`; player module protocol documented.
- **✅ RESOLVED — MCP reliability (Problems 1 & 2). The real-time WebSocket control channel is BUILT and
  in-game validated (2026-06-29).** Build plan: `docs/plan-mcp-realtime-control.md`; **usage guide for
  future agents: `docs/mcp-control-channel-usage.md`**; problem analysis: `docs/plan-mcp-reliability.md`.
  - In-game daemon (`cross/game_agent.js`) opens its OWN outbound WebSocket to the bridge (`:12527`).
    `control.cmd` round-trips at **~10 ms** (was ~400–600 ms via the file relay); `control.state` reads
    (screen/heartbeat) at **sub-ms**. `write_port` now returns `{evicted:null}` on a clean write. RFA
    file-relay kept as the always-available fallback.
  - **Hard-won lesson (don't relearn it):** a WS callback must **never** call `ns.*` — it throws uncaught
    and the engine kills the script, bypassing try/catch. Callbacks enqueue only; the main loop drains and
    does all `ns` work. This was the startup-crash root cause. (See usage doc §"The one rule".)
  - Problem 3 (player modules too heavy: `contract_solver` = 22 GB) is still **DEFERRED** (Phase 5) — not
    blocking. It's now the next reliability task.
  **Next: feature work is unblocked. Open follow-up = Problem 3 (player-module RAM lean-up).**
- Infra (MCP bridge + statusline) broke in the Windows→Ubuntu move and is being fixed (see §6).

**Read order:** this doc → `docs/design/00-architecture-philosophy.md` (the two-thread model + automation
boundary — the *why*) → `02-system-architecture.md` (phases + module map) → `03-migration-and-build-plan.md`
(what's done + active workstreams + the `TODO(design)` registry). `01-research-synthesis.md` = what we
learned from 4 reference repos (full reports in `research_report/`).

---

## 1. The core idea (don't lose this)

Everything derives from **two threads**:
- **Thread C (Compute)** — all RAM, parallel, pure stat-driven (hacking, prep, batching, server buys,
  hacknet, stocks). Fully automate with code.
- **Thread P (Player)** — the single serial actor (work, factions, augs, crime). Build as
  **user-invoked modules now**; full-auto later.
- **Judgment calls** (BitNode choice, when to reset) → never auto-decide; recommend + notify.

Player-thread actions use the **Singularity API wrapped in a RAM-dodge** (`lib/ns_dodge.ts`, our
`getNsDataThroughFile` equivalent — run the costly call in a temp 1 GB script, read result back via file).
Pre-SourceFile-4, player automation is unavailable; early income = **stocks + hacking**.

---

## 2. Repo structure (current)

```
src/lib/      ports (bus channels 1-11), ns_dodge (RAM-dodge), servers, config (+DesignPhase enum), format, script, connect, types
src/workers/  ultra-thin H/G/W + auto_grow, share, simple_hack_loop  (RAM-minimal; logic lives in orchestrators)
src/compute/  coordinator, hwgw_batcher, scheduler, target_selector, allocator, exec_multi, formulas,
              ram_manager, pserv_manager, hacknet_manager, spreader
src/player/   faction_manager, program_acquirer, aug_planner, crime, contract_solver, goto  (user-invoked; Singularity via ns_dodge)
src/cross/    phase_detector, game_agent, boot_agent, reporter, notification
src/stock/    main + config/forecast/market/stock/trader  (dual-mode 4S/pre-4S; already strong)
```
Gone (migrated away, do not recreate): `engine/ monitor/ contracts/ tools/ deploy/ info/`.

**Bus channels** (`lib/ports.ts`): 1 CMD, 2 RESULT, 3 HEARTBEAT, 4 DECISION, 5 BUS_REGISTER,
6 BUS_LOCK, 7 BUS_TASK, 8 PHASE, 9 NOTIFY, 10 STOCK, 11 AUGS.

**Closed loops live:** `phase_detector → PORT_PHASE → coordinator`; `aug_planner → PORT_AUGS → phase_detector` (RESET trigger).

---

## 3. Build & toolchain (Ubuntu)

- Source `src/` → `tsc` → `dist/` → custom WebSocket bridge (`build/game-bridge.ts`) pushes to the game.
- Dev loop: **`pnpm run watch`** (runs `tsc -w` + local sync + `game-bridge.ts`). Connects to the game at localhost:8000.
- One-shot build: `npx tsc`. One-shot typecheck: `npx tsc --noEmit`.
- ⚠️ **The watch (`tsc -w`) is the authoritative typecheck.** A plain `npx tsc --noEmit` can pass while
  the watch reports real errors, because of incremental build cache. If verifying types, prefer the watch
  output, or run `npx tsc --noEmit --incremental false`.

---

## 4. THE ACTIVE PROBLEM — bootstrap RAM wall (do this next)

**Symptom:** `run /compute/coordinator.js` on fresh 8 GB home → *"requires 15.85 GB of RAM."*

**Why:** `coordinator.ts` statically **imports** the whole compute stack (hwgw_batcher, scheduler,
target_selector, ram_manager, formulas…). A script's RAM = union of every `ns.*` reachable through its
imports — so importing the batcher drags in `ns.formulas`, hack/grow/weaken analysis, etc., before any of
it runs. Heavy by construction.

**Decision (agreed with user):** NOT a RAM-bypass cheat. Instead **separate concerns** — put the phase
switch one level UP, in a lean entry script, and run heavy modules as separate `ns.run` processes (each
pays only for its own `ns.*`). This is the Bitburner-idiomatic pattern and matches Workstream D's
"separate daemons / full bus" direction; bootstrap just forces it now.

**Two RAM constraints to respect on 8 GB home:**
1. `coordinator` = 15.85 GB (doesn't fit).
2. `cross/game_agent.js` (the MCP relay) is ~6.5 GB — it nearly fills home by itself, so a bootstrap
   orchestrator can't run beside it. **At bootstrap, run the lean orchestrator ALONE; game_agent is
   optional (only needed for MCP inspection/monitoring).**

### Next task: build a lean `bootstrap` entry (BOOTSTRAP/EARLY) — ✅ DONE
**Built:** `src/bootstrap.ts`, registered as `SCRIPT_PATHS.bootstrap = '/bootstrap.js'`. Game reports
**4.6 GB** (fits 8 GB home alone). Self-contained — imports ONLY pure constants from `lib/config`
(`SCRIPT_PATHS`, new `BOOTSTRAP_HANDOFF_RAM = 32`); BFS/nuke/target/deploy all inlined to bound RAM.
Handoff threshold = `BOOTSTRAP_HANDOFF_RAM` (32 GB). **One deliberate deviation from the spec below:**
home is NOT used as a worker host — kept clear so the ~16 GB coordinator can launch at handoff without
killing anything. **Remaining:** run `run /bootstrap.js` in-game on the fresh node and confirm behavior.

A small self-contained script (~4–5 GB; inline BFS to bound RAM — do NOT import heavy libs) that:
1. Scans + nukes every openable server (reuse the inline nuke logic already in `compute/spreader.ts:nukeNetwork`).
2. Picks the best target (max `moneyMax` among rooted servers with `requiredHackingSkill ≤ level`, money > 0).
   Early-game per-thread-efficiency ranking optional (see Jrpl report).
3. Deploys `workers/simple_hack_loop.js <target>` (2 GB, target = `args[0]`) across each rooted server's
   free RAM (and home's spare). This is the proven early-game income path.
4. Loops; when `home maxRam ≥` a threshold where coordinator fits (≥ 32 GB to be safe), `ns.exec`s
   `/compute/coordinator.js` and exits — the handoff to the heavy system.

This realizes the "phase-aware strategy switch" as a *separate lean script* rather than a branch inside
the un-loadable coordinator. Register it in `lib/config.ts SCRIPT_PATHS`.

**Bigger follow-up (Workstream D):** make `coordinator` itself lean by `ns.run`-ing its sub-daemons
(batcher/scheduler/etc.) instead of importing them, so it fits modest RAM and can host the phase switch
internally. Then bootstrap and coordinator converge.

**Strategic direction (NEW, 2026-06-29):** the cleaner answer to *both* the bootstrap wall and the heavy
coordinator is a single **DOM-contained player-puppet launcher** (`cross/launcher.ts`) plus an **MCP
control surface**, governed by a new **capability boundary**: automate player *action*, not data access —
act as a human, through human surfaces (NS/Singularity API + UI), **never inspecting or altering engine
internals**. A ~free launcher spawns daemons as RAM allows, so the 32 GB handoff cliff becomes a gradual
ramp, and the agent can trigger scripts/player actions over MCP for hands-free play. See `docs/design/00 §2.5`
and the new `docs/design/04-player-automation-and-control.md`. **Docs-first: no code until 04 is ratified.**

---

## 5. How to launch / validate (in-game, fresh BitNode)

MCP game tools are NOT currently exposed to the Claude session (see §6) — validate via terminal output.
```
# free home first if the old relay is running:
kill /monitor/game_agent.js        # stale path from before migration (if present)
# bootstrap income (once the lean bootstrap script exists):
run /bootstrap.js                  # lean orchestrator (TO BE BUILT — see §4)
# OR the manual proven path for a quick smoke test:
#   nuke a 0-port server, then: run /workers/simple_hack_loop.js n00dles
```
Once home RAM grows enough, the heavy path:
```
run /cross/game_agent.js           # MCP relay (new path; ~6.5 GB)
run /compute/coordinator.js        # needs ~16 GB free — MID+ only
```
Report when validating: RAM each script needs, red errors, home RAM + hacking level, whether money moves.

---

## 6. Infra status (Windows→Ubuntu) — FIXED this session (needs session reload)

- **MCP game bridge** (`build/game-bridge-mcp/`): `.mcp.json` invoked `pnpm`, which lives only under nvm
  and isn't on the PATH Claude Code gives MCP subprocesses → the server never started. Fixed to use the
  absolute nvm `pnpm` (`/home/shane/.nvm/versions/node/v24.18.0/bin/pnpm`) + absolute script path.
  Verified it boots and connects to the bridge. ⚠️ Brittle if node version changes — update the path if nvm upgrades.
- **Statusline**: `.claude/settings.json statusLine` used `uv run` (uv not installed on Ubuntu). Fixed to
  `python3 "$CLAUDE_PROJECT_DIR/.claude/statusline.py"` (Python 3.14 present). Verified it prints.
- **➡️ ACTION: reload the Claude Code session** (exit + relaunch) for both to take effect; then the
  `bitburner__*` MCP tools should appear and the statusline should show.

---

## 7. Workstreams & tasks

- **A. Integration & launch** ← active; blocked on §4 (lean bootstrap) then the coordinator phase-switch + a run doc.
- **B. Side-engines** — gang → sleeve → bladeburner → stanek; then reset/aug-install recommender (notify).
- **C. Dashboard UI** — React per `ui_plan.md`; replaces `cross/reporter.ts` placeholder.
- **D. Quality pass** — the `TODO(design)` registry in `docs/design/03` (full bus protocol, recoveryThreadPadding,
  maxTargets auto-scale, AttackController/TargetFinder batching, bin-packing, stock↔hack coupling consume-half,
  faction/aug/program deferred items). The "make coordinator lean" refactor lives here too.
- **E. Player-puppet launcher + MCP control** ← **ACTIVE.** Single DOM-contained `cross/launcher.ts`
  (UI interfacing only) + MCP command channel, under the §2.5 capability boundary. See `docs/design/04`
  (spec + live status log). **Steps 1–4 and 6 DONE, `tsc`-green, and in-game validated (2026-06-29).**
  - Step 4: orchestrator game-validated at 4.8 GB, stable on 16 GB home; daemons idle until RAM rises
    (gradual ramp working). Coordinator gutted to MID batch engine. Bug fixed: spreader removed from
    DAEMON_CATALOG (one-shot utility, caused spawn-storm).
  - Step 6: `status/screen.txt` live — `#terminal` selector confirmed on game v3.0.2; rendered terminal
    output readable over MCP. Read+write loop closed: agent perceives screen + injects commands hands-free.
  - Step 5: player modules as MCP-triggerable commands — **built, `tsc` green, pending
    in-game validation.** PORT_NOTIFY mirrored to `status/notifications.txt` (every tick,
    rolling 500). Double-spawn guard in `processLauncherCommands` (ns.isRunning check).
    Safe-auto: contract_solver, program_acquirer, goto. Confirm-first: aug_planner --purchase.
    Persistent: faction_manager, crime (SF4 gated; guard prevents duplicate spawn).
  - **MCP control channel (real-time WebSocket) DONE + validated 2026-06-29** — `game_agent.js` evolved
    into a dual control-channel + RFA-fallback daemon. Problems 1 & 2 resolved (see TL;DR). The
    notifications/screen/heartbeat mirrors now ALSO push as live `state` frames over `:12527`.
  **All 6 steps built and validated. Next open item: Problem 3 (player-module RAM lean-up).**

Grep `TODO(design)` in `src/` for the in-code markers.

---

## 8. Gotchas
- `tsc -w` (watch) is the source of truth for type errors, not one-shot `npx tsc` (incremental cache).
- `ns.flags(...)` needs `as unknown as {...}` (direct cast errors out).
- On 8 GB home: game_agent (~6.5 GB) and any orchestrator contend — don't run both at bootstrap.
- Bitburner terminal: no `;`/`&&` chaining; `scp` preserves dir structure; `run <script> <args>` needs args.
- Singularity calls: route through `lib/ns_dodge.ts` to keep RAM affordable.
- Player modules are **user-invoked** (not auto-launched by coordinator) by current design.
- **Design doc gap:** `docs/design/02-system-architecture.md` lists `workManager` as a Thread-P module
  (lines 40, 81). No `work_manager.ts` exists in `src/player/` — it was never built. Company/faction
  work logic is currently folded into `player/faction_manager.ts` or deferred. Don't go looking for
  a missing file; write it when needed.

---

## 9. Docs updated this session (2026-06-29)

- `docs/game_play_quirks.md` — full update: all `deploy/` paths → `workers/`, `monitor/game_agent` →
  `cross/game_agent`, strategy_agent section replaced with phase_detector + coordinator, Ubuntu repo
  path added, bootstrap sequence updated.
- `docs/HANDOFF.md` (this file) — §6 infra fix details filled in; §8 workManager gap noted.
- `docs/design/00–03` — verified internally consistent with `src/`; no edits needed.

---

*Migration commit: `09e0239` on branch `refactor/two-thread-migration`. See git log for history.*
