# Bitburner Scripts

TypeScript automation for [Bitburner](https://bitburner.readthedocs.io/), compiled to `dist/` and
synced into the running game via a custom bridge.

## Start here

- **`docs/design/00-architecture-philosophy.md`** — the two-thread model (Compute vs Player) and
  the capability boundary (act as a human, through human surfaces — never inspect/alter engine
  internals). Read this first; everything else builds on it.
- **`docs/design/14-roadmap-to-full-autoplay.md`** — the current state and the actionable gap list.
  Start here for "what works, what doesn't, what's next."
- **`docs/mcp-control-channel-usage.md`** — how an AI coding agent (or a human) drives the running
  game from outside it for development/debugging. **This tooling is dev/debug-only** — it is never
  a runtime dependency of actually playing the game.

## Playing the game

`run /brain.js` is the only thing you type, on a fresh game or after a reset. It's the single
entry point — it decides what to run, launches the rest of the daemon stack dynamically within a
shared RAM budget, and mimics human UI actions (buying TOR, programs, RAM upgrades, courses)
before SF4 is available. See `docs/design/14` §1a for how this is put together.

Note: `run /brain.js` and MCP dev-tooling access (`run /cross/game_agent.js`) are two independent
entry points with two independent prerequisites — neither needs the other running. See
`docs/mcp-control-channel-usage.md` §3.

## Development setup

Package manager is **pnpm**, not npm.

```bash
pnpm install
pnpm run watch          # tsc -w + dist→game sync + the dev bridge, all at once
```

`pnpm run bridge` runs just the bridge (`build/game-bridge.ts`) standalone — the process that
exposes the RFA/control-channel/admin WebSocket servers the MCP tools and `cross/game_agent.ts`
talk over. See `docs/mcp-control-channel-usage.md` for the full protocol.

## Repository layout

- `src/lib/` — foundation libraries (config, ports, DOM helpers, RAM budget, safe-launch).
- `src/compute/` — the parallel compute-thread stack (RAM manager, allocator, scheduler, HWGW
  batcher, target selector, coordinator).
- `src/player/` — Thread-P subsystem managers (factions, augs, gang, bladeburner, sleeve, ...).
- `src/cross/` — cross-cutting daemons (phase detection, the MCP bridge agents, notifications).
- `src/workers/` — thin HGW compute scripts.
- `src/ui/` — the in-game control console (React, built via `lib/react.ts`'s stealth-DOM shim).
- `docs/design/` — the numbered design-doc spine (00 is the philosophy; read in order for history,
  or jump to 14 for current state).

## License

MIT.
