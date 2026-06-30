# Tests (design/11 §3.8)

Dependency-free node tests for the pure/status-file logic. No framework — each
`*.test.mjs` runs assertions and prints a summary, exiting non-zero on failure.

## Run
```sh
npx tsc                              # compile src → dist first
node test/subsystem_state.test.mjs   # run one
for t in test/*.test.mjs; do node "$t" || exit 1; done   # run all
```

## Pattern
- Import the **compiled** module from `../dist/...` (only modules whose runtime
  imports are type-only or self-contained are directly node-importable; the game
  loader resolves extensionless imports, node does not).
- Use `test/_mock_ns.mjs` (`mockNs()`, `assert`, `eq`) for an in-memory ns with
  `read`/`write`/`fileExists`.
- Keep tests on **pure logic** (status round-trips, parsers, planners) — not on
  live `ns.*` game calls.

Wave-1 Agent K adds per-module tests here following `subsystem_state.test.mjs`.
