# RAM Evasion Rules — the canonical reference

> Consolidates a set of rules that were previously copy-pasted near-verbatim across
> `lib/dom.ts`, `player/ui_actions.ts`, and the now-deleted `lib/dom_click.ts`. This
> is the one place to update them; in-code comments should link here rather than
> restate the tables.
>
> Ground truth: `../bitburner-src/src/Netscript/RamCostGenerator.ts` (this repo's
> checked-out copy of the game source — see the "Game Source Checkout" memory note).
> When in doubt, grep that file rather than trusting a cached number here.

---

## 1. The keyword penalty — 25 GB per literal `document`/`window`/`WebSocket` token

Bitburner's **static** RAM analyzer scans a script's *source text* for certain literal
tokens and charges a flat penalty if it finds them — independent of whether the code
path that uses them ever runs. `RamCostConstants.Dom = 25` (GB), applied once per
script if the literal string `document` or `window` appears anywhere in it (including
in comments, historically — always verify with `calculate_ram`, don't assume a comment
is safe).

**Fix: split the literal so the token never appears contiguously in source**, then
reassemble it at runtime via `eval`:

```ts
const doc = eval('docu' + 'ment') as Document;
const win = eval('win' + 'dow') as Window & typeof globalThis;
```

The static parser sees two separate string literals (`'docu'`, `'ment'`) and never
reconstructs them — the concatenation only happens at runtime, invisible to source
scanning. Same trick for `WebSocket` (used by `cross/game_agent.ts`'s control-channel
client — see that file for the split form).

**Where this is used in-repo:** `lib/dom.ts` (`doc()`/`win()` helpers), `cross/launcher.ts`
(`runTerminalCommand`/`readScreen`), `lib/react.ts` (`domDocument`/`domWindow`),
`player/ui_actions.ts` (`makeProgram`'s inline DOM read), `stock/main.ts`
(`initializeHud`), `cross/game_agent.ts` (the `WebSocket` client construction).

**DO NOT "fix" the split back to a normal literal.** That silently adds 25 GB (or 50 GB
if both `document` and `window` are un-split) to the script's cost — a regression that
`calculate_ram` will catch, but only if someone thinks to check.

**Gotcha — substring false positives:** the analyzer's keyword match is naive; a
filename like `ui_actions.js` contains the substring `ns.js`, which the analyzer's
`ns.<word>` scan can mis-flag as a reference to some `ns.js` API. Split filenames the
same way when this happens: `'ui_actions' + '.js'`.

---

## 2. The function-name-collision penalty — up to 16× a Singularity function's cost

The analyzer resolves **every top-level function name in a script** against the full
`ns.*` API tree, not just calls written as `ns.foo()`. If a user-defined function shares
a name with an `ns.*` API — including `ns.singularity.*` — the analyzer charges that
API's RAM cost to the script, as if it had been called, whether or not the function is
ever invoked or even related to Singularity.

**Without SF4, Singularity function costs are multiplied ×16** (`SF4Cost()` in
`RamCostGenerator.ts`, applied whenever `sourceFileLvl(4) < 1`). This is what turns an
innocuous local helper into a script that suddenly costs 40–80 GB:

| Local function name | Collides with | Cost without SF4 |
|---|---|---|
| `goToLocation` | `ns.singularity.goToLocation` | 5 × 16 = 80 GB |
| `upgradeHomeRam` | `ns.singularity.upgradeHomeRam` | 3 × 16 = 48 GB |
| `upgradeHomeCores` | `ns.singularity.upgradeHomeCores` | 3 × 16 = 48 GB |
| `createProgram` | `ns.singularity.createProgram` | 5 × 16 = 80 GB |
| `installBackdoor` | `ns.singularity.installBackdoor` | ~3 × 16 ≈ 48 GB |

**Fix: rename the local function to anything that doesn't collide.** The renamed
versions actually in use in this repo (all 0 GB static cost from the collision):
`visitLoc` (not `goToLocation`), `buyHomeRam` (not `upgradeHomeRam`), `buyHomeCores`
(not `upgradeHomeCores`), `makeProgram` (not `createProgram`), `runBackdoorInstall`
(not `installBackdoor`, `player/program_acquirer.ts`).

**Before naming any new local function, grep `RamCostGenerator.ts` for the name** —
don't rely on this table being exhaustive.

---

## 3. Related but distinct — the RAM-dodge primitive (`lib/ns_dodge.ts`)

The two rules above are about *avoiding an accidental penalty in a script that
shouldn't pay one*. A related but separate concern: a script that **legitimately
needs** to call a Singularity function (e.g. checking `getOwnedSourceFiles()` to
detect whether SF4 exists at all — the classic bootstrapping problem, since that
very check is itself `SF4Cost`-gated) uses `lib/ns_dodge.ts::executeCommand` to run
the call inside a disposable temp script, so the 16× cost is paid by the throwaway
script, not the long-running daemon. See `cross/player_sequencer.ts::checkSf4` and
`brain.ts::checkSf4` for the pattern.

This is NOT a substitute for renaming a colliding function — the collision penalty is
charged for the *name* existing in source regardless of whether the function's body
calls anything real; `executeCommand` only helps when the script has a genuine,
intentional Singularity call to make.

---

## 4. Verified RAM costs for common functions (spot-checked against game source)

Useful when reasoning about a new script's budget without a live `calculate_ram` call:

| Function | Cost (GB) |
|---|---|
| `ns.run` | 1.0 |
| `ns.exec` | 1.3 |
| `ns.scp` | 0.6 |
| `ns.serverExists` | 0.1 |
| `ns.fileExists` | 0.1 |
| `ns.getScriptRam` | 0.1 |
| `ns.getServerMaxRam` | 0.05 |
| `ns.getServerUsedRam` | 0.05 |
| `ns.hasTorRouter` | 0.05 (not Singularity-gated — safe to call directly) |
| `ns.singularity.getOwnedSourceFiles` | `SF4Cost(SingularityFn3)` — 16× without SF4 |

These add up per **imported file**, not per call site — importing a module that
references a function anywhere in its own body pulls that cost into every importer's
static total, even if the importer only uses one unrelated export from that module.
This is why some worker scripts (e.g. `workers/early_prepper.ts`) deliberately avoid
importing shared utility modules at all, accepting a little code duplication (a
~12-line BFS scan, also present in `cross/phase_detector.ts` before it was
consolidated onto `lib/servers.ts::findAllServers`) in exchange for a predictable,
minimal per-thread RAM cost.
