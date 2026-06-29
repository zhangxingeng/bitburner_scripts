# Plan: Real-Time MCP↔Game Control Channel (WebSocket bridge + RFA fallback)

> **Status:** ✅ **COMPLETE — Phases 0–4 built and in-game validated 2026-06-29. Problems 1 & 2 RESOLVED.**
> Day-to-day usage lives in **`docs/mcp-control-channel-usage.md`** (read that to *use* the channel; read
> this to understand *how it was built* and *why*).
> **Owner workflow:** Opus plans (this doc) → Sonnet agents build each phase → Opus audits + in-game validates.
> **Supersedes:** the "fix order" in `plan-mcp-reliability.md` (that doc is now the *problem analysis*; this is the *build plan*).
> **Decision (ratified by user 2026-06-29):** Option B — in-game WebSocket control channel as the
> primary surface, with the cleaned-up RFA file-relay kept as a robust fallback.
>
> ### Validation results (2026-06-29)
> - **Problem 1 (write_port false-failure): FIXED** — clean write → `{evicted:null}`, read-back correct.
> - **Problem 2 (latency): FIXED** — `control.cmd` round-trips at **~10 ms** (ping avg 10.0 ms, writePort/
>   getPlayer/terminal all ~10–12 ms); state reads (`control.state` screen/heartbeat) at **sub-millisecond**.
>   Down from the legacy file-relay's ~400–600 ms.
> - **Single agent, no zombies**; `atExit` socket-close + reconnect verified.
>
> ### ⚠️ Root-cause that cost the most time (read before touching the agent)
> The agent crashed at startup, dying mid-first-loop while *bypassing its own try/catch*. Cause: **`ns.*`
> calls from a WebSocket callback throw uncaught and the engine kills the script.** The original Phase 3
> guidance ("keep handlers synchronous, run them inline in `onmessage`") was **wrong** — *synchronous* is
> not enough; **no `ns` call of any kind is allowed in a WS callback.** The fix: callbacks (`onopen`/
> `onmessage`/`onclose`/`onerror`) only mutate plain JS state and **enqueue**; the **main loop** drains the
> queue and does all `ns` work + `ws.send` (it runs inside the Netscript async context). This also
> explained the earlier `writePort`/`getPlayer` "ScriptDeath" failures (same illegal ns-from-callback).
> See the corrected rule in §5 and the implementation in `src/cross/game_agent.ts`.

This plan is self-contained. A build agent should be able to execute its assigned phase by reading
**§1 (architecture)**, **§2 (the frozen wire protocol)**, and its phase section — without re-deriving the design.

---

## 0. Why we're doing this (one paragraph of context, do not skip)

The current MCP control path tunnels an in-game IPC primitive (Netscript ports) through a polling
file-relay (`status/.cmd.json` → game_agent 200 ms loop → `status/.result.json` → MCP 200 ms poll).
That causes the two blocking problems: (1) `write_port` always reports `"Port full"` because the relay
misreads `ns.writePort`'s v3 return value, and (2) every call costs ~400–600 ms across four async hops.
**Root cause:** the game's Remote File API (RFA) is *files-only and poll-only* — it has no run/exec/
terminal/port method and never pushes — so any control *through RFA alone* is doomed to relay latency.
**The fix:** an in-game daemon opens its **own** outbound WebSocket to our bridge (proven viable:
in-game `fetch()`/`WebSocket` works — see `example_code_dump/inigo-bitburner-scripts/src/metacontracts/libFunctionWriter.ts`
and the [socketburner](https://github.com/MasonD/socketburner) project). That gives push-based,
bidirectional, ~1–5 ms control with no polling and no port tunneling. Full research in the session
transcript; key facts are inlined where needed below.

---

## 1. Target architecture

Three WebSocket servers run inside the bridge process (`build/game-bridge.ts`):

```
  ┌─────────────────────────── build/game-bridge.ts (Node, run via tsx) ──────────────────────────┐
  │                                                                                                 │
  │   :12525  RFA server      ← game connects as client (existing; file sync, RAM, save, servers)  │
  │   :12526  admin server    ← MCP server connects as client (existing; + NEW control.* routing)  │
  │   :12527  CONTROL server  ← in-game control_agent connects as client (NEW)                      │
  │                                                                                                 │
  │   state buffer: latestState[channel] = { ts, data }   (filled by control_agent state pushes)    │
  └─────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲                              ▲                                   ▲
        │ JSON-RPC (files)             │ JSON-RPC (files + control.*)      │ control protocol (§2)
        │                              │                                   │
   Bitburner game              MCP server (index.ts)                in-game control_agent
   (built-in RFA client)       (talks ONLY to :12526)               (cross/game_agent.js — evolved)
```

**Command flow (MCP → game):** MCP tool → admin `control.cmd` → bridge forwards over `:12527` →
control_agent executes via `ns.*` / terminal-injection → replies on the same socket → bridge → MCP.
One round-trip, no files, no polling.

**State flow (game → MCP):** control_agent pushes `screen`/`notifications`/`heartbeat`/`decisions`
frames over `:12527` → bridge buffers latest per channel → MCP `control.state` reads the buffer
instantly (no game round-trip).

**Fallback (RFA):** if `:12527` is not connected, MCP control tools fall back to the existing
file-relay path (`status/.cmd.json`), which control_agent keeps draining. Slower but always-available.

---

## 2. THE WIRE PROTOCOL (frozen — all three components implement against this exactly)

Every build agent MUST implement these shapes verbatim. Do not rename fields. All frames are JSON text.

### 2a. Control socket — bridge `:12527` ↔ control_agent

**Command (bridge → control_agent):**
```json
{ "t": "cmd", "id": 42, "method": "terminal", "params": { "command": "ls" } }
```
`method` is one of:

| method      | params                                              | returns in `data`                          |
|-------------|-----------------------------------------------------|--------------------------------------------|
| `terminal`  | `{ command: string }`                               | `{ injected: boolean }`                     |
| `run`       | `{ script: string, threads?: number, args?: [] }`   | `{ pid: number }`                           |
| `kill`      | `{ pid?: number, script?: string, host?: string }`  | `{ killed: boolean }`                       |
| `ps`        | `{ host?: string }`                                 | `[{ filename, threads, pid }]`              |
| `getPlayer` | `{}`                                                | player snapshot (same shape as today)       |
| `getServer` | `{ target?: string }`                               | server snapshot (same shape as today)       |
| `readPort`  | `{ port: number }`                                  | the value read (or `"NULL PORT DATA"`)      |
| `writePort` | `{ port: number, data: string }`                    | `{ evicted: <value>\|null }`                |
| `peekPort`  | `{ port: number }`                                  | the peeked value                            |
| `ping`      | `{}`                                                | `{ pong: <ts> }`                            |

**Response (control_agent → bridge):**
```json
{ "t": "res", "id": 42, "ok": true,  "data": { "injected": true } }
{ "t": "res", "id": 42, "ok": false, "error": "Cannot run x.js: insufficient RAM" }
```
`id` echoes the command's `id`. `ok=false` only for actual failures (exception, RAM gate, bad args).

**State push (control_agent → bridge, unsolicited, no id):**
```json
{ "t": "state", "channel": "screen", "ts": 1730000000000, "data": "<rendered terminal text>" }
```
`channel` ∈ `"screen" | "notifications" | "heartbeat" | "decisions"`. `data` is channel-specific
(string for screen; array for notifications/decisions; object for heartbeat).

### 2b. Admin socket — MCP `:12526` ↔ bridge (extends the existing JSON-RPC proxy)

MCP sends the existing envelope `{ jsonrpc: "2.0", id, method, params }`. Bridge routing rule:

- `method` **does NOT** start with `control.` → unchanged: forward to the RFA game socket (`:12525`).
- `method === "control.cmd"` → `params = { method, params }` (the inner command from §2a).
  Bridge assigns an internal control id, forwards `{t:"cmd", id, method, params}` to the control
  socket, correlates the `{t:"res", id}` reply, and returns it to MCP as `{ result: <data> }` (on
  `ok:true`) or `{ error: <error> }` (on `ok:false`). If the control socket is **not connected**,
  reply immediately with `{ error: "control agent not connected" }`.
- `method === "control.state"` → `params = { channel }`. Bridge replies **locally** from its buffer:
  `{ result: latestState[channel] ?? null }`. No forward to the game.
- `method === "control.status"` → reply `{ result: { controlConnected: <bool> } }`. No forward.

---

## 3. Phases

Phases 1, 2, 3 are **file-disjoint** (`build/game-bridge.ts`, `build/game-bridge-mcp/src/index.ts`,
`src/cross/game_agent.ts`) and all implement the §2 protocol — so they can be built **in parallel by
three separate Sonnet agents**. They cannot be *validated* until all three land; Phase 4 (manager)
integrates and validates in-game. Phase 0 is a 5-minute prerequisite that can be folded into Phase 3.
Phase 5 is deferred follow-on, not part of the MCP channel.

---

### Phase 0 — Fix the `writePort` false-failure (prerequisite, trivial)

**Problem:** `write_port` always returns `{"success":false,"error":"Port full"}` even when the write lands.

**Root cause:** `src/cross/game_agent.ts:317` — `result.success = written !== null`. Per the type def
(`NetscriptDefinitions.d.ts:8661`: *"@returns The data popped off the queue if it was full, or null if
it was not full"*), `ns.writePort` returns `null` on a **clean** write and a non-null value **only**
when it evicted. The code treats the clean-write `null` as failure → every successful write reports
`"Port full"`. `ns.writePort` has no boolean failure mode; it only throws on a bad port number.

**Approach:** in the `writePort` case of `executeCommand` (`src/cross/game_agent.ts:310-320`), replace:
```ts
result.data    = written;
result.success = written !== null;
if (!result.success) result.error = 'Port full';
```
with:
```ts
result.success = true;            // writePort never "fails" except by exception (caught above)
result.data    = written;         // null = appended cleanly; non-null = the evicted element
```
The surrounding `try/catch` already maps a thrown error (e.g. invalid port) to `result.error`.

**Verify:** `npx tsc --noEmit --incremental false` clean. Logic review: a normal write → `success:true`,
`data:null`. (Full in-game check happens in Phase 4.) The same corrected semantics are reused in the
control path (§2a `writePort` returns `{ evicted }`).

**Note:** the legacy file-relay `writePort` case stays (it's the RFA fallback) — just corrected.

---

### Phase 1 — Bridge control channel (`build/game-bridge.ts`)

**Goal:** add the `:12527` control server, the state buffer, and the admin `control.*` routing from §2b.

**Files:** `build/game-bridge.ts` only.

**Tasks:**
1. **Add module state** (near the existing `adminSockets`/`adminPending` declarations, ~line 24):
   ```ts
   let controlSocket: WebSocket | null = null;          // the in-game control_agent connection
   const controlPending = new Map<number, { adminSocket: WebSocket; adminId: number }>();
   let nextControlId = 1;
   const latestState: Record<string, { ts: number; data: unknown }> = {};
   ```
2. **Add the control WebSocket server** on port **12527** (mirror the `adminWss` block at ~line 396):
   - `controlWss.on("connection", socket => { controlSocket = socket; ... })` — log `[CONTROL] connected`.
   - `socket.on("message", ...)` parses control frames:
     - `t === "res"` and `controlPending.has(msg.id)` → look up `{adminSocket, adminId}`, send
       `{ jsonrpc:"2.0", id: adminId, result: msg.data }` (if `msg.ok`) or `{ ..., error: msg.error }`
       (if `!msg.ok`) back to that admin socket; `controlPending.delete(msg.id)`.
     - `t === "state"` → `latestState[msg.channel] = { ts: msg.ts, data: msg.data }`.
   - `socket.on("close", ...)` → `controlSocket = null`; reject/cleanup any `controlPending` entries
     for this socket (reply `{ error: "control agent disconnected" }` to waiting admin clients).
   - `controlWss.on("error", ...)` → handle `EADDRINUSE` like the other servers.
3. **Extend the admin message handler** (the `adminWss` `socket.on("message")` at ~line 402). BEFORE
   the existing "forward to gameSocket" logic, branch on `req.method`:
   - `"control.status"` → `socket.send({ jsonrpc:"2.0", id: req.id, result: { controlConnected: controlSocket?.readyState === 1 } })`.
   - `"control.state"` → `socket.send({ jsonrpc:"2.0", id: req.id, result: latestState[req.params?.channel] ?? null })`.
   - `"control.cmd"`:
     - if `!controlSocket || controlSocket.readyState !== 1` → `socket.send({ jsonrpc:"2.0", id: req.id, error: "control agent not connected" })`.
     - else → `const cid = nextControlId++; controlPending.set(cid, { adminSocket: socket, adminId: req.id });`
       `controlSocket.send(JSON.stringify({ t:"cmd", id: cid, method: req.params.method, params: req.params.params }))`.
   - any other `control.*` → reply `{ error: "unknown control method" }`.
   - else (no `control.` prefix) → existing RFA forward path, unchanged.
4. **Note:** the existing admin guard `if (!gameSocket ...) { reply "Game not connected" }` must NOT
   block `control.*` methods (control doesn't need the RFA game socket). Move/guard accordingly:
   `control.*` is handled before the gameSocket check.
5. **Startup log:** add `log("CONTROL", "Control server listening on port 12527")`.

**Verify:**
- `tsx build/game-bridge.ts` (or `pnpm run watch`) starts with no error and logs all three servers.
- `:12527` is listening (`ss -ltnp | grep 12527` or a quick `new WebSocket('ws://localhost:12527')` from a scratch node script connects).
- With no control_agent running: an admin `control.status` returns `{controlConnected:false}` and
  `control.cmd` returns `{error:"control agent not connected"}` (test via the MCP `get_status`-style
  path once Phase 2 lands, or a scratch ws client).

---

### Phase 2 — MCP server control tools (`build/game-bridge-mcp/src/index.ts`)

**Goal:** expose real-time control tools that route over admin `control.*`, fix `write_port`/`read_port`,
and fall back to the existing file-relay when the control agent is down.

**Files:** `build/game-bridge-mcp/src/index.ts` only.

**Tasks:**
1. **Add a helper** `controlCmd(method, params)` that calls `rpc("control.cmd", { method, params })`
   and returns the result, OR throws a sentinel `ControlUnavailable` error when the rpc rejects with
   `"control agent not connected"` / `"control agent disconnected"`. Add `controlState(channel)` →
   `rpc("control.state", { channel })` and `controlStatus()` → `rpc("control.status")`.
2. **New tool `terminal`** — inject a terminal command (REPLACES `write_port(12, cmd)` for injection):
   - input: `{ command: string }`.
   - try `controlCmd("terminal", { command })` → return `{ injected }`.
   - on `ControlUnavailable`: fall back to the legacy PORT_LAUNCHER path — `pushFile status/.cmd.json`
     with `{ method:"writePort", port:12, data: command }` (the existing relay drains port 12 and
     injects). Note in the returned text that the slow fallback was used.
   - description: explain this is the fast path for driving the in-game terminal; note ~1–5 ms when the
     control agent is connected.
3. **Rewrite `write_port`** to prefer control: `controlCmd("writePort", { port, data })` → return
   `{ success:true, evicted: <data.evicted> }`. On `ControlUnavailable`, fall back to the existing
   file-relay block (with the Phase 0 corrected semantics: `success:true`, `data=evicted/null`).
4. **Rewrite `read_port`** the same way: `controlCmd(peek ? "peekPort" : "readPort", { port })` →
   return the value. Fall back to file relay on `ControlUnavailable`.
5. **New tool `get_screen`** — `controlState("screen")` → return `{ ts, text }` (or a "no screen yet"
   note if `null`). This is the fast read-side; the old `status/screen.txt` via `read_file` remains as
   the RFA fallback.
6. **New tool `get_notifications`** — `controlState("notifications")` → return the buffered array.
7. **(Optional) `run_script` / `kill_script`** — thin wrappers over `controlCmd("run"/"kill", ...)`.
   Only add if cheap; the `run` method already exists in the relay too.
8. **Extend `get_status`** to also report `controlConnected` from `controlStatus()`.
9. Keep ALL existing tools (`list_servers`, `read_file`, `push_file`, `get_monitoring`, etc.) unchanged.

**Verify:**
- `pnpm --dir build/game-bridge-mcp exec tsc --noEmit` clean (the MCP package has its own tsconfig).
- Tool list loads (server boots via `tsx src/index.ts` with no error).
- End-to-end behavior is validated in Phase 4 (needs the game + control_agent).

---

### Phase 3 — Evolve the in-game agent into a control agent (`src/cross/game_agent.ts`)

**Goal:** `game_agent.js` opens an outbound WebSocket to `:12527`, executes control commands in real
time, pushes state, auto-reconnects, and KEEPS the existing file-relay + mirrors as the RFA fallback.
Keep the filename `/cross/game_agent.js` (don't churn launch paths / `SCRIPT_PATHS.gameAgent`).

**Files:** `src/cross/game_agent.ts` only. Reuses `runTerminalCommand`, `readScreen` from
`./launcher` (already imported) and `popPort`/`peekPort`/`pushPort` + `PORT_*` from `../lib/ports`.

**Tasks:**
1. **Apply the Phase 0 `writePort` fix** here if not already done (this file owns `executeCommand`).
2. **Add a `terminal` method** to `executeCommand` (or a parallel `executeControlCommand`): calls
   `runTerminalCommand(params.command)` and returns `{ injected }`. Honor the existing **double-spawn
   guard** for `run`/`terminal run ...` (the `ns.isRunning` check in `processLauncherCommands`).
3. **Open the control WebSocket** using the stealth-eval dodge (0 GB, same pattern as `launcher.ts`):
   ```ts
   // eslint-disable-next-line no-eval
   const WS = eval('WebSocket') as typeof WebSocket;
   ws = new WS('ws://localhost:12527');
   ```
   - `ws.onopen` → set `connected = true`; log; optionally send an initial state burst.
   - `ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.t === 'cmd') { const r = handleCmd(ns, m); ws.send(JSON.stringify(r)); } }`
     where `handleCmd` returns `{ t:'res', id:m.id, ok:true, data }` or `{ t:'res', id:m.id, ok:false, error }`.
   - `ws.onclose` / `ws.onerror` → set `connected = false`, null the socket so the reconnect tick re-opens.
4. **CONCURRENCY CONSTRAINT (critical — this is the rule that, gotten wrong, crashed the agent):**
   **A WS callback must never call `ns.*` — not even a synchronous one.** The original draft of this step
   said "handle commands inline in `onmessage` since the ns calls are synchronous"; that is WRONG. Any
   `ns` call from `onopen`/`onmessage`/`onclose`/`onerror` throws *uncaught* and the engine terminates the
   script (it bypasses the loop's try/catch, so it looks like a silent death). **Correct pattern:**
   `onmessage` only validates + pushes the command onto an in-memory `inbound: ControlCmd[]` queue;
   `onopen` only sets `connected`/a `justConnected` flag; `onclose`/`onerror` only null the socket. The
   **main loop** then drains `inbound`, calls `handleControlCmd(ns, cmd)` (all `ns` work happens here,
   inside the Netscript async context), and replies with `ws?.send(...)` (a browser API — safe from the
   loop). To keep latency low without flooding file I/O, drain the queue on a fast tick (~10 ms) and run
   the heavier mirrors/state-pushes only every Nth tick (~200 ms) — see the `DRAIN_SLEEP_MS`/`MIRROR_EVERY`
   split in the implemented loop.
5. **Reconnect** in the main loop: each tick, `if (!ws || ws.readyState === CLOSED) connectControl()`.
   Throttle attempts (e.g. only retry every ~1 s) to avoid hammering when the bridge is down.
6. **State push** in the main loop:
   - `screen`: every ~5th tick (~1 s), `readScreen()` → if non-empty/changed, `ws.send({t:'state',channel:'screen',ts,data:text})`.
   - `notifications`: drain `PORT_NOTIFY` (reuse existing `mirrorNotify` drain) → push as a `state`
     frame AND keep writing `status/notifications.txt` (RFA fallback observation).
   - `heartbeat`: peek `PORT_HEARTBEAT` → push.
   - `decisions`: drain `PORT_DECISION` → push (and keep appending to `status/decisions.json`).
   - Only send when `connected`; when disconnected, the existing file mirrors still run so RFA fallback works.
7. **KEEP the existing fallback machinery**: `mirrorPorts`, `mirrorNotify`, `mirrorScreen`,
   `processLauncherCommands` (PORT_LAUNCHER drain → terminal inject), and the `.cmd.json`/`.result.json`
   file relay loop. These are the RFA fallback; do not delete them.
8. **RAM:** unchanged ballpark (~6.7 GB). `WebSocket` via `eval` adds 0 GB (browser global, not `ns.*`,
   and the token is eval-hidden). Update the RAM comment block at the top of the file to note the
   control channel adds 0 GB. Confirm with `calculate_ram` in Phase 4.
9. **Update the file header docstring** to describe the new dual role (real-time control channel +
   RFA fallback relay).

**Verify:**
- `npx tsc --noEmit --incremental false` clean (watch is authoritative).
- Code review: command handlers are synchronous; reconnect logic can't spawn duplicate sockets;
  fallback mirrors still run when disconnected.
- In-game behavior validated in Phase 4.

---

### Phase 4 — Integration audit + in-game validation (MANAGER / Opus) — ✅ DONE (2026-06-29)

**Outcome:** all checks below pass. Static audit clean (field names match across all three files); both
typechecks clean; agent runs at **7.95 GB** (no Dom penalty); `write_port`→`{evicted:null}`; control.cmd
latency **~10 ms**; state reads **sub-ms**; single agent, reconnect + `atExit` verified. The one snag —
the agent dying at startup — was root-caused to **`ns` calls from WS callbacks** (see header + §5) and
fixed by the enqueue/drain-in-loop pattern; the fast-drain split (`DRAIN_SLEEP_MS=10`/`MIRROR_EVERY=20`)
brought command latency from 200 ms → 10 ms.

Sequence (as executed):
1. **Static audit:** read all three changed files against §2; confirm field names match exactly across
   bridge/MCP/agent (a single renamed field breaks the channel silently).
2. **Build:** `npx tsc --noEmit --incremental false` (src) and `pnpm --dir build/game-bridge-mcp exec tsc --noEmit` (MCP) both clean. Restart `pnpm run watch` so the bridge picks up the new `:12527` server. Reload the MCP server (session reload) so the new tools register.
3. **Bring up the agent in-game:** `run /cross/game_agent.js`. Confirm the bridge logs
   `[CONTROL] connected` and MCP `get_status` shows `controlConnected:true`.
4. **Reliability check (Problem 1):** MCP `write_port(1, "test")` → expect `{success:true, evicted:null}`.
   `read_port(1)` → expect `"test"`.
4b. **RAM-penalty check (Dom: 25 GB):** `calculate_ram /cross/game_agent.js` MUST stay ~6.7 GB. The
   `eval('WebSocket')` dodge hides the token from the static RAM parser so the 25 GB `Dom` penalty is
   never charged (same mechanism that keeps `launcher.js` at 2.9 GB). If the number jumped by ~25 GB,
   a literal `WebSocket`/`window`/`document` token leaked into the source — find it and route it through
   `eval(...)`. Catastrophic on a 16 GB home, so verify this BEFORE relying on the channel.
5. **Latency check (Problem 2):** MCP `terminal("ls")` → confirm `ls` output appears in `get_screen()`;
   measure wall-clock round-trip. Target: control path < ~150 ms (ideally single/low-double-digit ms);
   compare against the legacy file-relay path. Record the number in the Status ledger.
6. **Fallback check:** kill `game_agent.js`; confirm `get_status` shows `controlConnected:false`,
   `terminal(...)` falls back to the file relay (slower but works), `write_port` falls back. Restart
   the agent; confirm control resumes and reconnect fires without duplicate sockets.
7. **Double-spawn guard:** `terminal("run /cross/game_agent.js")` while it's running → expect an
   `ALREADY_RUNNING` receipt, no second instance.
8. If green: update HANDOFF + `plan-mcp-reliability.md` status; mark Problems 1 & 2 resolved.

---

### Phase 5 — Player-module RAM lean-up (DEFERRED — separate from the MCP channel)

This is Problem 3 from `plan-mcp-reliability.md`. It does **not** block the MCP channel; sequence it
after Phase 4. Summary (full detail in `plan-mcp-reliability.md` §Problem 3):
- Run `calculate_ram` on every `src/player/*.js` to get real numbers.
- `contract_solver` reports 22 GB; it should only need `ns.codingcontract.*` (cheap) + BFS + pure-JS
  solvers. Audit imports; cut anything pulling in `ns_dodge`/formulas/the compute stack.
- Add a RAM gate in the control agent's `run`/`terminal` handler: before launching a player module,
  check `ns.getServerMaxRam('home') - ns.getServerUsedRam('home') >= ns.getScriptRam(script)`; if not,
  return `ok:false, error:"NOT_ENOUGH_RAM"` (or push a `NOT_ENOUGH_RAM` notification) instead of a
  silent failure.

---

## 4. Build & run reference (for the build agents)

- **Src typecheck (authoritative):** `npx tsc --noEmit --incremental false` (the watch `tsc -w` is the
  source of truth; a plain incremental `tsc` can pass on stale cache — see HANDOFF §3).
- **MCP package typecheck:** `pnpm --dir build/game-bridge-mcp exec tsc --noEmit`.
- **Run the bridge:** `pnpm run watch` (daemon: file sync + all three WS servers).
- **MCP server:** launched by Claude Code via `.mcp.json` (`tsx build/game-bridge-mcp/src/index.ts`);
  changes require a session reload to re-register tools.
- **Game:** web build at `http://localhost:8000`; in-game daemon launched with `run /cross/game_agent.js`.

## 5. Gotchas (carried from HANDOFF + this design)

- **`tsc -w` is the authoritative typecheck**, not one-shot incremental `tsc`.
- **`ns.flags(...)`** needs `as unknown as {...}`.
- **DOM/WebSocket access** must go through the `eval('document')`/`eval('WebSocket')` dodge so the
  static RAM analyzer never charges the 25 GB `Dom` penalty. The penalty is triggered by the *static
  source parser* finding a `window`/`document`/`WebSocket` token — NOT by runtime DOM touches — so
  `eval` hiding the literal token defeats it entirely (confirmed: `launcher.js` touches the DOM every
  tick yet costs 2.9 GB). Any literal token leaking into source re-arms the 25 GB charge; verify with
  `calculate_ram` (Phase 4 step 4b). DOM is UI-interfacing only (capability boundary, design/04 §1) —
  terminal inject + rendered-text read, never engine internals.
- **No mixed-content block:** game page is `http://localhost:8000`, so `ws://localhost:12527` is allowed.
- **WS callbacks run outside the Netscript async context — they MUST NOT call `ns.*` at all.** (This was
  the startup-crash root cause; the original "keep handlers synchronous" advice was insufficient.) An `ns`
  call from `onopen`/`onmessage`/`onclose`/`onerror` throws *uncaught* and the engine kills the script,
  bypassing any enclosing try/catch. **Pattern:** callbacks only mutate plain JS state and push to an
  in-memory queue (`inbound`); the **main loop** drains the queue, runs `handleControlCmd` (all `ns` work,
  safe here), and replies via `ws.send` (a browser API, not `ns` — fine from the loop). `ws.send` and
  `JSON.parse` in callbacks are OK; anything on `ns` is not.
- **Ports reset on game reload** — the control channel does not rely on port persistence.
- **Field-name drift across the three files is the #1 integration risk** — implement §2 verbatim.

---

## 6. Status ledger

| Phase | Component | Status | Notes |
|-------|-----------|--------|-------|
| 0 | `game_agent.ts` writePort fix | ✅ done | folded into Phase 3 |
| 1 | `game-bridge.ts` control server + routing | ✅ done | `:12527` + state buffer + `control.*` routing |
| 2 | `index.ts` MCP control tools + fallback | ✅ done | `terminal`/`get_screen`/`write_port`/`read_port` etc. |
| 3 | `game_agent.ts` control agent + state push | ✅ done | enqueue-in-callback / drain-in-loop; ~10 ms |
| 4 | integration audit + in-game validation | ✅ done | Problems 1 & 2 resolved; see results at top |
| 5 | player-module RAM lean-up | deferred | not blocking; Problem 3 in `plan-mcp-reliability.md` |

**Build history:** Phases 1, 2, 3 were built in parallel by three Sonnet agents (disjoint files, shared
frozen §2 protocol), Phase 0 folded into Phase 3, manager ran Phase 4. The only post-build fix was the
ns-from-callback root cause (§5) + the fast-drain latency split — both in `game_agent.ts`.
