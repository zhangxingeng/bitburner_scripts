# Plan: MCP Reliability & Performance Fix

> **This doc is now the PROBLEM ANALYSIS / root-cause record.** The executable BUILD PLAN that fixed
> Problems 1 & 2 lives in **`plan-mcp-realtime-control.md`** (ratified 2026-06-29: in-game WebSocket
> control channel + RFA fallback). To *use* the channel, see **`mcp-control-channel-usage.md`**.
>
> ## ✅ STATUS (2026-06-29): Problems 1 & 2 RESOLVED, validated in-game.
> - **Problem 1 (`write_port` "Port full"):** fixed — clean write reports `{evicted:null}`, read-back correct.
> - **Problem 2 (latency):** fixed — the in-game WebSocket control channel replaced the file relay;
>   `control.cmd` round-trips at **~10 ms** (was ~400–600 ms), state reads sub-ms.
> - **Problem 3 (player-module RAM):** still **DEFERRED** — see below. Not blocking.
> - **Problem 4 (double-spawn guard):** already correct — no action.
>
> The per-problem sections below are kept as the historical analysis. New feature work is **unblocked**.

---

## Problem 1 — `write_port` always reports failure ("Port full")

**Observed:** Every MCP `write_port` call returns `{"success":false,"error":"Port full"}`.
The write actually lands (commands do execute), but from the MCP client's perspective every
call looks like a failure. This is unreliable — the agent cannot distinguish a real failure
from a success.

**Root cause:** Bitburner v3 changed `ns.writePort` semantics. Old behavior: returns `true`
on success, `false` if port full (write fails). New behavior: write **always succeeds** —
returns `null` if nothing was evicted, or the evicted element if the port was full. The bridge
or game_agent's `writePort` handler interprets any non-null return as "Port full" (treating
it as the old `false`), but in v3 non-null just means "something was evicted" — the write
still landed.

**Where to fix:** The bridge code at `build/game-bridge-mcp/` (whichever file handles the
`write_port` MCP tool) or the `writePort` case in `src/cross/game_agent.ts`
`executeCommand()`. Find where `written !== null` is used to signal failure and flip it —
`null` or non-null both mean success in v3; real failure throws an exception.

In `game_agent.ts` `executeCommand` `writePort` case:
```ts
// CURRENT (wrong for v3):
result.success = written !== null;
if (!result.success) result.error = 'Port full';

// FIX (v3-correct):
result.success = true;   // writePort always succeeds in v3; non-null = evicted element
result.data    = written; // null = no eviction; non-null = what was evicted
```

Also check the bridge's own `write_port` handler — it may have a separate copy of this logic.

**Validation:** `write_port(12, "ls")` should return `{"success":true}`. Confirm `ls`
appears in screen.txt within ~200ms.

---

## Problem 2 — MCP is slow

**Observed:** MCP operations feel sluggish. Exact latency not measured, but noticeably slow
for what should be near-real-time in-game I/O.

**Likely causes (investigate in this order):**

1. **File relay roundtrip:** `write_port` / `read_port` go through `.cmd.json` → game_agent
   poll (200ms max) → `.result.json`. Worst case = 200ms just for game_agent to see the
   command, plus file-read overhead. That's fine for one call, but chains of calls add up.

2. **Bridge overhead:** the bridge at `build/game-bridge-mcp/` may have per-request overhead
   (reconnect logic, JSON serialization, etc.). Profile it.

3. **Port operations vs file relay:** `write_port` going through the file relay adds an extra
   round-trip vs a direct `ns.writePort` call. The bridge may have a direct WebSocket path
   for port ops that bypasses the relay — check if that's being used.

**Action:**
- Read `build/game-bridge-mcp/` source and trace the `write_port` call path end-to-end.
- Measure: timestamp before and after a `write_port` call, and timestamp when the notification
  appears in `notifications.txt`. The gap is the true latency budget.
- If the relay is the bottleneck: reduce game_agent loop from 200ms → 50ms for the command
  section (keep screen mirror throttled); or have game_agent poll the port more frequently.

---

## Problem 3 — Player modules too heavy for early game

**Observed:** `run /player/contract_solver.js` requires **22 GB RAM** — cannot run on 16 GB
home with bootstrap (4.8 GB) + game_agent (6.65 GB) running (only ~4.5 GB free).

**Scope:** Audit ALL player modules for RAM cost. The current imports likely drag in heavy
libs. Expected: any module importing `ns_dodge`, formulas, or the full compute stack will be
heavy.

**Fix options (in order of preference):**
1. **Lean up the modules** — audit imports; remove anything not used; split heavy one-time
   setup from lightweight runtime. `contract_solver` in particular should be able to run
   lean: it needs `ns.codingcontract.*` (cheap), BFS scan (cheap), and solve logic (pure JS,
   no ns.*). Remove any ns_dodge or heavy imports.
2. **RAM gate in game_agent** — before injecting a `run /player/<module>.js` command, check
   `ns.getServerFreeRam('home') >= ns.getScriptRam(script)`. If not enough RAM, push a
   `NOT_ENOUGH_RAM` receipt to PORT_NOTIFY instead of injecting. Agent can read this and retry
   later or surface it to the user.
3. **Document RAM requirements** — at minimum, list each player module's RAM cost so the
   agent knows when it can and cannot trigger them.

**Immediate audit:** run `calculate_ram /player/contract_solver.js` and every other player/
module in-game to get real numbers. Then identify which imports to cut.

---

## Problem 4 — double-spawn guard gap (minor)

**Observed:** The double-spawn guard in `processLauncherCommands` correctly blocked
`run /cross/game_agent.js` (ALREADY_RUNNING receipt confirmed). However, it let
`run /bootstrap.js` through even though bootstrap may have been running — this turned out
to be because bootstrap wasn't actually running at that point (only game_agent had been
started this session), so it was correct behavior. The guard itself is sound.

**Caveat to document:** The guard only protects against same-session double-spawn of
scripts running on `home`. It does not protect against scripts running on other hosts. For
player modules (all on home), this is fine.

---

## Fix order for next agent

1. ~~**Fix Problem 1**~~ ✅ DONE — `writePort` v3 semantics corrected; control path returns `{evicted}`.
2. ~~**Investigate Problem 2**~~ ✅ DONE — replaced the file relay with the in-game WebSocket control
   channel (`plan-mcp-realtime-control.md`); ~10 ms round-trips, sub-ms state reads.
3. **Fix Problem 3** (player module RAM) — STILL OPEN. Audit imports for each `player/` module, cut heavy
   deps, re-validate RAM numbers in-game. This is the next reliability task (Phase 5 in the build plan).
4. Problem 4 is already handled correctly — no action needed.

**Problems 1 & 2 are resolved and validated in-game (2026-06-29). Feature work is unblocked. Problem 3
(player-module RAM) remains the open follow-up.**
