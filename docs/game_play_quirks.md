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

### Port tools go through game_agent's file relay
`read_port` and `write_port` MCP tools write to `/status/.cmd.json`. `cross/game_agent.js` polls this file, executes the port operation, and writes to `/status/.result.json`. If game_agent isn't running, port tools silently timeout after 5s.

### Ports fill up (50 entry limit)
Game ports hold max 50 entries. If no consumer drains a port, writes fail with "Port full." Always have a consumer (boot_agent for port 1/2, game_agent mirrorPorts for port 3/4).

### Bridge auto-syncs on connect + file watcher
The bridge watches `dist/` directory and auto-pushes changed files. It also does a comparison sync on initial connect. No manual sync needed.

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
The aug planner (`player/aug_planner.js`) publishes affordable aug counts to `PORT_AUGS`; `phase_detector` reads this and triggers the RESET phase recommendation. Scripts do NOT auto-buy programs or augmentations. The player must manually buy port openers from the darkweb (requires TOR router, $200k). Auto-buy via `ns.singularity.purchaseProgram()` costs 16× RAM under SF4 and is wrapped in the RAM-dodge (`lib/ns_dodge.ts`) for future use.

---

## Server Patterns

### n00dles: the universal bootstrap
- 4 GB RAM, 0 ports required, hacking level 1
- Always the first target in every BitNode
- `workers/simple_hack_loop.js` at ~2.0 GB fits with 2 GB to spare
