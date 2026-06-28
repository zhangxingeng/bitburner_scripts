# Zharay BitburnerBotnet — Research Report

## Summary

Mid-scale botnet (~600 lines of coordinator logic, ~400 lines of daemon logic). Central design: **one coordinator on home, one hack-daemon per host server, worker scripts (hack/grow/weaken) as single-operation throwaway processes.** All IPC is via NS ports (20 available); no files used for coordination. Coordinator is purely reactive — it aggregates state from worker reports and re-publishes it as global views. Daemons self-register, pull targets, and decide their own thread counts autonomously using coordinator-published state. Side engines (gang, corp, stocks, hacknet, buy-server) run independently with minimal coordinator coupling. Stocks are the star passive income; the full stock-bot.js uses 4S forecast data with forecast thresholds and profitPotential momentum to trade longs and shorts. Gang is nearly fully automatable (Thread C). Corp requires ~30 minutes of manual bootstrap then hands off to the script.

---

## Coordinator Architecture

### Overview

`coordinator.js` runs as a single process on home. It does **not** dispatch workers — it only maintains shared state via ports. Workers are self-scheduling. The coordinator's job is:

1. Accept registrations (new hosts, deleted hosts)
2. Accumulate task reports from workers (+thread/+RAM on start, -thread/-RAM on done)
3. Manage distributed locks to prevent race conditions
4. Re-publish aggregated state so daemons can make correct decisions
5. Promote hard targets to hackable when conditions are met

### Port Map (the full IPC schema)

| Port | Direction | Format | Purpose |
|------|-----------|--------|---------|
| 1 | coordinator → all | JSON array | Global target list: `[{target, thresholdModifier, TIX, maxMoney, curMoney, growth, security, minSecurity}]` |
| 2 | coordinator → all | JSON array | Host list: `[{host, maxRam}]` |
| 3 | coordinator → daemons | JSON array | Target status (in-flight thread counts): `[{target, hackThreads, growThreads, weakenThreads, isLong, isShort, ...}]` |
| 4 | coordinator → check-status | JSON | Global RAM stats: `{totalRam, usedRam}` |
| 5 | coordinator → all | JSON | EXP target list |
| 6 | coordinator → daemons | JSON | Lock flags per target: `[{target, hackLock, weakenLock, growLock, hackTime, ...}]` |
| 8 | auto-spread → coordinator | String | Comma-separated initial target list (written before coordinator starts) |
| 11 | daemon → coordinator | String | New host registration (hostname) |
| 12 | buy-server → coordinator | String | Host deletion notification |
| 13 | workers → coordinator | JSON | Task events: `{target, host, task, done, threads, ram, security}` |
| 14 | workers → coordinator | JSON | EXP task events (same schema as 13) |
| 15 | daemons → coordinator | JSON | Lock requests: `{target, host, task, done}` |
| 16 | stock-bot → coordinator | JSON | Stock positions: `{sym, long, short, profitChange, profitPotential}` |
| 17 | flag | String | Toggle CPU sharing (any text = on, NULL = off) |
| 18 | flag/stack | String | Kill specific host's hack-daemon gracefully |
| 19 | flag | String | Sell all stocks command |
| 20 | flag | String | Kill all command |

### Coordinator Main Loop (500ms tick)

Each tick in order:
1. **Promote hard targets**: if a hard target now has root and hack level met, reclassify as hack/exp/ignored and remove from hardTargets list
2. **Consume port 12**: remove deleted hosts from `jHostServers`
3. **Consume port 11**: add new hosts to `jHostServers`
4. **Publish port 2** (`gHosts`): updated host list
5. **Consume port 13**: apply task events — increment/decrement thread/RAM counts per target. `done:false` = +threads, `done:true` = -threads
6. **Consume port 14**: same as above but for EXP targets
7. **Consume port 15**: process lock requests. Each target has three independent locks (hack/weaken/grow). First requester wins; 10-second timeout; done:true releases the lock
8. **Consume port 16**: update `isLong`/`isShort`/`profitChange` per target TIX symbol
9. **Publish port 1** (`gTargets`): refreshed target list with current money/security
10. **Publish port 3** (`gStatus`): current thread/RAM/stock status per target
11. **Publish port 5** (`gExp`): EXP status
12. **Publish port 6** (`gLock`): updated lock state (with timeout increments)
13. **Update port 4** (`gRam`): sum RAM across all hosts

### Target Classification

Three buckets at startup (from port 8 or args):

- **hackTargets**: `hasRootAccess AND hackLevel <= player.hacking AND (getIsTarget() OR (stock server AND manipulateStocks))`
  - `getIsTarget()`: hackChance >= 0, growth in [30,100], maxMoney in [$1M,$20B]
- **expTargets**: exclude hackTargets, rooted, maxMoney > 0, hackLevel <= player.hacking
- **hardTargets**: hackLevel > player.hacking OR not rooted — polled each tick for promotion

### Self-Healing

Hard targets are checked every coordinator tick. When `hasRootAccess(x) && hackLevel(x) <= player.hacking`, the target is reclassified and added to the active hack/exp lists immediately. This handles the common pattern of gaining port openers mid-run.

---

## Spreading (auto-spread-v2.js)

**Entrypoint for the whole system.** Called by coordinator if port 8 is empty on startup.

1. `collect_server_names()`: BFS from home using `ns.scan()`, returns all servers + connection graph
2. Counts available port openers (`BruteSSH.exe`, etc.) to determine `maxPorts`
3. Tracks `serverHistory` (already processed), `unrootedServers` (need more ports later)
4. On initial spread: **writes server list to port 8**, then `ns.exec("coordinator.js", "home", 1)` — this is the coordinator launch
5. For each newly rooted server:
   - `ns.killall(s)` first
   - `await ns.scp(["hack-daemon.js","easy-hack.js","weaken.js","grow.js","hack.js","shareCPU.js"], "home", s)`
   - If `maxRam(s) < 8`: runs `easy-hack.js` (N threads, no daemon)
   - Else: runs `hack-daemon.js` (1 thread)
6. Loops every 1 minute until all 5 port openers are available, then exits
7. Does **not** backdoor (that code is commented out)

**Stock-server map** (`getServerTIXSymbol()`): hardcoded table of 32 server→symbol pairs (e.g. `"ecorp" → "ECP"`). This is because Bitburner has no API to get the TIX symbol from a hostname. Required for stock manipulation mode.

---

## Worker Scripts (hack.js / grow.js / weaken.js)

Minimal footprint (~1.7GB base RAM each). Each worker:

1. Reads args: `[target, host, numThreads, totalRam, securityDelta]`
2. Writes START event to port 13 (or 14 if `host == "EXP"`): `{target, host, task, done:false, threads, ram, security}`
3. Runs `ns.hack(target)` / `ns.grow(target)` / `ns.weaken(target)`
4. Writes DONE event: same JSON with `done:true` and `security *= -1`

Security delta is signed: positive on start (security going up when hack/grow run), negated on done (reversed because the operation already completed and affected the server). The coordinator sums `oldTask.security += parseFloat(newTask.security)` — growing this accumulator with start events, draining it when done events arrive.

Workers are **not** long-running. They run once and exit. No state kept in the worker.

---

## Hack Daemon (hack-daemon.js)

One instance per host. The actual intelligence layer.

### Startup
1. Posts own hostname to port 11 (coordinator adds to host list)
2. Waits for port 1 to have target data
3. Sleeps random 3–30 seconds (stagger to prevent thundering herd)

### Per-Loop Logic (iterates all targets in order)

For each target, in priority order:

**Weaken** — runs if:
- `isTarget == true`
- `currentSecurity > minSecurity + 5 OR trackedSecurityRisk > 5`
- Enough RAM for 1 weaken thread
- `weakenLock == ""`

Thread calc: `ceil((currentSecurity + securityThreat - threshold) / 0.05) * securityBreach - currentWeakenThreads`. `securityBreach=2` if total security is double the threshold (emergency mode). Caps at available RAM.

**Grow** — runs if:
- `(isTarget AND not long AND not short) OR (isLong AND profitChange < 0)` (for stock manipulation)
- Projected money after in-flight hacks < 98% of maxMoney
- Enough RAM
- `growLock == ""`

Thread calc via `ns.growthAnalyze(target, amountGrow)` where `amountGrow = maxMoney / (currentMoney - hackAmount)`.

**Hack** — runs if:
- `(isTarget AND not long AND not short) OR (isShort AND profitChange > 0)` (stock short manipulation)
- `currentMoney >= maxMoney * threshModifier (0.75)` or `isShort`
- `hackChance >= 0.10`
- Enough RAM
- `hackLock == ""`

Thread calc: `hackAnalyzeThreads(target, money-threshold) / hackChance - currentHackThreads`. Divides by hackChance because each thread has less than 100% success probability.

### Lock Protocol (per task)

1. Daemon writes lock request `{target, host, task, done:false}` to port 15
2. Polls port 6 (`gLock`) until own hostname appears in `hackLock`/`weakenLock`/`growLock`
3. Calculates threads, launches worker script
4. Sleeps 1 second
5. Writes lock release `{..., done:true}` to port 15
6. Coordinator clears the lock within 500ms

10-second timeout on coordinator side: if a daemon holds a lock >10 ticks (5 seconds at 500ms coordinator loop), it is force-cleared. In practice this never happens.

### Share Mode

If port 17 has data AND host is home or pserv: run `shareCPU.js` with `floor(availableRam / scriptRam)` threads. Skip all H/G/W work for this iteration.

### EXP Farming

After all targets processed, if available RAM >= minRequired AND `curRuns >= expRuns (2)`:
- Pick random EXP target
- Allocate: 40% RAM to weaken, 40% to grow, 20% to hack
- Reports to port 14 (EXP channel)

---

## shareCPU.js

```js
while (ns.peek(17) != "NULL PORT DATA" && ns.peek(20) == "NULL PORT DATA") {
    await ns.share();
    await ns.sleep(1000);
}
```

`ns.share()` lasts 10 seconds and multiplies faction reputation gain by ~1.35x per thread. Worth it when: you have excess RAM after all hacking threads are saturated and you need to grind faction rep for expensive augments. Cost: completely pauses hacking income on those threads. Toggle via any write to port 17; `optional/toggleShare.js` writes/clears it.

---

## Side Engines

### hacknet-mgr.js (Thread C — fully automatable)

ROI-based node management:
- `bestNodeUpgrade(ns, 0)`: compares `levelProdPerCost`, `ramProdPerCost`, `coreProdPerCost` for Node 0
- If best upgrade PPC > new-node PPC: upgrade; else buy new node
- `upgradeToMatch()`: brings all nodes to same spec as Node 0 before upgrading leader
- Stops at `maxIncome = 1e9/sec`
- Budget: `spendPercentage = 0.10` of player cash per purchase
- Exits cleanly via port 17 (shares kill flag with shareCPU — probably unintentional coupling)

Verdict: **Pure Thread C**. Stat-decidable, no judgment required.

### gang-nullsec.js (Thread C — nearly fully automatable)

Hacking gangs only (`The Black Hand`, `NiteSec`). Loop: recruit → ascend → equip → assign tasks.

**Task assignment** (`handleTasks`): uses `ns.formulas.gang.moneyGain/respectGain/wantedLevelGain` to calculate per-task per-grunt economics. Budget: keep total `wantedGain <= 0` globally. Tasks sorted descending by `baseMoney`; each grunt gets the highest-money task that fits within the wanted budget. Fallback: train to `initialHackLevel=120`.

**Ascension** (`handleAscension`): ascend if `hack multiplier >= 1.5x AND respect cost <= gang.respect`. After ascension, `grunt.oldHack = grunt.hack * 0.5` (triggers retraining to 50% of former level).

**Equipment** (`handleEquips`): buy all hack/cha gear cheapest-first if `allowance (0.2 * playerMoney) >= cost`.

Thread P aspects: **none** after gang is created. The `maxWantedGain=0` setting keeps the gang from generating wanted level — this is a sensible auto-default. Territory wars not handled.

Verdict: **Thread C**. All decisions are stat-decidable. Requires Formulas API.

### corpo.js (Thread P for setup, Thread C for operations)

**Manual bootstrap required** (documented in code as inline guide comments):
1. Create Agriculture division, hire 3+, buy warehouses, set sell prices
2. Two rounds of investment tricks (stop selling, fill warehouse, sell all at once)
3. Expand to Tobacco when profits allow

**After bootstrap, auto-handles**:
- `handleUpgrades()`: priority-ordered upgrade list (Wilson Analytics first, ABC SalesBots last)
- `handleResearch()`: Lab → Market-TA.I+II together → researchList
- `handleProducts()`: discontinues worst performer (lowest MP multiplier) and creates new product when slots full
- `determineMaxMarketPrice()`: binary search loop — steps MP multiplier up from starting estimate until production > selling, then steps back 2 — finds optimal MP*N
- `handleAds()`: hires AdVert if cheaper than 15-employee office expansion
- `handleEmployees()`: expands in 15-seat chunks, distributes evenly (0 training, equal split across 5 roles)
- `handleWarehouses()`: upgrades if >60% full

**`trickInvest()`** (manual invocation needed): shifts all employees to Operations to fill warehouses, then to Business to sell all at once. Spikes profitability for 4x investment offer. Not called automatically — must be invoked by player before accepting round 2/3 offers.

Thread P aspects: accepting investor offers (human judgment on timing), going public, initial resource purchase orders, knowing when to call `trickInvest()`.

Verdict: **Hybrid** — operations are Thread C after setup; setup and investor timing are Thread P.

---

## Stock Trading

### stock-bot.js (production, requires 4S data) — $31b total API cost

**Data inputs per stock**: `getPrice`, `getPosition`, `getVolatility`, `getForecast`, `getAskPrice`, `getBidPrice`, `getMaxShares`.

**Key derived metrics**:
```js
profitChance = 2 * (forecast - 0.5)          // range [-1, 1]
profitPotential = volatility * profitChance / 2
```

**Sell triggers** (checked first each cycle):
- Long: `forecast < 0.5 OR profitPotential <= 0 OR profitPotential degraded > -25% from purchase time`
- Short: `forecast > 0.5 OR profitPotential > 0 OR profitPotential improved > +25% from purchase`
- Cash emergency: if `playerMoney < fracL (2.5%) * corpus`, liquidate longs for `fracH (5%)` of corpus

**Buy triggers** (after sells):
- Long: `forecast > 0.55 AND condition (numShares * profitPotential * price * numCycles) > 2 * commission`
- Short: `forecast < 0.45 AND condition (numShares * bidPrice * numCycles) > 2 * commission` (iterates back-to-front by profitPotential)

Stocks sorted descending by `profitPotential` before buy loop, so highest-potential stocks get first call on available cash.

**Corpus management**: `corpus = playerMoney + sum(longPrice*longShares + shortPrice*shortShares)`. Cash position targets: keep `fracH=5%` as cash floor; liquidate if below `fracL=2.5%`.

**Coordinator integration**: every cycle calls `reportStocks(ns, stocks)` which writes `{sym, long, short, profitChange, profitPotential}` to port 16. Coordinator reads these and marks targets as `isLong`/`isShort`. Daemons then:
- If `isLong`: run grow.js aggressively (boosts stock price)
- If `isShort`: run hack.js aggressively (crashes stock price for short profit)
- If `isLong AND profitChange < 0` (price falling): grow harder
- If `isShort AND profitChange > 0` (price rising): hack harder

This is **market manipulation** via the botnet's compute power. It's optional (`manipulateStocks = true` in coordinator.js).

**Cycle time**: 4 seconds (`numCycles=1`; each `ns.stock` tick is 4s in Bitburner). No forecasting delay — uses real-time 4S data.

### stock-bot-v2.js (bootstrap only, no 4S required)

- Tracks 30 ticks of price ratio history per symbol
- `predictState()`: uses a precomputed table of progressive limits against positive-change count in the window to output +1/0/-1 signal
- Buy long if state=+1; buy short if state=-1; sell on signal reversal
- `liquidateThresh = 31e9`: alerts and liquidates when total value (equity + cash) >= $31B so player can buy 4S APIs and switch to stock-bot.js
- **Warning in header**: "not really do anything," "once landed me -$400b in debt"
- Use only as bootstrap to accumulate $31B for API access

**v1 vs v2 difference**: v1 (`stock-bot.js`) = production quality, uses 4S forecast, proper fund management, coordinator integration. v2 = bootstrap/fallback, no APIs needed, sample-based prediction, simpler but unreliable.

---

## buy-server.js

Manages 24 private servers (Bitburner max).

- Starts buying at `memLevel=4` (16GB)
- Upgrades when global pserv RAM usage > 80% threshold
- **Graceful deletion protocol**:
  1. Write target hostname to port 18 (`fHostKill`)
  2. Poll until hack-daemon clears the port (daemon sees its name, sets `done:true`, reads port to clear)
  3. Manually emit DONE events to port 12/13 for any still-running worker processes (by reading `ns.ps()` and reconstructing task JSON from process args)
  4. Delete server, buy bigger one, SCP files, run hack-daemon
- Notifies coordinator of deletions via port 12

`memLevel` progression: increments after 25 upgrades, scaling through 16GB → 32GB → ... → 1TB → ... → 1PB.

---

## check-status.js / easy-hack.js

**check-status.js**: display-only script run by coordinator at startup. Reads ports 1-6 and formats a status dashboard. No IPC side effects.

**easy-hack.js**: fallback for servers with <8GB RAM. Cannot run hack-daemon (too much overhead). Runs a simplified hack loop with no coordinator integration — just `ns.hack(target)` in a loop against `n00dles` or similar. Minimal RAM footprint.

---

## Strengths vs. Weaknesses

### Copy / Directly Adopt
- **Port-based IPC schema**: the 20-port design is the cleanest coordination pattern here. Full port map (coordinator.js lines 65-85) is worth porting directly. No shared files, no polling filesystem.
- **Lock protocol**: per-target, per-task distributed locks via coordinator (ports 15/6) solve the race condition problem elegantly. 10-second timeout is the right safety valve.
- **Task event reporting pattern**: workers report START and DONE events; coordinator accumulates state. This gives coordinator perfect visibility into in-flight resource usage without polling processes.
- **stock-bot.js strategy**: forecast threshold + profitPotential momentum + corpus-relative position sizing is solid. `profitPotential = volatility * profitChance / 2` is a reusable signal.
- **Hard target promotion loop** in coordinator: the pattern of watching hardTargets and reclassifying them as the player gains capabilities is clean and general.
- **graceful deletion** in buy-server.js: the protocol for migrating a server is complete — request daemon self-kill, manually close task accounting, notify coordinator, then delete. Worth copying verbatim.

### Rebuild / Improve
- **Thread counts are not batched**: each daemon independently picks a target and launches threads sequentially with locks. A proper batch scheduler would compute the optimal W/G/H thread split per target and dispatch all in one coordinated round, eliminating the need for locks.
- **No HWGW batching**: operates in a simple "enough weaken threads then grow then hack" mode. Does not implement the classic Hack-Weaken-Grow-Weaken (HWGW) timing batch pattern that maximizes throughput by aligning operation completions.
- **Coordinator loop is 500ms but port updates are slow**: ports have 1-item capacity in some Bitburner versions; the `peek()` rather than `read()` pattern for gTargets/gStatus means all daemons read the same snapshot, which is correct but means the coordinator is the bottleneck.
- **hacknet-mgr.js has a bug**: `maxIncome` and `spendPercentage` are declared `const` but the code attempts to reassign them from args (will throw in strict mode). Also `coreUpgradeCostTotal` uses `^` (XOR, not exponentiation) instead of `Math.pow`.
- **stock-bot-v2.js is dangerous**: self-documented as unreliable. Do not use in production.
- **gang-nullsec.js `generateName()`** has a logic bug: `while (!isUnique || numTries > 10)` — the `||` should be `&&`; as written it loops indefinitely if numTries > 10 and a unique name is found.
- **corpo.js requires Formulas API listed in gang header** but does not actually use it; corpo.js dependency is only `Office API` and `Warehouse API`.
- **No inter-engine coordination**: stocks report to coordinator but gang/corp/hacknet have no awareness of system RAM load or player cash state. A shared budget manager would prevent all engines from competing for the same cash simultaneously.

---

## Interesting Discoveries

1. **Stock manipulation as a compute allocation signal**: setting `manipulateStocks=true` makes the botnet preferentially grow servers whose company you hold stock in (and hack servers you've shorted). The stock-bot feeds positions to port 16 every cycle, and the coordinator immediately bakes `isLong/isShort` into the target objects that daemons read. This is a tight feedback loop between two otherwise independent engines.

2. **The `easy-hack.js` tier**: servers with <8GB RAM cannot run hack-daemon (it's a 5.7GB+ script). These get a stripped-down loop instead. This means the coordinator does not know about compute on these tiny servers — they're "dark" nodes that just do their own thing against n00dles. In practice these are the early-game servers.

3. **EXP farming consumes leftover RAM**: after all H/G/W cycles complete, leftover RAM goes 40/40/20% to weaken/grow/hack on a random EXP target. Only kicks in after `expRuns=2` full cycles (prevents starvation on primary targets). EXP farm runs don't compete with real hacks because they only use truly leftover RAM.

4. **Random startup jitter**: hack-daemons wait `floor(random(3,30)) * 1000` ms before their first loop. This staggers 24+ daemons across a 30-second window so they don't all try to lock the same target simultaneously on startup.

5. **`trickInvest()` is the real corp money-maker**: the standard corporation loop is good for long-term income but the investment trick (mass-producing then mass-selling in one tick) can multiply investor offers 2-4x. The function is fully implemented but not called automatically — it's a player-triggered optimization.

6. **Lock timeout is measured in coordinator ticks (not seconds)**: `hackTime >= 10` at 500ms/tick = 5 seconds, not 10. The comments say "10 seconds" but the actual timeout is 5 seconds. This is a minor documentation bug.

7. **Port 17 is shared between hacknet-mgr and shareCPU**: hacknet-mgr uses port 17 as its kill flag (`while fKill.peek() == "NULL PORT DATA"`), but port 17 is also the share toggle. Writing to port 17 to enable CPU sharing also kills hacknet-mgr. Appears unintentional.
