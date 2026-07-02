# bitburner-src

The game engine. Lives at `../bitburner-src` (sibling to this project).

## Package manager

pnpm works but needs two things the npm lockfile doesn't surface:

- `react-draggable` pinned to `"4.5.0"` (not `^4.5.0`). pnpm resolves newer versions whose types break the build.
- `@types/react` pinned to `"17.0.89"` (not `^17.0.89`). Same story — newer minor bumps introduce type errors.

These are already pinned in `package.json`. If you regenerate the lockfile, don't let them drift.

The `allowScripts` field sets `@swc/core: false` and `core-js-pure: false`, but pnpm v11+ corepack treats `ERR_PNPM_IGNORED_BUILDS` as fatal during the pre-run integrity check. Run `pnpm approve-builds @swc/core core-js-pure` once or `pnpm run` won't work.

## Build

- `pnpm run build` — production webpack → `dist/`, then assembles `.app/` dir
- `pnpm run start:dev` — webpack-dev-server at **localhost:8000**
- `pnpm run start` — Electron with `.app/` (has `--ozone-platform=x11` — needed on Wayland or Electron SIGSEGVs)
- `pnpm run test` — Jest

The build script (`tools/build.sh`) calls bare `webpack` — works because pnpm runs scripts with `node_modules/.bin` in PATH.

## Relationship to this project

This is the engine your scripts run inside. You `.connect()` from your scripts to the game via the game bridge (`watch:remote` in this project). Two completely separate projects — not a monorepo.
