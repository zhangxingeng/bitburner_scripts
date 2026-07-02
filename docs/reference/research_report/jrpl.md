# Jrpl Bitburner Scripts — Research Report

## Summary

Jrpl is a clean, minimal early-game repo (8 files). The core pattern is the **distributed-worker model**: three ultra-thin worker scripts (`targeted-hack.js`, `targeted-grow.js`, `targeted-weaken.js`, each 2-3 lines) are spawned by a central orchestrator (`hack-manager.js`) with pre-computed thread counts and delay arguments. Workers do exactly one thing: sleep then operate. No `ns.getServer`, no scanning, no logic — pure Thread C compute nodes. RAM footprint per worker instance is 3.3-3.35 GB per thread (base 1.6 + op cost), which is the theoretical minimum. The orchestrator is the only script carrying heavy API weight. Two targets are maintained simultaneously: `hack_target` (max absolute money) and `little_target` (max per-thread efficiency), with `little_target` used as fallback when purchased servers aren't available. Thread ratios: hack 50% of available money, grow 2x, weaken enough to offset security with 10% buffer.

---

## Per-File Notes

### `utils.js`

Two exports, both used by hack-manager:

- **`multiscan(ns, server)`**: Recursive DFS from given seed. Maintains a flat `serverList` and skips already-visited nodes. Returns all reachable servers. O(n) scan of entire network. No RAM overhead beyond `ns.scan()`.

- **`gainRootAccess(ns, server)`**: Tries all five port-openers (brutessh, ftpcrack, relaysmtp, httpworm, sqlinject) if the exe exists, then nukes if `portsRequired <= openPortCount`. No error thrown if nuke not possible — just silently no-ops. Singularity backdoor is stubbed out in a comment.

### `targeted-hack.js` — 3 lines

```js
export async function main(ns, threads = ns.args[0], time = ns.args[1], target = ns.args[2]) {
    await ns.sleep(time);
    await ns.hack(target, { threads });
}
```

**Args**: `threads` (int), `time` (ms delay), `target` (hostname).
**RAM footprint**: 1.6 (base) + 1.7 (ns.hack) = **3.3 GB** per process × threadCount.
**ns.sleep cost**: 0 GB.
The `{ threads }` option explicitly sets the thread count on the operation, matching the exec thread count. Delay is injected by the manager to achieve HGW timing alignment.

### `targeted-grow.js` — 3 lines

```js
export async function main(ns, threads = ns.args[0], time = ns.args[1], target = ns.args[2]) {
    await ns.sleep(time);
    await ns.grow(target, { threads });
}
```

**Args**: `threads` (int), `grow_delay` (ms), `target` (hostname).
**RAM footprint**: 1.6 + 1.75 (ns.grow) = **3.35 GB** per process × threadCount.

### `targeted-weaken.js` — 2 lines

```js
export async function main(ns, threads = ns.args[0], target = ns.args[1]) {
    await ns.weaken(target, { threads });
}
```

**Args**: `threads` (int), `target` (hostname). **No delay** — weaken is always the reference operation (finishes last, sets the timing baseline).
**RAM footprint**: 1.6 + 1.75 (ns.weaken) = **3.35 GB** per process × threadCount.

### `hack-manager.js`

The orchestrator. ~440 lines but most is duplication between the "has servers" and "no servers" branches. Key functions:

#### `best_target(ns, arr)`

Filters all servers to those where: rooted (attempts root first), `hackLevel <= playerLevel`, not home, not purchased, `moneyAvailable > 0`. Then returns **two** candidates:

- `hack_target = argmax(getServerMaxMoney)` — highest absolute ceiling; best once you have RAM
- `little_target = argmax(getServerMaxMoney * hackAnalyze)` — highest money-per-hack-thread; best for low-RAM/early-game efficiency

#### Thread calculation (main loop, lines 252-259)

```js
grow_threads = ns.growthAnalyze(hack_target, 2)          // double money
hack_threads = ns.hackAnalyzeThreads(hack_target, moneyAvailable / 2)  // steal 50%
sec_increase = hackAnalyzeSecurity(hack_threads) + growthAnalyzeSecurity(grow_threads)
weaken_threads = 1; while (weakenAnalyze(wt) < sec_increase * 1.1) wt += 5
```

Ratio intent: steal 50%, grow back 2x, weaken to absorb all security with 10% buffer. This is conservative but reliable.

#### Host selection (lines 267-279)

Only considers **purchased servers** and home (not wild network servers) as *execution hosts*. A host qualifies only if `freeRam >= neededRam` for a full HGW cycle. This is a key limitation: it ignores free RAM on wild servers for the main hack path (only `little_hack` uses them).

#### Prep phase (lines 282-381)

Before hacking, checks if target needs growing/weakening:
- `initial_growth_amount = 0.5 * maxMoney / moneyAvailable` — targets 50% of max money before starting
- If `initial_growth_amount > 1`: compute grow threads (`gt`) for that ratio
- Compute weaken threads (`wt`) to cover current security delta + grow security increase
- Finds a prep_server with enough RAM; falls back to `little_prep()` across distributed servers if none

#### Main hack dispatch (lines 387-437)

Iterates purchased servers. Per server:
- `n = floor(freeRam / neededRam)` — how many full HGW cycles fit
- Copies worker scripts via `ns.scp`
- **Timing model**: `grow_delay = weakenTime - growTime - 2ms`, `hack_delay = weakenTime - hackTime - 1ms`. Weaken has no delay. This makes grow finish 2ms before weaken, hack finish 1ms before weaken — ordering: grow → hack → weaken (ascending security cleanup).
- Fires `n` cycles with 3ms sleep between execs. All cycles overlap in time (batched, not sequenced).
- **Desync guard** (line 413): if `Date.now() >= initial_time + hackTime`, it aborts the loop, fires a single weaken, sleeps, and resets. This prevents launching hacks after a previous hack has already fired (which would change hack timings mid-flight).

#### `little_hack(ns, ...)` (lines 119-235)

Fallback for when no single host fits a full HGW cycle:
- Scans ALL rooted servers as potential hosts
- Uses a **scaling divisor** `c` starting at 2 (hack 1/c = 50%); if RAM doesn't fit, increments c until total RAM fits: `growThreads(1/(1-1/c)) + hackThreads(money/c) + weakenThreads fits usable RAM`
- Iterates hosts, filling each with weaken/grow/hack until thread counts hit zero; then recalculates for next batch and sleeps 1500ms
- Per-server RAM fill is greedy: weaken first, then grow, then hack, repeating the per-server inner loop until the server has no space left for even one weaken thread
- Uses a batch counter `n` passed as arg to each worker (for distinguishing parallel instances)

#### `little_prep(ns, ...)` (lines 39-117)

Distributed prep across all rooted servers:
- Scaling via `c` starting at 1.0, decrementing by 0.001 per iteration until `needed_RAM * c <= usable_RAM`
- Then fires scaled-down grow and weaken threads distributed across hosts
- Home RAM reserved via `reserved_RAM` parameter on home server specifically

### `buy-servers.js`

One-shot (no loop). Algorithm:
1. Build `ramList = [2, 4, 8, ..., 2^20]`
2. Filter to those where `numServers * cost <= homeMoney`
3. Take the highest affordable RAM tier as `bestRam`
4. Purchase up to `min(requested, maxServerLimit)` servers
5. If over limit: prompt user to delete smallest-RAM servers to make room

Key insight: maximizes RAM per server given a fixed total spend. Asking for fewer servers yields bigger servers.

### `hacknet-upgrades.js`

Continuous loop, self-kills when done. Per-node ROI scoring:

- **Level ROI**: `(level+1 * 1.6) * 1.035^(ram-1) * (cores+5)/6 / levelUpgradeCost` (capped at level 200)
- **RAM ROI**: `level * 1.6 * 1.035^(ram*2-1) * (cores+5)/6 / ramUpgradeCost` (capped at ram 64)
- **Core ROI**: `level * 1.6 * 1.035^(ram-1) * (cores+6)/6 / coreUpgradeCost` (capped at cores 16)

Picks highest-ROI upgrade that costs less than `pct%` of current money. Also buys new nodes if purchase cost < allowance and under maxNodes cap. Credit to Reddit formula.

---

## The Distributed-Worker Pattern — Precise Description

This is the central architectural pattern and the most transferable lesson:

**Structure:**
```
hack-manager.js (orchestrator, heavy RAM, runs once on home)
    ↓ ns.exec() with pre-computed args
targeted-weaken.js  (worker, 3.35 GB/thread, arg: threads, target)
targeted-grow.js    (worker, 3.35 GB/thread, arg: threads, delay, target)
targeted-hack.js    (worker, 3.30 GB/thread, arg: threads, delay, target)
```

**Why it's minimal:**
- Each worker has exactly ONE ns.* operation call. No scanning, no server queries, no conditions.
- `ns.sleep()` costs 0 GB in Bitburner — free timing mechanism.
- The orchestrator absorbs all API overhead: `ns.growthAnalyze`, `ns.hackAnalyzeThreads`, `ns.weakenAnalyze`, `ns.hackAnalyzeSecurity`, `ns.growthAnalyzeSecurity`, `ns.getWeakenTime`, etc. None of these appear in worker scripts.
- Workers run and die. They don't loop or maintain state.

**Execution model:**
```
exec('targeted-weaken.js', host, wt, wt, target)         // fires immediately
exec('targeted-grow.js',   host, gt, gt, grow_delay, target)  // sleeps grow_delay
exec('targeted-hack.js',   host, ht, ht, hack_delay, target)  // sleeps hack_delay
// grow_delay = weakenTime - growTime - 2ms
// hack_delay = weakenTime - hackTime - 1ms
// Result: grow finishes 2ms before weaken, hack finishes 1ms before weaken
// Order of completion: grow → hack → weaken
```

**Thread allocation per cycle:**
- Hack: threads to steal `moneyAvailable / 2` (50% steal)
- Grow: threads to multiply money by 2 (`growthAnalyze(target, 2)`)
- Weaken: minimum threads so `weakenAnalyze(wt) >= (hackSec + growSec) * 1.1`

**Scaling:** `n = floor(freeRam / (ht*3.3 + gt*3.35 + wt*3.35))` cycles per host. All n cycles fire with 3ms spacing (overlapping in time, staggered by 3ms so RAM allocation is sequential). The desync guard resets if launch window exceeds hackTime.

---

## RAM Footprint Analysis

| Script | ns calls | RAM/thread |
|---|---|---|
| targeted-hack.js | ns.hack | 3.30 GB |
| targeted-grow.js | ns.grow | 3.35 GB |
| targeted-weaken.js | ns.weaken | 3.35 GB |

These are **theoretical minima** for single-operation workers in Bitburner NS2. Any additional ns.* call (e.g., `ns.print`, `ns.getServerMoneyAvailable`, `ns.tprint`) would add RAM overhead.

On 8 GB home with 0 other scripts:
- Max weaken threads: floor(8 / 3.35) = 2 threads
- Max hack threads: floor(8 / 3.30) = 2 threads

On a purchased 128 GB server:
- Max weaken threads: floor(128 / 3.35) = 38 threads
- Mixed HGW cycle (typical): 1 hack-thread + 2 grow-threads + 3 weaken-threads ≈ 26 GB/cycle → 4 cycles fit

The orchestrator (hack-manager.js) uses many ns.* calls and should always live on home — it's the only script not replicated to worker servers.

---

## Copy-vs-Build: Early-Game / Low-RAM Lessons

**Adopt directly:**

1. **Ultra-thin worker pattern**: 2-3 line worker scripts with sleep + single op. This is the gold standard for Thread C compute nodes. Add zero ns.* calls to workers that aren't needed for the operation itself.

2. **Delay injection by orchestrator**: The orchestrator computes all delays and passes them as args. Workers just sleep. This keeps timing logic in one place and workers at minimum RAM.

3. **Separate hack_target from little_target**: The dual-target approach (`argmax(maxMoney)` vs `argmax(maxMoney * hackAnalyze)`) is smart. Use the efficient target when RAM-constrained, switch to absolute-max-money target when you have pserv RAM. Directly applicable to our simple_hack_loop.

4. **Reserved RAM on home**: Pass a `reserved_RAM` arg and subtract it from home's free RAM in every calc. Essential so the orchestrator itself isn't evicted by its own workers.

5. **gainRootAccess pattern in utils.js**: Try all port openers optimistically, nuke when sufficient ports open. No error handling overhead — just conditional exe checks.

6. **Scaling divisor `c`**: When total needed RAM > available, divide the operation size (hack 1/c, grow 1/(1-1/c)) and increment c until it fits. Clean way to find the largest feasible batch.

7. **hacknet ROI formula**: The `production / cost` scoring with the Bitburner production formula embedded is directly reusable.

**Adapt (not copy):**

- **Host selection limited to purchased servers**: Jrpl only uses pservs+home for the main path. For early game before pservs, wild servers are valuable. `little_hack()` does use them but it's the fallback — consider making distributed-across-wild the primary early-game path.

- **Sequential server filling in little_hack**: The inner while-loop that fills each server in turn is greedy but can leave gaps. A sort-by-free-RAM-descending would be cleaner.

**Do not copy:**

- **Single target focus**: Once you have pservs, it only hacks one target per cycle. Multi-target parallelism (different pservs targeting different servers) would be better for mid-game.

- **3ms batch spacing**: Stacking all n cycles with 3ms between execs on one server without proper stagger means they all target the same finish window — the desync guard is a band-aid. A proper staggered batch pattern (HWGW with 200ms between batches) is more robust.

---

## Limitations (Where This Breaks Down)

1. **Single target**: Scales linearly with RAM on one server. No parallelism across multiple targets once you have multiple pservs.

2. **No auto-upgrade**: `buy-servers.js` is one-shot. There's no polling loop that upgrades servers as money grows. The user must re-run it manually.

3. **Naive timing**: The 3ms batch stagger works but doesn't prevent desync across multiple hosts. The desync guard (reset to single weaken) is disruptive.

4. **No Formulas.exe support**: Thread calculations don't use `ns.formulas.hacking.*` — those give exact values accounting for current skill/server state but require Formulas.exe (not available early game, which is appropriate for this repo's scope).

5. **little_hack inner loop complexity**: The nested while loops in `little_hack` are hard to follow and have a `host_servers.length` bug risk (iterates `host_servers` with outer for, but inner while breaks on `!weaken && !grow && !hack` and increments n without restarting the server iteration properly).

6. **No Singularity / no augments tracking**: Purely stateless — no consideration of player stats progression, augment purchases, or BitNode multipliers.

---

## Interesting Discoveries

- **`best_target` returns two values**: The dual-return `[maxMoney_target, maxEfficiency_target]` from `best_target()` is elegant. The efficiency metric `maxMoney * hackAnalyze` approximates money-per-thread-per-hack without needing time normalization — it's fast and good enough for early game target picking.

- **Weaken as timing reference**: Weaken always fires with no delay, and grow/hack fire with negative offsets so they complete just before weaken. This means weaken is always the *last to complete* in a cycle, which is correct — you want security to be cleaned up after hacking has occurred.

- **The `n` arg passed to workers**: In `little_hack` and the main hack loop, a batch counter `n` is passed as an arg to each worker exec. This doesn't affect the worker's behavior (workers ignore args beyond what they need) but it makes each `exec()` call have a unique argument signature, which prevents Bitburner from deduplicating identical exec calls.

- **`hackAnalyzeChance` divisor in little_hack** (line 149): `hack_threads = Math.floor(ns.hackAnalyzeThreads(...) / ns.hackAnalyzeChance(hack_target))` — divides by hack success chance to over-provision threads, accounting for the probability that some hacks fail. This is the only place hack chance is considered in the whole codebase, and it only appears in the low-RAM fallback path.

- **`wt = 1; while (weakenAnalyze(wt) < sec * 1.1) wt += 5`**: The increment is 5 in main but 3 in little_hack. The inconsistency suggests these were written independently. Neither is wrong but the main loop uses +5 (slightly over-shoots, wastes some weaken threads), little_hack uses +3 (tighter).

- **`buy-servers.js` deletes servers in sorted order**: Sorts existing servers by RAM ascending, deletes the smallest ones first to make room. Smart — preserves your largest servers.
