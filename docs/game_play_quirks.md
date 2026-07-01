# Gameplay Quirks & Patterns

> Gotchas, undocumented behaviors, and repeatable patterns learned from testing.
> This is procedural knowledge — things you only learn by playing.

---

## Development Environment

### Repo location (Ubuntu)
The scripts repo lives at `/home/shane/workspace/bitburner_scripts`. Build with `npm run watch`
(TypeScript watch + bridge) or `npm run build` (one-shot). Compiled output lands in `dist/` and is
auto-pushed to the game via the WebSocket bridge.

---

## Terminal Quirks

### No command chaining
The in-game terminal does NOT support `;` or `&&` chaining like bash/PowerShell. Each command must be entered separately.
```
# WRONG:
connect n00dles; run foo.js; connect home

# RIGHT (3 separate entries):
connect n00dles
run foo.js
connect home
```

### scp: destination is last argument, no chaining
`scp <file> <destination>` — only two arguments. No source specification (always copies from current server).
```
# Copy a file to n00dles:
scp workers/simple_hack_loop.js n00dles

# Then connect and run:
connect n00dles
run workers/simple_hack_loop.js
```

### Scripts pushed via bridge get prefix stripped
Files synced from `dist/` to the game via the bridge appear at their relative path from `dist/`. E.g., `dist/cross/game_agent.js` → `/cross/game_agent.js` on the game server. The `dist/` prefix is stripped.

### `run` vs `scp` + `run`
- `run <script>` — runs a script ON the current server. Script must already exist there.
- `scp <script> <dest>` — copies from current server to dest. Then you must `connect <dest>` and `run` there.
- `exec <script> <host>` — runs a script ON a remote server from your current server (costs 1.3 GB RAM for `ns.exec`).

### `scp` preserves directory structure
`scp workers/simple_hack_loop.js n00dles` copies the file INTO `workers/` on the target. It does NOT flatten to root. So the full path on the target is `workers/simple_hack_loop.js`.
```
# Right:
scp workers/simple_hack_loop.js n00dles
connect n00dles
run workers/simple_hack_loop.js n00dles    ← note: workers/ prefix + target arg

# Wrong:
scp workers/simple_hack_loop.js n00dles
connect n00dles
run simple_hack_loop.js                   ← file not at root, it's in workers/
```

### `run` requires all script arguments
If a script expects `ns.args[0]`, you MUST pass it on the command line:
```
run workers/simple_hack_loop.js n00dles    ← target passed as args[0]
```
Forgetting the argument produces a silent error (script starts, sees no args, prints error, exits).

---

## RAM Management

### Home is tight at 8 GB
The `cross/game_agent.js` daemon uses a significant chunk of 8 GB home. Any additional script must either:
- Run on a different server (n00dles at 4 GB is the first option)
- Be a temp script that game_agent launches (still needs to fit in remaining free RAM)

### First bootstrap: manual NUKE + run on n00dles
On a fresh 8 GB home, some scripts won't fit alongside game_agent. The bootstrap path:
1. Build and connect bridge: `npm run watch` → connect Remote API (port 12525) in Bitburner
2. Run `cross/game_agent.js` on home (bridge auto-pushes it)
3. Manually NUKE n00dles from terminal: `connect n00dles` → `run NUKE.exe` → `connect home`
4. scp simple_hack_loop to n00dles: `scp workers/simple_hack_loop.js n00dles`
5. Connect and run: `connect n00dles` → `run workers/simple_hack_loop.js`

### RAM upgrade unlocks the system
- 8 GB home → game_agent only (no coordinator, no hwgw_batcher)
- 16 GB home → game_agent + coordinator fit
- Threshold: ~$256,000 for home RAM upgrade

---

## MCP / Bridge

**Scope reminder (2026-07-01):** all of this is dev/debug tooling — pushing code, reading state,
debugging the running game from outside it. It is never a runtime dependency of `brain.ts`
(the actual autonomous gameplay entry point). See `docs/mcp-control-channel-usage.md` §0.

### Two paths: fast control channel, slow file-relay fallback (updated 2026-07-01)
This section used to describe ONLY the file-relay path as if it were the sole mechanism — that
was true before the WebSocket control channel was built (`docs/plan-mcp-realtime-control.md`).
Current reality: `terminal`/`read_port`/`write_port` MCP tools prefer the **control channel**
(`cross/game_agent.ts` dials out to the bridge's `:12527` control socket, ~10ms round-trip) and
transparently fall back to the **file-relay** (`/status/.cmd.json` → `game_agent.ts` polls and
executes → `/status/.result.json`, ~hundreds of ms) only when the control channel is down. See
`docs/mcp-control-channel-usage.md` for the full picture — that doc is the canonical, current
reference for this whole subsystem.

### Ports fill up (50 entry limit)
Game ports hold max 50 entries. If no consumer drains a port, writes fail with "Port full" —
**except** `ns.writePort` itself, which (contrary to what this doc used to imply) does NOT report
failure for a successful write; a full port returns the evicted element, not an error (see
`mcp-control-channel-usage.md` §5 — this was chased down as a "v3 semantics misread," not a real
bug). Still: always have a consumer (boot_agent for port 1/2, game_agent mirrorPorts for port 3/4)
so a queue doesn't silently evict data nobody read.

### Bridge auto-syncs on connect + file watcher
The bridge watches `dist/` directory and auto-pushes changed files. It also does a comparison sync on initial connect. No manual sync needed.

### `build/watch.js`: syncStatic() must never own `.js` orphan cleanup (2026-07-01)
`syncStatic()` mirrors `src/` → `dist/` via the `sync-directory` npm package with
`deleteOrphaned: true`. That package's own internal orphan check is a **naive same-relative-path,
same-extension match** between `srcDir` and `targetDir` — it has no concept of TypeScript
compilation. Since every real source file is `.ts`/`.tsx` and every compiled file is `.js`
(different extension, never a literal filename match), `sync-directory` sees **every** compiled
`.js` file in `dist/` as orphaned and deletes it on every watcher startup — only sheer timing
luck (whichever files `tsc` hadn't re-emitted yet at that exact moment) ever spared any of them.
This is what silently wiped `dist/cross/game_agent.js` to an empty file while `brain.ts` was live
in-game, surfacing as a `"Script content is an empty string"` runtime crash with no code change
behind it. Fix: `syncStatic()`'s `exclude` callback must unconditionally exclude `.js` regardless
of `allowedFiletypes` — `.js` orphan cleanup is owned entirely by `initTypeScript()`/
`watchTypeScript()` in `build/watch.js`, which correctly check for a same-named `.ts`/`.tsx`
sibling before deleting. If you ever touch `build/watch.js`'s `exclude` logic, keep `.js` in
`syncStatic()`'s blind spot.

---

## DOM/UI Automation Quirks (`player/ui_actions.ts`, `lib/dom.ts`)

### Tech vendors and universities are city-locked
Each TechVendor/University location belongs to exactly one city (Alpha Enterprises/Rothman
University = Sector-12, ECorp/NetLink Technologies/Summit University = Aevum, Omega Software =
Ishima, CompuTek/OmniTek/ZB Institute = Volhaven). The player starts in Sector-12 and there is no
travel automation yet, so only Sector-12 locations are ever reachable. Iterating a flat candidate
list without filtering by `ns.getPlayer().city` first produces endless "location not found" spam
for the unreachable-city entries — filter by city before attempting to click.

### Studying is not idempotent — re-invoking always restarts the class
Clicking "Study Computer Science" (or any class) always starts a brand-new `ClassWork`, which
calls `.finish(true)` on whatever class is already running (`Player.startWork()` in the game's
`PlayerObjectWorkMethods.ts`). Non-Singularity (DOM-clicked) class work always has
`singularity: false`, so `ClassWork.finish()` always pops a summary dialog. A polling loop that
unconditionally re-clicks "take course" every tick will restart-and-dialog on every tick, wiping
progress each time. Track "already started studying" with a process-local flag instead of a
DOM-presence re-check — see the next entry for why the DOM check alone isn't reliable here.

### Any navigation away from the Work page drops focus (but not the work itself)
`GameRoot.tsx` auto-calls `Player.stopFocusing()` whenever the active page changes away from
`Page.Work` — this loses the focus XP/speed bonus but does **not** cancel `currentWork`. Since
`lib/dom.ts::visitLoc()` always navigates to the City page first (for any tech-vendor/university
action), any purchase-check loop that runs before/alongside a study loop will silently unfocus the
class every cycle. Fix: after any away-navigation, click the game's own always-present "Focus"
button (rendered by `CharacterOverview.tsx`'s `WorkInProgressOverview` on any page while unfocused
work is active — safe to click repeatedly, never touches `currentWork`) to reclaim it.

---

## Phase Detection & Coordinator

### phase_detector publishes phase; coordinator acts on it
`cross/phase_detector.js` classifies game stage (BOOTSTRAP → EARLY → MID → LATE → RESET) and
publishes it to port 8 (`PORT_PHASE`). `compute/coordinator.js` reads the phase each tick and
switches strategy: BOOTSTRAP/EARLY → thin-worker `workers/simple_hack_loop.js`; MID/LATE →
`compute/hwgw_batcher.js`.

There is no longer a monolithic `strategy_agent`. The old strategy_agent's phase logic lives in
`cross/phase_detector.ts`; its execution logic lives in `compute/coordinator.ts`.

### Phase hysteresis (5 ticks)
Phase transitions require 5 consecutive ticks of a new phase candidate before committing. This prevents oscillation between phases when conditions are borderline. Tunable in `lib/config.ts`.

### Purchase intent vs purchase
The aug planner (`player/aug_planner.js`) publishes affordable aug counts to `PORT_AUGS`; `phase_detector` reads this and triggers the RESET phase recommendation. Scripts do NOT auto-buy port-opener programs — the player must manually buy those from the darkweb (requires TOR router, $200k); `ns.singularity.purchaseProgram()`'s 16× SF4-less RAM cost is wrapped in the RAM-dodge (`lib/ns_dodge.ts`) for future use.

**Augmentations are different (2026-07-01):** `aug_planner.js --install` closes the full loop —
buy every affordable aug, then call `ns.singularity.installAugmentations(brain.js)` so the
soft-reset resumes the autonomous loop unattended (no manual `run /brain.js` after reset).
Gated behind two settings that both default `false` (`autoBuyAugs` + `autoReset`,
`lib/settings.ts` — each documents itself as "irreversible"/"point of no return"): with both
off (the default), a pending aug/reset lands in the decisions queue for Approve/Deny/Defer
instead. Install is skipped if any purchase in the batch fails partway (cascade prices may
have drifted) — see `player/aug_planner.ts::purchasePlan`'s return value.

---

## Server Patterns

### n00dles: the universal bootstrap
- 4 GB RAM, 0 ports required, hacking level 1
- Always the first target in every BitNode
- `workers/simple_hack_loop.js` at ~2.0 GB fits with 2 GB to spare
