# Gameplay Quirks & Patterns

> Gotchas, undocumented behaviors, and repeatable patterns learned from testing.
> This is procedural knowledge — things you only learn by playing.

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
scp deploy/simple_hack_loop.js n00dles

# Then connect and run:
connect n00dles
run simple_hack_loop.js
```

### Scripts pushed via bridge get prefix stripped
Files synced from `dist/` to the game via the bridge appear at their relative path from `dist/`. E.g., `dist/monitor/game_agent.js` → `/monitor/game_agent.js` on the game server. The `dist/` prefix is stripped.

### `run` vs `scp` + `run`
- `run <script>` — runs a script ON the current server. Script must already exist there.
- `scp <script> <dest>` — copies from current server to dest. Then you must `connect <dest>` and `run` there.
- `exec <script> <host>` — runs a script ON a remote server from your current server (costs 1.3 GB RAM for `ns.exec`).

### `scp` preserves directory structure
`scp deploy/simple_hack_loop.js n00dles` copies the file INTO `deploy/` on the target. It does NOT flatten to root. So the full path on the target is `deploy/simple_hack_loop.js`.
```
# Right:
scp deploy/simple_hack_loop.js n00dles
connect n00dles
run deploy/simple_hack_loop.js n00dles    ← note: deploy/ prefix + target arg

# Wrong:
scp deploy/simple_hack_loop.js n00dles
connect n00dles
run simple_hack_loop.js                   ← file not at root, it's in deploy/
```

### `run` requires all script arguments
If a script expects `ns.args[0]`, you MUST pass it on the command line:
```
run deploy/simple_hack_loop.js n00dles    ← target passed as args[0]
```
Forgetting the argument produces a silent error (script starts, sees no args, prints error, exits).

---

## RAM Management

### Home is tight at 8 GB
The `game_agent` daemon uses ~6.55 GB of 8 GB on home. Only ~1.45 GB free. Any additional script must either:
- Run on a different server (n00dles at 4 GB is the first option)
- Be a temp script that game_agent launches (still needs to fit in remaining free RAM)

### First bootstrap: manual NUKE + run on n00dles
Since game_agent leaves only 1.45 GB free on home, the `scan_nuke` script (2.6 GB) won't fit. The bootstrap path:
1. Start game_agent on home
2. Manually NUKE n00dles from terminal: `connect n00dles` → `run NUKE.exe` → `connect home`
3. scp simple_hack_loop to n00dles: `scp deploy/simple_hack_loop.js n00dles`
4. Connect and run: `connect n00dles` → `run simple_hack_loop.js`

### RAM upgrade unlocks the system
- 8 GB home → game_agent only (no reporter, no batch_hack)
- 16 GB home → game_agent + reporter + batch_hack all fit
- Threshold: ~$256,000 for home RAM upgrade

---

## MCP / Bridge

### Port tools go through game_agent's file relay
`read_port` and `write_port` MCP tools write to `/status/.cmd.json`. game_agent polls this file, executes the port operation, and writes to `/status/.result.json`. If game_agent isn't running, port tools silently timeout after 5s.

### Ports fill up (50 entry limit)
Game ports hold max 50 entries. If no consumer drains a port, writes fail with "Port full." Always have a consumer (boot_agent for port 1/2, game_agent mirrorPorts for port 3/4).

### Bridge auto-syncs on connect + file watcher
The bridge watches `dist/` directory and auto-pushes changed files. It also does a comparison sync on initial connect. No manual sync needed.

---

## Strategy Agent

### Purchase intent vs purchase
The strategy agent logs `BUY_INTENT` actions — it does NOT auto-buy programs. The player must manually buy port openers from the darkweb (requires TOR router, $200k). This is because `ns.singularity.purchaseProgram()` costs ~15+ GB RAM and requires SF-4.

### Phase hysteresis (5 ticks)
Phase transitions require 5 consecutive ticks of a new phase candidate before committing. This prevents oscillation between phases when conditions are borderline.

---

## Server Patterns

### n00dles: the universal bootstrap
- 4 GB RAM, 0 ports required, hacking level 1
- Always the first target in every BitNode
- simple_hack_loop at 2.0 GB fits with 2 GB to spare
