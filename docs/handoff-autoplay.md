# Handoff — Build the Autonomous Gameplay System

> **For the next agent.** The real-time control channel is DONE (2026-06-29). Your job: use it to build
> the full **hands-free auto-play system** — a brain that progresses the game from a fresh BitNode through
> hacking → factions → augs → reset → repeat, autonomous where trusted, steerable where it isn't.
>
> **Read order:** this doc → `docs/mcp-control-channel-usage.md` (your new toolbox) →
> `docs/design/00-architecture-philosophy.md` §2.5 (the capability boundary — the law) →
> `docs/design/04-player-automation-and-control.md` (player automation mechanisms) →
> `docs/design/02-system-architecture.md` (phases + module map) → `docs/HANDOFF.md` (project state).
> Operating rules for running this as a manager: `docs/handoff_prompt.md` + `docs/manager_template.mdx`.

---

## 1. The new superpower (what changed)

You can now **perceive and act on the live game in ~10 ms**, with sub-ms state reads. Before this, control
went through a ~400–600 ms poll-only file relay. Now an in-game daemon (`cross/game_agent.js`) holds an
open WebSocket to the bridge, so an external agent (you, over MCP) — or any in-game daemon — can:

- **Act:** `terminal` (inject any terminal command), `run`/`kill` scripts, `write_port`/`read_port`,
  query `getPlayer`/`getServer`/`ps`. ~10 ms round-trip.
- **Perceive:** `get_screen` (rendered terminal text), `get_notifications`, heartbeat/decisions — all
  served sub-ms from the bridge's state buffer.

This closes the **perceive → decide → act → verify** loop: inject a command, then read the screen/player
state to confirm it landed, instead of inferring from a port receipt. That is the foundation the auto-play
brain stands on. Full tool reference: `docs/mcp-control-channel-usage.md` §4.

---

## 2. The goal

**One human input to start; everything after is autonomous where trusted, surfaced where it's a judgment
call.** Concretely, the system should, unattended:

1. Boot a fresh BitNode (root network, spray workers, ramp home RAM) — *exists* (`bootstrap.ts`).
2. Bring compute daemons online as RAM allows (batcher, scheduler, hacknet, pserv, stock) — *exists*
   (orchestrator-driven `ns.exec`).
3. Progress the player thread: join factions, grind rep, buy programs, plan + buy augs, do crime/work —
   *modules exist, but nothing sequences them autonomously yet*. **← the main gap.**
4. Recognize when to reset (enough augs queued / rep plateau) and **surface it** as a notification + an
   MCP-answerable decision — *partly wired* (`aug_planner → PORT_AUGS → phase_detector` RESET trigger).
5. After human/agent approval, install augs and loop back to (1).

The **division of labour** (design/04 §4) is the spine:
- **Thread C (Compute)** → full auto. Pure stats, no human surface. Mostly built.
- **Thread P (Player)** → auto where trusted (SF4-gated); otherwise surfaced as **both** a notification
  **and** an MCP command you/the user can fire.
- **Judgment calls** (BitNode choice, reset timing) → **never auto-decide.** Recommend + notify.

---

## 3. Where the brain lives (architecture decision to make first)

Two viable seats for the decision loop — decide this before building:

- **(A) In-game strategy daemon** — a lean `cross/` daemon that owns the Thread-P sequencing loop:
  reads `getPlayer`/factions/augs, decides the next trusted action, fires it via `ns.exec`/terminal, and
  pushes judgment calls to `PORT_DECISION`/`PORT_NOTIFY`. The control channel is then for **observability +
  steering** (you watch `get_screen`/`get_notifications`, answer decisions over `write_port`). Truly
  hands-free — runs whether or not an agent is attached. **Recommended** — it matches design/04 §4
  ("autonomous where trusted") and the existing daemon model.
- **(B) MCP-agent brain** — *you* (a Claude session) are the loop: poll state over `control.*`, decide,
  act. Maximum flexibility and judgment, but only runs while the session is attached, and burns tokens
  continuously. Best reserved for the **judgment/steering** layer on top of (A), not the core loop.

**Likely answer: A for the autonomous core, B for the judgment layer.** The in-game daemon does the
trusted grind; the agent (or user) is pinged only for the genuine decisions. Ratify this in a short design
note before writing code (the project is doc-first — see design/04 §0).

**Capability boundary (non-negotiable, design/00 §2.5 + design/04 §1):** automate player *action*, not data
*access*. Only the Netscript/Singularity API and the UI (via the quarantined `cross/launcher.ts`, the ONLY
file allowed to touch the DOM). **Never** read React internals / the save / hidden state, never mutate game
objects. Stealth-DOM is permitted *only* for UI interfacing (inject commands, read rendered screen text).

---

## 4. What exists vs. what to build

**Built & validated (lean on these, don't rebuild):**
- `bootstrap.ts` (4.8 GB) — roots network, sprays workers, `ns.exec`s daemons as RAM allows, gradual ramp.
- `compute/` — `coordinator` (MID HWGW batch engine), `hwgw_batcher`, `scheduler`, `target_selector`,
  `ram_manager`, `pserv_manager`, `hacknet_manager`, `spreader`, `allocator`, `formulas`.
- `stock/` — dual-mode 4S/pre-4S trader (already strong).
- `cross/phase_detector` — classifies BOOTSTRAP/EARLY/MID/LATE from home RAM + rooted count, publishes
  `PORT_PHASE`; consumes `PORT_AUGS` for the RESET trigger.
- `cross/game_agent` — the control channel + RFA fallback daemon (this session).
- `cross/launcher` — DOM-quarantined terminal injection + screen read (the only DOM file).
- `player/` modules — `faction_manager`, `program_acquirer`, `aug_planner`, `crime`, `contract_solver`,
  `goto`. Each runnable standalone / MCP-triggerable. **Singularity ones are SF4-gated** and route through
  `lib/ns_dodge.ts` (RAM-dodge).

**Missing — your build:**
1. **The Thread-P sequencing brain** (§3 decision) — the loop that decides *which* player module to fire
   *when*, given player state + phase. Today the modules are leaves with no orchestrator above them.
2. **Decision/notify-and-wait surface, end-to-end** — a clean protocol where the brain emits a decision
   (e.g. "12 augs ready, reset?") to `PORT_DECISION`/`PORT_NOTIFY`, the agent/user reads it via
   `get_notifications`, and answers by writing a command (`write_port`/`terminal`). Partly exists; make it
   a first-class, documented loop with verification.
3. **Verification loops** — after each Thread-P action, read back `getPlayer`/screen to confirm success
   (rep gained, aug bought, faction joined) instead of fire-and-forget. The control channel makes this cheap.
4. **Reset cycle** — recognize reset-readiness, surface it, and on approval drive
   `aug_planner --purchase` → install → re-bootstrap. Close the full loop.
5. **(Stretch) Side-engines** — gang/sleeve/bladeburner/stanek as phase-gated daemons (Workstream B).

---

## 5. Your toolbox (quick reference)

**control.cmd methods** (via MCP tools or `control.cmd`): `terminal{command}`, `run{script,threads?,args?}`,
`kill{pid?|script?,host?}`, `ps{host?}`, `getPlayer`, `getServer{target?}`, `readPort`/`writePort`/`peekPort`,
`ping`. **State channels** (`control.state` / `get_screen` / `get_notifications`): `screen`, `notifications`,
`heartbeat`, `decisions`.

**MCP tools:** real-time → `terminal`, `write_port`, `read_port`, `get_screen`, `get_notifications`,
`get_status`. File/RFA (always-on) → `read_file`, `push_file`, `delete_file`, `list_files`, `list_servers`,
`calculate_ram`, `get_save`, `get_monitoring`.

**Bus channels** (`lib/ports.ts`): 1 CMD, 2 RESULT, 3 HEARTBEAT, 4 DECISION, 5 BUS_REGISTER, 6 BUS_LOCK,
7 BUS_TASK, 8 PHASE, 9 NOTIFY, 10 STOCK, 11 AUGS, **12 LAUNCHER** (raw terminal strings). 13–20 free for
MCP `write_port`/`read_port`. **`game_agent` must be running** for any MCP port I/O (it's the relay).

**Phases** (`DesignPhase`): BOOTSTRAP → EARLY → MID (coordinator/HWGW) → LATE (≥512 GB; side-engines).

---

## 6. Gotchas & rules (don't relearn these)

- **A WS callback must NEVER call `ns.*`** — it throws uncaught and the engine kills the script (bypassing
  try/catch). This cost real time. Callbacks enqueue only; the main loop does all `ns` work. See
  `mcp-control-channel-usage.md` §2. Relevant if you touch `game_agent.ts`.
- **Capability boundary** — API + UI only; never engine internals/save/hidden state. The DOM lives in
  `cross/launcher.ts` and nowhere else.
- **Judgment never auto** — BitNode choice and reset timing are surfaced, not decided. Same for anything
  that spends a scarce/irreversible resource without a clear rule.
- **RAM is the constant enemy.** On 8 GB home, `game_agent` (~8 GB) and an orchestrator don't co-fit —
  run lean. Check every new daemon with `calculate_ram` before relying on it. `contract_solver` = 22 GB
  (Problem 3, still open — lean it up before auto-triggering it).
- **SF4 gating** — `faction_manager`/`crime`/`aug_planner`/`program_acquirer --backdoor` need SourceFile-4
  (Singularity). They fail safely pre-SF4; the brain must not assume they work. Route Singularity through
  `lib/ns_dodge.ts`.
- **Deploying agent changes:** `tsc` → push `dist/cross/game_agent.js` → **kill+run** the daemon (no
  hot-reload; `atExit` prevents zombie sockets). The bridge watcher can race a partial file — push
  explicitly to be safe.
- **`tsc -w` is the authoritative typecheck**, not one-shot incremental `tsc` (use `--incremental false`).
- **Bitburner terminal:** no `;`/`&&` chaining; one command per inject.
- **Validate in-game, and delegate trivial game actions to the user** — running scripts, reloads,
  reconnects are one-click for them and a struggle for you. Ask; don't solo physical game steps.

---

## 7. Suggested build workflow

1. **Ratify the §3 architecture** (in-game brain + control-channel steering) in a short design note. Doc-first.
2. **Write a build plan** like `plan-mcp-realtime-control.md`: phases, file-disjoint where possible, a frozen
   protocol for any new decision/command shapes, explicit in-game validation steps.
3. **Manager pattern:** Opus plans + audits; dispatch file-disjoint pieces to Sonnet build agents (have
   them read `docs/coding_principles.mdx` first); manager integrates + validates in-game. (This is exactly
   how the control channel got built — it works.)
4. **Build the smallest closed loop first:** one trusted Thread-P action, end to end, with verification —
   e.g. "auto-join a faction the moment requirements are met, confirm via `getPlayer`." Then widen.
5. **Then the decision surface**, then the reset cycle, then side-engines.

**First concrete milestone:** an in-game Thread-P brain that, on a fresh node with SF4, autonomously joins
eligible factions and triggers `program_acquirer`/`contract_solver`, verifies each via `getPlayer`/screen,
and surfaces the first aug-purchase decision over the control channel for you to approve. Land that loop and
the rest is widening it.

---

*Prereq state (2026-06-29): control channel green (Problems 1 & 2 resolved); compute thread auto; player
modules built but unsequenced; Problem 3 (player-module RAM) still open. Commit `ceb8205` on `main`.*
