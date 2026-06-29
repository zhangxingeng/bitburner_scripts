# Player Automation & The Control Surface

> Grounds the **capability boundary** from [00-architecture-philosophy.md](00-architecture-philosophy.md) §2.5
> into concrete mechanisms. Defines *how* we act as a player, *what we may never do*, and the **MCP
> control surface** that makes play hands-free.
>
> **Document-first: no code on any of this until this doc is ratified.**

---

## 1. The Core Constraint — act as a human, through human surfaces

**We automate player *action*, not data *access*. The system may do anything a human player can do, and
nothing more.** It interfaces with the game only through the two surfaces a real player+scripter has, and
never reaches past them into the engine.

> **The whole boundary derives from one rule:** there are two sides, with a hard line between them.
> The **game-script side** may use anything the game's API *exposes* — that's fair play. The
> **player-mimicking side** may do only what a *human can do*. Code-side → API-compliant; mimic-side →
> human-possible. Every other decision in this doc falls out of that.

| | Surface | Examples | Allowed because |
|--|---------|----------|-----------------|
| ✅ | **Netscript / Singularity API** | `ns.hack`, `ns.scan`, `ns.singularity.workForFaction`, reading stats the UI shows | The game's *sanctioned scripting feature* — writing scripts is a core player capability. |
| ✅ | **The UI** (via the contained launcher) | clicking buttons, typing terminal commands, navigation | This is a human's own I/O. We mimic it, we don't exceed it. |
| ❌ | **Engine internals** | reading React fibers / JS objects for hidden numbers, mutating game state, reading the save file, RNG/seed inspection | Not exposed to a normal player. This is *data hacking*, not *playing*. |

### The bright line
**Forbidden = inspecting or altering internal data.** If a normal player+scripter cannot see it or do it
through the API or the UI, neither do we. No save scraping, no object mutation, no hidden-state reads.

### The one gray area, ruled
The stealth-`document` reference (e.g. `globalThis['doc'+'ument']`) dodges the **25 GB RAM penalty** the
game applies to UI automation. **Ruling: permitted, but ONLY to perform UI interfacing** (clicks and
keystrokes a human makes). It must **never** be used to read or mutate internal state.

*Rationale:* the underlying act — clicking a button, typing a command — is a human capability that costs a
human nothing. Matching that cost is matching human capability, not exceeding it. The moment the same DOM
handle is used to scrape hidden numbers or mutate game objects, it crosses the bright line and is banned.

---

## 2. The Three Mechanisms

| # | Mechanism | What it is | RAM | Needs SF4? | Mimics |
|---|-----------|-----------|-----|-----------|--------|
| 1 | **`ns.run` / `ns.exec`** | Normal in-game script launch | ~1.3 GB/call | No | nothing — sanctioned API |
| 2 | **Singularity + RAM-dodge** (`lib/ns_dodge`) | A script calls the *official* player-action API and we dodge its 16 GB cost via a 1.6 GB temp script | low (dodged) | **Yes** | a script *driving the API* |
| 3 | **Stealth-DOM** (contained launcher only) | Grab the real `document`, then puppet the UI: **3a** inject terminal commands (launch scripts at ~0 RAM); **3b** click real buttons / fill fields | **~0** | No | a **real human at the keyboard/mouse** |

**Where each is used:**
- **#1** — current/legacy launching; kept as the **fallback** when the DOM path is unavailable or breaks.
- **#2** — the primary **Thread-P** action path *once SF4 exists* (faction work, augs, programs, travel, crime).
- **#3a** — the **launcher's** way to start/stop daemons for ~0 RAM (dissolves the RAM walls — see §5).
- **#3b** — what the API **cannot** reach: the casino (blackjack), and player actions **before SF4**.

#2 and #3 are genuinely different: #2 is *API-driven*, #3 is *UI-puppeting*. They overlap in **what** they
can achieve (both can perform player actions) but differ in **mechanism, RAM cost, and SF4 requirement**.

---

## 3. The Contained Launcher — `cross/launcher.ts`

**Architectural law: this is the ONLY file in the repo permitted to touch the DOM.** Every other module
stays clean and idiomatic. The DOM fragility — the one thing that breaks on a game update — lives in
exactly one quarantined place.

- **Capabilities:** 3a terminal-command injection (launch/kill scripts at ~0 RAM) and 3b UI clicks
  (casino, pre-SF4 player actions). Both are **UI interfacing only** — never data reads (§1 ruling).
- **Mechanics (3a) — proven primitive** (from inigo `src/augment/completeBitnode.ts:44` and alainbryden
  `scan.js:36`). Stealth DOM via `eval("document")` (the static RAM analyzer never sees the literal
  `document` token, so no 25 GB penalty), then invoke the terminal input's **React event handlers
  directly** — React stows them on the element; `Object.keys(el)[1]` is the handler-bearing prop:

  ```ts
  const doc = eval("document") as Document;
  const input = doc.getElementById("terminal-input") as HTMLInputElement | null;
  if (!input) { /* terminal not visible → fall back to ns.exec */ }
  const handlerKey = Object.keys(input)[1];                         // React props key
  (input as any)[handlerKey].onChange({ target: { value: command } });
  (input as any)[handlerKey].onKeyDown({ key: "Enter", preventDefault: () => null });
  ```

  (For non-terminal inputs the casino code uses a **native value-setter** instead —
  inigo `src/casino/libDom.ts:33`; buttons use `el[Object.keys(el)[1]].onClick({ isTrusted: true })`,
  alainbryden `casino.js:479`. Those are for 3b, a later step.)
- **Resilience:** feature-detect (`if (!input) throw / fall back`) before use; if the terminal element is
  absent (game version drift or terminal not visible), **fall back to `ns.exec`** (#1). Log loudly on mismatch.
- **RAM:** ~1.6 GB pure-injection; **~2.6–2.9 GB** with the `ns.exec` safety fallback compiled in (referencing
  `ns.exec` statically costs ~1.3 GB whether or not it fires). Still trivially lean vs. the 15.85 GB coordinator.

---

## 3a. Compute-thread daemon spawning — manager decision (2026-06-29)

All infrastructure daemon lifecycle (spreader, hacknetManager, phaseDetector, bootAgent,
pservManager, gameAgent, stockEngine, and coordinator) is owned by the `bootstrap.ts`
orchestrator using **`ns.exec` + `ns.ps`-based running-set guards (Mechanism #1)**.
`cross/launcher.ts` (Mechanism #3a) is reserved for terminal-only commands, player UI actions,
and MCP hands-free control.

**Why `ns.exec`, not `launch()`:**
- **RAM-equivalent:** the orchestrator already pays the 1.3 GB `ns.exec` cost for worker spray,
  so daemon-exec is free on top.  `launch()` would save nothing because it references `ns.exec`
  for its fallback anyway.
- **More robust:** `ns.exec` returns a synchronous PID; `ns.ps`/`ns.isRunning` reflect the
  spawn instantly — no double-spawn race, no cooldown constant needed.
- **Cleaner separation:** the launcher stays reserved for Mechanism #3a (terminal/player/MCP
  actions).  The process separation that dissolves the 15.85 GB import wall comes from each
  daemon being its own process — which `ns.exec` delivers — not from terminal injection.

`cross/launcher.ts` does **not** need to be imported by the orchestrator.

---

## 4. The MCP Control Surface — half-auto, half-steerable

**Goal: hands-free.** One human input to start (run the launcher once, or approve the first action);
everything after is **autonomous where trusted, MCP-triggerable where not.**

- **Plumbing:** the existing **port bus** (`PORT_CMD` ch1, `PORT_DECISION` ch4) + the **game-bridge MCP**
  (`cross/game_agent.ts`). The agent writes a command (today via the existing `write_port` MCP tool;
  dedicated ergonomic tools later); a daemon reads it; the **launcher executes it via the UI**.
- **Command types:** launch/kill a script or daemon; trigger a player module (join faction, buy aug, buy
  program, travel, crime); **answer a notify-and-wait decision** the system surfaced.
- **Division of labour:**
  - **Compute thread** → full auto (pure stats, no human surface needed).
  - **Player thread** → auto where trusted; otherwise surfaced as **both** a notification **and** an
    MCP command the agent or user can fire. Nothing strategic (BitNode choice, reset) auto-decides.

So the agent can, e.g., trigger the bootstrap directly over MCP, then watch and steer — the user stays
hands-free except for the genuine judgment calls.

### Command protocol (step 3 — grounded design)

Grounding (bus audit, 2026-06-29): **PORT_CMD (1) is taken** — `boot_agent` reads it for structured
`BootCommand` JSON (exec/run/kill/getState/ps). Ports **5–9 reserved**, **10–11 in use**, **12–20 free**
and reachable by the MCP `write_port`/`read_port` tools (range 1–20). The MCP port tools relay through
**`game_agent`'s** file command-loop (`/status/.cmd.json`), so **`game_agent` must be running for any
MCP-driven port I/O** — it is the relay; the always-on WebSocket bridge only handles file/RAM/server ops.

**Design — no new daemon, no new MCP tool, ~0 RAM added:**
- New port **`PORT_LAUNCHER = 12`** — carries **raw terminal-command strings** (queue).
- `launcher.ts` — **export** `runTerminalCommand` (currently private).
- `game_agent.ts` — in its existing ~200 ms loop, **pop `PORT_LAUNCHER` and inject** any command via
  `runTerminalCommand`; push the outcome to `PORT_NOTIFY` / decisions for visibility. Importing the
  launcher primitive adds ~0 RAM (eval-hidden `document` = 0; `ns.exec` already present in `game_agent`).
- **Drive from MCP** with the *existing* `write_port(12, "run /bootstrap.js")` tool → `game_agent` relays
  to port 12 → next loop pops + injects. The agent can thus trigger **any** terminal action a human could
  (run scripts, `connect`, buy at the darkweb, manual hack…), not just `ns.exec` scripts.

**Why not the alternatives:** reusing PORT_CMD breaks `boot_agent`; a separate launcher-daemon adds a
2.9 GB thread for a job `game_agent` (already required as the MCP relay) does for free; a bespoke
`inject_terminal` MCP tool needs a bridge rebuild + session reload — defer it as ergonomic sugar once the
raw path is proven.

**Validation (full loop):** with `game_agent` running, `write_port(12, "run /<script>.js")` from MCP →
confirm the script starts in-game. **RAM caveat:** `game_agent` (~6.5 GB) + a running `bootstrap` (4.6 GB)
won't co-fit on an 8 GB home — to test on the fresh node, `kill /bootstrap.js` first, then
`run /cross/game_agent.js`.

### Read-side: perceiving the screen

Injection gives the agent a **write** hand on the UI. The symmetric **read** hand — reading the *visible
screen* (terminal output, on-screen panels) — closes the perceive→act loop and is squarely inside the
capability boundary: **a human reads the screen.** Reading rendered/visible text is UI-interfacing, the
same class as clicking. (Still forbidden per §1: reading React/JS internals, the save, or hidden state.
The line is "what's painted on screen" vs "what's in the engine.")

- **Mechanism:** `launcher.ts` exports `readScreen(maxChars = 4000): string` — same stealth
  `eval("document")`, then `getElementById('terminal').innerText` (the terminal output container).
  UI read of rendered text only; returns `''` on element-absent or throw so the daemon loop never
  crashes on game-version drift. Adds **0 GB** (eval-hidden document; no `ns.*` calls).
  **Selector grounded:** `#terminal` is the output container confirmed against alainbryden
  `scan.js:42` (it appends `<li>` terminal lines to `getElementById("terminal")`) — the same proven
  source as the `terminal-input` write path. In-game smoke still recommended, but the id is not a guess.
- **Exposure (built — mirror-file, no new MCP tool, no bridge rebuild):** `game_agent` calls
  `mirrorScreen(ns, tick)` in its main loop, throttled to every 5th tick (~1 s cadence). Each mirror
  writes `{ ts: Date.now(), text }` to `status/screen.txt` — exactly parallel to `status/heartbeat.txt`.
  The external agent reads it via the existing MCP `read_file("status/screen.txt")` path; the
  always-on WebSocket bridge handles the file read directly. A port-pair request/response was
  considered and rejected: the mirror file is simpler, needs no new MCP tool, and matches the
  heartbeat pattern already proven in step 3.
- **Why it matters:** the agent can inject a command *and then read the resulting terminal output to
  verify* — genuine closed-loop hands-free operation, instead of inferring success from a port receipt.
- **Existing read surface (for contrast):** the agent already reads ports, files, RAM, server lists, and
  (via `game_agent`) the heartbeat/decisions/notify mirrors. "Read the screen" adds the one missing thing:
  the *rendered* output a human would eyeball.
- **⚠️  Selector to verify in-game:** `getElementById('terminal')` — confirm this id matches the current
  game version during live testing. The empty-string fallback ensures drift is silent but detectable.

---

## 5. What this dissolves

- **The bootstrap RAM wall** — a ~free launcher imports nothing heavy and pays no exec cost, so the
  8 GB-home constraint stops mattering for orchestration.
- **The "coordinator is 15.85 GB" problem** — instead of one fat coordinator that *imports* the whole
  stack, the launcher fires up each heavy daemon (batcher, scheduler, stock, …) as its **own process the
  instant RAM allows**, and hosts the phase switch itself.
- **The 32 GB handoff cliff** (`BOOTSTRAP_HANDOFF_RAM`) becomes a **gradual ramp** — daemons come online
  as they fit, rather than one all-or-nothing jump. Revisit/retire that constant once the launcher lands.

---

## 6. Status & build order (only after this doc is ratified)

1. ✅ **Ratify** this doc + the `00 §2.5` capability-boundary principle. *(ratified 2026-06-29)*
2. ✅ **Spike** `cross/launcher.ts` (3a terminal injection + `ns.exec` fallback). **Built; `tsc` green;
   game-validated at 2.9 GB** (proves `eval("document")` dodges the 25 GB penalty — would be ~27.9 GB
   otherwise). Registered as `SCRIPT_PATHS.launcher`. **In-game behavior CONFIRMED 2026-06-29**:
   `run /cross/launcher.js run /bootstrap.js` injected `run /bootstrap.js` into the live terminal and the
   game executed it (genuine injection, not the `ns.exec` fallback; React-key index `[1]` matched the
   current game version). Terminal-puppeting proven end-to-end.
3. ✅ **Wire** the MCP command channel (reuse ports + `game_agent`). **Built; `tsc` green; `game_agent`
   RAM-neutral at 6.55 GB** (launcher import adds ~0). `PORT_LAUNCHER=12` carries raw terminal strings;
   `game_agent` pops + injects one per loop. **Live loop CONFIRMED 2026-06-29**: MCP `write_port(12, "ls")`
   → `game_agent` injected `ls` → receipt `{type:'LAUNCHER_INJECT', command:'ls', ok:true}` read back over
   MCP on PORT_NOTIFY. External-agent → in-game UI action proven end-to-end.
   - **Known quirk (pre-existing, minor):** `game_agent`'s `writePort` relay reports `"Port full"` (a false
     negative) — newer Bitburner `writePort` returns the evicted element on overflow but the write still
     lands. Fix later: treat the queue-style write as success. Did not affect delivery (receipt `ok:true`).
4. ✅ **Migrate** bootstrap/coordinator to orchestrator-driven daemon spawning; retire the handoff
   cliff. **Built; `tsc` green; game-validated at 4.8 GB** (bootstrap.ts; ns.exec + ns.ps guards;
   no compute-stack imports, no launcher import).  `BOOTSTRAP_HANDOFF_RAM` removed from config and
   all call-sites.  `coordinator.ts` gutted of daemon-launch role → pure batch engine spawned by
   orchestrator at MID (≥ 64 GB home). `DAEMON_CATALOG` + `phaseRank` + `DAEMON_LAUNCH_RESERVE`
   added to `lib/config.ts`.  **In-game validation DONE 2026-06-29**: orchestrator (pid 30) +
   game_agent (pid 11) stable on 16 GB home, no double-spawns, no RAM failures.  Daemons
   idle until home RAM grows (hacknetManager 9.45 GB / phaseDetector 4.45 GB / bootAgent
   4.65 GB — none fit at 16 GB with 4.65 GB free).  **Bug found & fixed:** spreader removed
   from DAEMON_CATALOG (one-shot utility, not a persistent daemon; caused 2 s spawn-storm).
   Gradual ramp confirmed: orchestrator idles cleanly; daemons arrive as RAM rises.
5. ✅ **Layer** player modules as MCP-triggerable commands. **Built; `tsc` green; game_agent
   RAM est. 6.65 GB** (adds `ns.isRunning` 0.1 GB for double-spawn guard; all other new
   code is 0 GB — `ns.read`/`ns.write`/`popPort` already counted).
   - **Trigger path (exists since step 3):** `write_port(12, "run /player/<module>.js [args]")` →
     `game_agent` injects via terminal → script runs in-game.
   - **Receipt path (new):** PORT_NOTIFY drained every tick to `status/notifications.txt`
     (rolling 500-entry JSON array).  `LAUNCHER_INJECT` receipts and any notification pushed
     by `notification.ts` are now externally readable via MCP `read_file`.
   - **Double-spawn guard (new):** `processLauncherCommands` checks `ns.isRunning(script, 'home')`
     before injecting any `run <script>` command.  Already-running scripts skip the inject and
     push `ALREADY_RUNNING` to PORT_NOTIFY.  Prevents duplicate persistent daemons on MCP retry.
   - **Player module classification:**
     - **Safe auto-trigger (fire-and-forget):** `contract_solver` (pure BFS solve, exits),
       `program_acquirer` (default: buys TOR + port openers, exits), `goto <target>` (nav, exits).
     - **Confirm-first (notify then MCP command):** `aug_planner --purchase` (notify "N augs
       available" first; agent/user confirms by writing the command to port 12);
       BitNode-reset decisions (never auto).
     - **Persistent daemons (start once):** `faction_manager` (SF4), `crime` (SF4),
       `program_acquirer --backdoor` — double-spawn guard prevents accidental re-launch.
     - **SF4 gated:** `faction_manager`, `crime`, `aug_planner`, `program_acquirer --backdoor`
       need SourceFile-4 for Singularity API; fire-and-forget safely fails pre-SF4.
   - **Notify-and-wait flow:** player module (or aug_planner running solo) pushes recommendation
     to PORT_NOTIFY → appears in `status/notifications.txt` → MCP agent reads it, decides →
     if approved, writes `run /player/<module>.js --purchase` to port 12.  No new port, no
     new daemon.
   - **In-game validation pending** (deploy updated game_agent; read status/notifications.txt;
     trigger contract_solver via MCP; confirm LAUNCHER_INJECT receipt appears in file).
6. ✅ **Read-side** — screen/terminal scraping via stealth-DOM `innerText`, exposed as a mirror-file read
   path symmetric to step 3's write path (see §4 "Read-side"). **Built; `tsc` green; `game_agent` RAM
   unchanged at 6.55 GB** (`readScreen` import adds 0 GB; `ns.write` for mirror already counted).
   `launcher.ts` exports `readScreen(maxChars=4000): string`; `game_agent` mirrors terminal tail to
   `status/screen.txt` every ~1 s; external agent fetches via existing MCP `read_file` — no new tool,
   no bridge rebuild. Selector `#terminal` grounded against alainbryden `scan.js:42` (proven source).
   **In-game validation DONE 2026-06-29**: `status/screen.txt` confirmed populating; `#terminal`
   selector correct on game v3.0.2; rendered terminal output (game version, ls listing, orchestrator
   spawn logs) captured and readable over MCP.  Read+write loop closed end-to-end.

---

*Status: RATIFIED. Steps 1–6 built and `tsc`-green (2026-06-29). Steps 1–4 and 6 in-game validated. Step 5 pending in-game validation (deploy updated game_agent). Derived from [00 §2.5](00-architecture-philosophy.md).*
