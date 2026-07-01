# MCP ↔ Game Control Channel — Usage Guide

> **Audience:** any agent (or human) driving the running Bitburner game from outside it.
> **Status:** live and validated 2026-06-29. Built per `docs/plan-mcp-realtime-control.md`; problem
> history in `docs/plan-mcp-reliability.md`. This doc is the *how to use it* reference.

---

## 0. Scope: this is dev/debug tooling, not part of gameplay (added 2026-07-01)

**Everything in this document — the MCP tools, `build/game-bridge.ts`, `cross/game_agent.ts`'s
control channel, `cross/boot_agent.ts` — exists so a developer (or an AI coding agent) can push
code, inspect state, and debug the running game from outside it. None of it is a runtime
dependency of autonomous gameplay.**

`src/brain.ts` (docs/design/14) is the single entry point for actually playing the game. It makes
every decision and performs every action on its own, with **zero dependency on any MCP tool, the
bridge process, or a connected control channel** — it must keep running correctly whether or not
this whole apparatus is even started. If you find yourself making `brain.ts` (or anything it
launches via `DAEMON_CATALOG`) call an MCP tool, read a bridge-owned status file as a *decision
input*, or otherwise behave differently based on whether a dev session is attached, that's a
layering violation — back it out.

The one narrow exception: `cross/game_agent.ts` mirrors state to `status/*` files and the control
channel for **observability** (so a dev session can watch what the brain is doing), and its
double-spawn guards keep it safe to run alongside the brain without interfering. It never makes
brain-side decisions and the brain never blocks waiting on it.

---

## 1. What this is

A real-time control surface between the MCP server (what an agent calls) and the running game. It gives
you **~10 ms commands** (run scripts, inject terminal, read/write ports, query player/server) and
**sub-ms state reads** (rendered screen, notifications, heartbeat), with an automatic slow-but-robust
fallback when the in-game agent isn't connected.

```
  Agent (MCP tools)
        │  JSON-RPC over :12526 (admin)
        ▼
  build/game-bridge.ts  ── :12525 RFA ──►  Bitburner game (file sync / RAM / save / servers)
   (Node, via tsx)      ── :12527 control ◄─►  cross/game_agent.js   (in-game daemon)
        │                         state buffer: latestState[channel] = {ts, data}
        ▼
  three WS servers in one process
```

- **:12525 RFA** — the game's built-in Remote File API (files only, poll only, never pushes).
- **:12526 admin** — the MCP server connects here; `control.*` methods are routed to the control socket.
- **:12527 control** — `cross/game_agent.js` dials in from inside the game. This is the fast path.

**Command flow:** MCP tool → admin `control.cmd` → bridge forwards over `:12527` → agent's main loop runs
`ns.*` / terminal-injection → replies on the same socket → bridge → MCP. One round-trip, no files.

**State flow:** the agent pushes `screen`/`notifications`/`heartbeat`/`decisions` frames over `:12527`;
the bridge buffers the latest per channel; `control.state` reads the buffer instantly (no game round-trip).

**Fallback:** if `:12527` is down, the MCP `terminal`/`write_port`/`read_port` tools fall back to the RFA
file-relay (`status/.cmd.json` → agent drains it → `status/.result.json`). Always available, ~hundreds of ms.

---

## 2. The one rule (if you edit `cross/game_agent.ts`, read this first)

**A WebSocket callback (`onopen`/`onmessage`/`onclose`/`onerror`) must NEVER call `ns.*`.**

WS callbacks run *outside* the Netscript async context. Any `ns` call from one throws *uncaught*, and the
engine kills the script — bypassing the loop's `try/catch`, so it looks like a silent mid-startup death.
This cost real debugging time once; don't relearn it.

- ✅ Allowed in callbacks: `JSON.parse`, `ws.send`, mutating plain JS module state, pushing to a queue.
- ❌ Forbidden in callbacks: `ns.print`, `ns.write`, `ns.writePort`, `ns.run`, `ns.getPlayer` — anything `ns`.

**Pattern in the code:** `onmessage` validates the frame and pushes it to `inbound: ControlCmd[]`. The
**main loop** drains `inbound`, calls `handleControlCmd(ns, cmd)` (all `ns` work, safe here), and replies
with `ws?.send(...)`. The loop drains on a fast tick (`DRAIN_SLEEP_MS = 10`) and runs the heavier
mirrors/state-pushes only every `MIRROR_EVERY` (20) ticks (~200 ms) — that's what keeps commands at ~10 ms
without doing file I/O at 100 Hz.

---

## 3. Bringing it up

**Two independent entry points, two independent prerequisites — don't confuse them:**

| | To play the game | To get MCP dev/debug access |
|---|---|---|
| Run | `run /brain.js` | `run /cross/game_agent.js` |
| Needs the other running? | No — `brain.js` needs nothing from `game_agent.js` or MCP | No — `game_agent.js` only imports `launcher`/`ports`/`decisions`, never `brain.ts` |

In practice `brain.js` auto-launches `game_agent.js` for you once phase ≥ EARLY (it's an `ESSENTIAL`-tier
`DAEMON_CATALOG` entry, for observability) — so if `brain.js` is already running you usually don't need
to run `game_agent.js` yourself. But if you want MCP access *before* `brain.js` reaches that phase, or
*without* running `brain.js` at all (e.g. debugging a single script in isolation), start it manually:

1. **Bridge** (`build/game-bridge.ts`): run with `pnpm run watch` (also does `tsc -w` + dist sync), or
   standalone `tsx build/game-bridge.ts`. It must log all three servers, including `:12527`.
2. **Game**: in the Bitburner terminal, `run /cross/game_agent.js` (single instance, ~8 GB on home).
   `get_status` should then show `controlConnected: true`. On a completely cold game (nothing running
   yet), this first `run` command must be typed by the user directly in the game window — the MCP
   `terminal` tool's fallback path itself relays through `game_agent.js`, so there's nothing yet to
   relay through until it's started at least once.
3. **MCP server**: launched by Claude Code via `.mcp.json`. Tool changes need a session/`/mcp` reload.

### Deploying a code change to the agent
`tsc` emits `dist/cross/game_agent.js`; the bridge pushes dist→game. If the watcher isn't running (or to
be deterministic), push it explicitly over the admin RFA, then **restart the in-game daemon** so it loads
the new code:
```
# build
npx tsc -p tsconfig.json
# push dist/cross/game_agent.js → home (e.g. push_file MCP tool, or an admin pushFile script)
# then, in the game terminal:
kill /cross/game_agent.js
run  /cross/game_agent.js
```
A running daemon does **not** hot-reload — you must kill+run. The `atExit` handler closes its socket on
kill, so no zombie sockets linger. (Bitburner does not auto-close sockets a killed script opened, hence
the explicit `atExit`.)

---

## 4. MCP tools (the agent-facing surface)

Real-time tools prefer the control channel and fall back to the file-relay automatically:

| Tool | Purpose | Path |
|------|---------|------|
| `terminal` | Inject a terminal command (drive the game as a human would) | control → relay |
| `write_port` | Write a Netscript port; returns `{success:true, evicted}` (`null` = clean write) | control → relay |
| `read_port` | Read/peek a Netscript port | control → relay |
| `get_screen` | Latest rendered terminal text `{ts, text}` (sub-ms; from the state buffer) | control buffer |
| `get_notifications` | Buffered `PORT_NOTIFY` array | control buffer |
| `get_status` | Bridge/game/`controlConnected` health | admin-local |

RFA / file tools (always available, independent of the control agent):
`list_servers`, `list_files`, `read_file`, `push_file`, `delete_file`, `calculate_ram`, `get_save`,
`get_monitoring`.

### `control.cmd` method reference (the §2a wire protocol, frozen)
`terminal{command}` → `{injected}` · `run{script,threads?,args?}` → `{pid}` ·
`kill{pid?|script?,host?}` → `{killed}` · `ps{host?}` → `[{filename,threads,pid}]` ·
`getPlayer{}` · `getServer{target?}` · `readPort{port}` · `writePort{port,data}` → `{evicted}` ·
`peekPort{port}` · `ping{}` → `{pong}`.
State channels (read via `control.state`): `screen` (string) · `notifications` (array) ·
`heartbeat` (object) · `decisions` (array).

---

## 5. Performance & behavior you can rely on

- `control.cmd` round-trip ≈ **10 ms** (bounded by the 10 ms drain tick), `ping` ≈ 4–10 ms.
- `control.state` / `control.status` ≈ **sub-millisecond** (served from the bridge buffer, no game hop).
- `write_port` on a clean write → `{evicted: null}`; a full port → the evicted element. It does **not**
  report failure for a successful write (the old "Port full" bug is gone — that was a v3 semantics misread).
- When the agent is down: `controlConnected:false`, and `terminal`/`write_port`/`read_port` transparently
  use the file-relay (slower, ~hundreds of ms). The mirrors keep writing `status/*.txt` regardless.
- Double-spawn guard: `terminal("run /cross/game_agent.js")` while it's already running returns an
  `ALREADY_RUNNING` notification instead of starting a second instance.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `controlConnected:false` but agent "running" | agent crashed at startup (often an `ns` call in a WS callback) | check the loop only does `ns` work in the main loop; kill+run; verify it survives past the first tick |
| commands ~200 ms, not ~10 ms | running an old build without the fast-drain split | rebuild, push, kill+run the daemon |
| `write_port` "control agent not connected" then slow | control socket down | expected fallback; restart the daemon to restore the fast path |
| agent file on home reads empty / wrong size | partial push during a dist rebuild race | re-push `dist/cross/game_agent.js` explicitly, then kill+run |
| RAM jumped ~25 GB | a literal `WebSocket`/`document`/`window` token leaked into source | route it through `eval('…')` so the static RAM parser never sees the token; verify with `calculate_ram` (expect ~8 GB) |
| second agent instance appears | manual double `run` | `kill /cross/game_agent.js` until `ps` shows one (or none), then `run` once |

**DOM/WebSocket access** always goes through the `eval('WebSocket')` / `eval('document')` dodge: the 25 GB
`Dom` penalty is charged by the *static source parser* finding the literal token, **not** by runtime DOM
use — so `eval`-hiding the token defeats it. The agent runs at ~8 GB; `launcher.js` touches the DOM every
tick yet costs 2.9 GB. The capability boundary (design/04 §1): DOM is for UI interfacing only (terminal
inject + rendered-text read), never engine internals.
