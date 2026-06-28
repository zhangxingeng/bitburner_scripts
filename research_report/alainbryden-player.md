# alainbryden Bitburner Scripts — Player Thread & Side Engines Research Report

## Summary

This repo is a nearly complete "plays itself" automation suite centered around `autopilot.js` as the orchestrator. It uses the **Singularity API exclusively** (no DOM clicking for player actions) via a pervasive RAM-dodging wrapper called `getNsDataThroughFile`. The **only DOM automation** is `casino.js`, which uses `eval("document")` to click blackjack buttons to earn $10B early game. The **reset loop is fully automated** — `autopilot.js` monitors `faction-manager.js` output, counts affordable augs, starts a countdown timer, then calls `ascend.js` which handles the full install sequence. All of this requires SF4 (Singularity); without it, most scripts self-terminate with a message to the user.

---

## A. MECHANISM — How Player Actions Are Performed

**Method: Singularity API (`ns.singularity.*`) + RAM-dodging wrapper**

All player-thread actions use the Singularity API:
- `ns.singularity.commitCrime("Homicide", true)` — crime
- `ns.singularity.workForFaction(faction, "hacking")` — faction work
- `ns.singularity.universityCourse(university, course, focus)` — studying
- `ns.singularity.travelToCity(city)` — travel
- `ns.singularity.applyToCompany(company, job)` — company application
- `ns.singularity.purchaseAugmentation(faction, aug)` — aug purchases
- `ns.singularity.installAugmentations(resetScript)` — reset
- `ns.singularity.destroyW0r1dD43m0n(nextBn, restartScript)` — BN completion
- `ns.singularity.stopAction()` — stops any current player work
- `ns.singularity.joinFaction(faction)` — joins faction

**RAM Cost Problem and Solution: `getNsDataThroughFile()`**

Singularity functions are extremely expensive in RAM before SF4.3 (16x normal cost at SF4.1, 4x at SF4.2, 1x at SF4.3). The entire repo solves this with a single helper (`helpers.js:156`):

```js
export async function getNsDataThroughFile(ns, command, fName = null, args = []) {
    // Writes a tiny temp .js script with the command embedded as a string
    // Spawns it via ns.run() (costs only 1 GB)
    // Temp script executes: r = JSON.stringify(ns.singularity.someFunc()); ns.write(fName, r, 'w');
    // Parent reads the file for the result
}
```

Every single Singularity call in `work-for-factions.js`, `faction-manager.js`, `autopilot.js`, and `ascend.js` goes through this wrapper. The overhead cost is ~1 GB (for ns.run) plus the base cost of the Singularity function isolated in a sandboxed temp script — drastically lower than importing it directly. This is what allows the suite to work on 32–64 GB home RAM even with SF4.1.

**Casino Exception — DOM Automation:**
```js
let doc = eval("document"); // casino.js line 31
const btnUnfocus = await tryfindElement("//button[text()='Do something else simultaneously']");
await click(btnUnfocus);
```
`casino.js` clicks real UI buttons to play blackjack — the only DOM automation in the repo.

---

## B. EARLY GAME — Before SF4

If the player does NOT have SF4, nearly everything is disabled:

- **`autopilot.js` startup**: Logs `"WARNING: This script requires SF4 (singularity) functions... some functionality will be disabled and you'll have to manage working for factions, purchasing, and installing augmentations yourself."` Sets `playerInstalledAugCount = null`.
- **`work-for-factions.js`**: Immediately returns with `"ERROR: You cannot automate working for factions until you have unlocked singularity access (SF4)."`
- **`ascend.js`**: Immediately returns with `"ERROR: You cannot automate installing augmentations until you have unlocked singularity access (SF4)."`
- **`faction-manager.js`**: Immediately returns with `"ERROR: This script requires SF4 (singularity) functions to work."`
- **`shouldWeKeepRunning()`** in autopilot: shuts itself down after launching `daemon.js` when home RAM is 8 GB.

**The Casino Bridge ($10B Bootstrap):**

The early-game bridge is `casino.js` + `stockmaster.js`. `autopilot.js::maybeDoCasino()` runs automatically when:
1. We haven't already earned $10B from the casino
2. Our total wealth < $1T
3. We're not already making >$5B/min
4. We have $300K to travel to Aevum

Steps:
1. Kill all scripts (including `work-for-factions.js`, `daemon.js`)
2. Call `ns.singularity.stopAction()` if SF4 available
3. Launch `casino.js --kill-all-scripts --on-completion-script autopilot.js`
4. `casino.js` uses DOM clicking to win blackjack repeatedly until $10B is earned
5. On win, restarts `autopilot.js` as the completion script

The $10B is then seeded into `stockmaster.js` (which runs without SF4 using `ns.stock.*` directly — those APIs don't require SF4). `autopilot.js` also reserves money for stocks in `reserve.txt`.

**Pre-4S Stock Market:** `stockmaster.js` runs a statistical model to trade before having 4S data — it tracks a 75-tick market cycle, detects inversions (probability reversal), and uses both long-term and near-term forecast windows. This is the primary income source pre-SF4.

**No graceful fallback** for faction/work automation before SF4 — it's explicitly design-gated. The game flow before SF4 is: run daemon.js for hacking income + casino + stocks, then manually install augs.

---

## C. THE RESET LOOP — When and How to Install Augmentations

**Fully automated once SF4 is obtained.**

### Decision Logic (`autopilot.js::maybeInstallAugmentations()`)

Every 2 seconds (`--interval`), `autopilot.js` reads `/Temp/affordable-augs.txt` written by `faction-manager.js`:

```js
let shouldReset =
    options['install-for-augs'].some(a => facman.affordable_augs.includes(a)) || // e.g. TRP
    pendingAugCount >= augsNeeded ||  // default: 8 (+ SF11 bonus - time reduction)
    pendingAugInclNfCount >= augsNeededInclNf; // default: 12
```

**Time-decay mechanic:** `reducedAugReq = floor(0.5 * hoursInAug)` — requirement drops by 0.5 augs per hour, so a long-running reset needs fewer augs to trigger a reset. Overridden in BN8 and first BN9 aug (increased by 2).

**Quick-install heuristic:** If >=4 augs (or 6 with gang) affordable within first 20 minutes, reset immediately with 30s countdown (vs default 5 min).

**Countdown and reservation:**
- When `shouldReset = true`, sets `installCountdown = Date.now() + options['install-countdown']` (default 5 min)
- Writes `totalCost` to `reserve.txt` to prevent other scripts from spending it
- Each time more augs become affordable, resets the countdown (linearly shorter each time, min 10s)
- TRP unlocks: countdown is NOT extended

**Delay conditions (`shouldDelayInstall()`):**
- Currently grafting an augmentation
- Close to affording 4S TixAPI (controlled by `--wait-for-4s-threshold`, default 0.9)
- In BN8 with close Daedalus requirements
- `reservingMoneyForDaedalus = true`
- In BN10 and approaching $100q for last sleeve purchase

### The Install Sequence (`ascend.js`)

Once `autopilot.js` triggers, it calls `ascend.js --install-augmentations --on-reset-script autopilot.js`:

1. Kill all scripts except ascend.js itself (`ns.ps().filter(...).forEach(s => ns.kill(s.pid))`)
2. `ns.singularity.stopAction()` — stop any player work
3. Clear `reserve.txt` to 0
4. Liquidate hacknet hashes (`spend-hacknet-hashes.js --liquidate`)
5. Sell all stocks (`stockmaster.js --liquidate`, loops until no owned stocks)
6. (Optional) upgrade home RAM (`Tasks/ram-manager.js --reserve 0 --budget 0.8`)
7. Accept Stanek's Gift if SF13: `ns.stanek.acceptGift()`
8. Buy augmentations (`faction-manager.js --purchase -v`)
9. Check if any augs were actually bought; abort if none and `--allow-soft-reset` not set
10. Buy home RAM again (if not done in step 6)
11. Buy stock market upgrades: `ns.stock.purchaseWseAccount()`, `ns.stock.purchaseTixApi()`, etc.
12. Buy sleeve augs if SF10: `sleeve.js --reserve 0 --aug-budget 1`
13. Buy gang augmentations if SF2: `gangs.js --reserve 0 --augmentations-budget 1`
14. Buy home cores: loop `while(ns.singularity.upgradeHomeCores())`
15. Join all pending faction invites: `ns.singularity.joinFaction(f)` for each
16. Wait for money to stop decreasing (max 60s, default 2s of stability)
17. Buy any remaining "junk augs" (`faction-manager.js --purchase --stat-desired _`)
18. Clean temp files
19. **THE RESET:** `ns.singularity.installAugmentations(resetScript)` or `ns.singularity.softReset(resetScript)`

After reset, `autopilot.js` is launched as `resetScript` and the loop restarts.

**BN Completion:**
```js
pid = await runCommand(ns, `ns.singularity.destroyW0r1dD43m0n(ns.args[0], ns.args[1])`,
    '/Temp/singularity-destroyW0r1dD43m0n.js', [nextBn, ns.getScriptName()]);
```
autopilot even auto-selects the next BN from a curated `defaultBnOrder` array based on what SFs the player already owns.

---

## Factions

### Decision Logic (`work-for-factions.js`)

Hard-coded priority order:
```js
const preferredEarlyFactionOrder = [
    "Netburners", "Tian Di Hui", "Aevum",
    "Daedalus", "CyberSec", "NiteSec", "Tetrads",
    "Bachman & Associates", "BitRunners", "Fulcrum Secret Technologies", "ECorp",
    "The Black Hand", "The Dark Army", "Clarke Incorporated", "OmniTek Incorporated", "NWO", "Chongqing"
];
```

**Scope system:** Starts at scope 1 (only highest priority factions), expands one level per loop if no work was done. 9 strategies:
1. Priority factions, stop when done with each
2. All priority factions until all have desired rep
3. All megacorps (for invites only)
4. Megacorps + work for their faction after invite
5. All known factions (desired augs only)
6. All factions until donation-unlock rep
7. Grind for most expensive aug in each faction
8. Force-grind rep even with donation unlocked
9. Work for highest-favor faction for NF, else idle crime

**Work type:** `ns.singularity.workForFaction(faction, "hacking")` is prioritized; falls back to "field" for non-hack factions.

**Faction invite prerequisites handled automatically:**
- Karma requirements: `ns.heart.break()` check → `commitCrime()`
- Kill requirements: tracked via `player.numPeopleKilled`
- Combat stat requirements: `crimeForKillsKarmaStats()` with heuristic to skip if mults too low
- Hack level requirements: studies at university
- Backdoor requirements: launches `Tasks/backdoor-all-servers.js` when hack level reached
- Money requirements: skipped (left to other scripts)
- City requirements: `ns.singularity.travelToCity(city)`

**Focus:** `shouldFocus = !options['no-focus'] && hasFocusPenalty` where `hasFocusPenalty = !installedAugmentations.includes("Neuroreceptor Management Implant")`. Once Neuroreceptor is installed, all work runs backgrounded (no focus penalty), gaining dual productivity.

### Crime for Karma/Gang
Uses `crimeForKillsKarmaStats()` which auto-selects crime by success chance:
```js
crime = crimeChances["Homicide"] > 0.75 ? "Homicide" : "Mug"; // early
// Then: Heist > 0.75, Assassination > 0.9, Homicide > 0.5, else Mug
```
Interrupts every 10 min to check higher-priority tasks. Gang faction invite rush starts at Karma <= -40,000.

---

## Augmentations (faction-manager.js)

### Purchase Set Computation

1. Collects all faction augmentation data via Singularity API
2. Filters to "desired" augs (matching `--stat-desired` list; defaults: hacking, faction_rep, company_rep, charisma, hacknet, crime_money)
3. "Priority augs" are always bought first regardless: Red Pill, Blade's Simulacrum, Neuroreceptor Management Implant
4. Propagates desired status to prerequisite augs recursively
5. Determines which are "affordable" considering cascading cost (each aug purchased increases next by `augCountMult = 1.9 * [1, 0.96, 0.94, 0.93][sf11Level]`)

### Purchase Order
```
Priority augs first → desired augs (sorted by rep requirement) → NF levels
```

### Faction Selection per Aug
```js
return (augFactions.filter(f => f.reputation >= this.reputation)[0] || // rep already earned
    augFactions.filter(f => f.donationsUnlocked)
        .sort((a, b) => getReqDonationForAug(this, a) - getReqDonationForAug(this, b))[0] || // cheapest donation
    augFactions.sort((a, b) => b.reputation - a.reputation)[0] || // most rep
    augFactions[0])?.name; // fallback to first in list
```

### Output File
Writes `/Temp/affordable-augs.txt` with full status JSON including: installed/purchased/awaiting install counts, affordable aug names and counts (with/without NF), total costs. This is how `autopilot.js` monitors aug progress without importing faction-manager directly.

---

## Side Engines

### gangs.js — Thread C (Stat-Decidable)
Uses `ns.gang.*` API. Manages combat gang (or hack gang) with:
- Crime assignment: chooses based on wanted-penalty threshold (`wantedPenaltyThreshold = 0.0001`)
- Territory warfare: times warfare windows to align with 20s territory ticks, engages when average win chance > 60%
- Auto-ascending members at configurable multi thresholds (spacing members across threshold)
- Buys equipment/augs from configurable budget percentages
- Training time allocation (default 5%, configurable)
- Requires SF2 + -54K Karma to unlock gang
- Always relevant once in a gang; launched immediately by `autopilot.js` at start of each reset

### sleeve.js — Thread C (Stat-Decidable)
Uses `ns.sleeve.*` API. Per-sleeve assignment logic runs every 1 second:
- Priority 1: Shock recovery if shock > `--min-shock-recovery`
- Priority 2: Homicide for Karma if not in gang yet
- Priority 3: Bladeburner contracts if bladeburner active
- Priority 4: Follow player (sleeve 0 mirrors player faction work if `--disable-follow-player` not set)
- Priority 5: Train at gym to configured stat targets
- Priority 6: Crime (best by stats or configured `--crime`)
Buys sleeve augmentations in batches, respecting `--min-aug-batch` and `--buy-cooldown`.
Requires SF10. Immediately relevant — provides free Karma grind and faction work mirroring.

### bladeburner.js — Thread C (Stat-Decidable, with caveats)
Uses `ns.bladeburner.*` API. Selects best action by:
- Success probability >= `--success-threshold` (0.99)
- Anti-chaos: prefers "Stealth Retirement Operation" when city chaos > 50
- Stamina management: switches to no-stamina actions when stamina < 50%, resumes at 60%
- Skill upgrades: priority-weighted by `costAdjustments` dict (Overclock = 0.8x, Hands of Midas = 10x)
- Limited training (max 50 times — earns no rank)
- Relocates cities to maintain population estimates
Available in BN6/7 without SF, or with SF7. Provides an alternate win condition (Operation Daedalus).

### stanek.js — Thread C (Stat-Decidable)
Uses `ns.stanek.*` API. The most RAM-intensive script:
- Runs at the START of each reset, before daemon.js
- Spawns as many concurrent charging scripts as possible (fills all available home RAM)
- Higher RAM per charge = better charge bonus (^0.07 scaling)
- Stops when all fragments reach `--max-charges` (default 120)
- Checks if close to unlocking Stanek upgrade augs (Awakening at 1M rep, Serenity at 100M) and keeps charging for those
- When done, launches `daemon.js` (passed as `--on-completion-script`)
Requires SF13. Launched by `autopilot.js::checkOnRunningScripts()` if Stanek Genesis aug is installed.

### stockmaster.js — Thread C (Stat-Decidable)
Uses `ns.stock.*` API. Two phases:
- **Pre-4S**: Statistical approach — tracks history, detects 75-tick market cycle via inversion agreement threshold (6 stocks inverting simultaneously = cycle detected), uses near-term (10 ticks) vs long-term (51 ticks) forecast windows, pauses buying 10 ticks before cycle point, holds positions for 10+ ticks to avoid noise
- **Post-4S**: Uses provided probability directly — buy if forecast > 50%+threshold, sell if forecast dips
Configurable `fracH` (cash reserve, default 20%), `fracB` (min liquid before buying, default 40%).
Primary income source early in BN. Explicitly excluded from `reserve.txt` checks (it has its own logic).

---

## Notification / Human-in-Loop

| Situation | Behavior |
|-----------|----------|
| No SF4 | Scripts exit with error messages to terminal; user must do everything manually |
| BN10 sleeve count/memory too low | Warns user, suppresses `destroyW0r1dD43m0n` until fixed |
| Sleeve memory upgrades | No API — logs warning, user must buy manually from The Covenant |
| Reset approaching | `ns.toast("Heads up: Autopilot plans to reset in X", 'info')` popup notification |
| Casino seed money | Reserves $300k in reserve.txt |
| Home RAM too small (8 GB, no SF4) | autopilot shuts itself down with detailed welcome message to new player |
| Daedalus invite close | Liquidates stocks, reserves $100B in reserve.txt, notifies in logs |

---

## Interesting Discoveries

1. **`getNsDataThroughFile` is the entire codebase's architectural spine.** Every singularity call, every faction query, every player stat check goes through this RAM-dodging temp-script mechanism. Understanding it is the key to understanding the whole repo. It costs 1 GB (for ns.run) + the temp script's own 1.6 GB, rather than the full singularity function cost.

2. **`reserve.txt` is a shared coordination signal between all scripts.** Scripts read this file and skip spending money below the threshold. It's written by: autopilot (for aug reserves, stock reserves, Daedalus reserves), casino (casino seed), and ascend (cleared to 0 before install). No formal locking — potential for race conditions in pathological cases.

3. **The BN order in `autopilot.js` is a manually curated priority list** with explicit reasoning for each BN. It can be overridden with `--next-bn` and the auto-selection is based on what SF levels the player already owns.

4. **The `work-for-factions.js` scope system** is elegant: it starts conservative (work for faction 1, then move on), and progressively expands to broader strategies only when narrower ones are exhausted. This ensures the highest-value work is always prioritized without explicit priority queuing.

5. **`augCountMult` (1.9^n cost scaling) is modeled explicitly** in `faction-manager.js`. The simulation of which augs are "affordable" accounts for the cascade cost increase from each aug bought, not just individual aug prices. SF11 directly reduces this multiplier.

6. **Casino DOM automation is surprisingly robust**: it has retry logic, focus-stealing detection, save/reload on bad luck (it reloads the save file if losing too much, via `ns.singularity.softReset()` or game save reload), and restores full state after running.

7. **Daedalus invite management** in autopilot is sophisticated: it monitors net worth (money + stocks), switches daemon to `--xp-only` mode when close to hack requirement, liquidates stocks if close to $100B requirement, and reserves $100B in reserve.txt until invite received.

8. **`work-for-factions.js` is aware of gang status** and completely changes its work mode: before gang = crime-focus mode (Karma grind), after gang = standard faction work mode. autopilot.js kills and restarts it with the right args when gang status changes.

9. **Stanek.js runs BEFORE daemon.js every reset** and intentionally monopolizes all home RAM to maximize charge value. It then passes its completion script args to daemon.js when done.

---

## Copy vs. Build

### COPY (or closely study):

- **`getNsDataThroughFile` RAM-dodge pattern** — essential for SF4 pre-3 play. Consider embedding this as a core utility in our project.
- **`faction-manager.js` aug purchase ordering logic** — the cost-simulation cascade, priority aug propagation, and faction selection per aug are production-quality and correct.
- **`work-for-factions.js` scope/strategy system** — the expanding scope pattern ensures highest-value work without rigid scheduling.
- **`reserve.txt` coordination protocol** — simple, effective shared-memory for cross-script money reservation.
- **`stockmaster.js` pre-4S logic** — the 75-tick market cycle detection and inversion algorithm is the best freely available pre-4S trading system.
- **`autopilot.js` reset threshold logic** — time-decay aug reduction, countdown with extension on new augs, shouldDelayInstall conditions.
- **BN traversal order** — the curated `defaultBnOrder` with rationale is directly useful.

### REBUILD (don't copy directly):

- **`casino.js`** — DOM automation is fragile; game UI updates break it. Also only relevant once per reset cycle.
- **`autopilot.js` main loop** — too many interleaved concerns (daemon management, daedalus monitoring, stock management, reset logic) to cleanly modularize. Better to extract the individual decision functions.
- **`work-for-factions.js` company application logic** — the job stat requirement tables are hardcoded and brittle against game updates.
- **`gangs.js` territory timing** — the territory tick estimation logic (using performance.now timing deltas) is clever but delicate.
- **Script orchestration** — autopilot.js spawns and kills scripts by name in an ad-hoc way. Our project should consider a more formal task/process registry.

### NOTABLE GAPS:

- No corporation automation (`daemon.js` ignores corps entirely by design)
- No IPvGO automation beyond what `go.js` provides (not analyzed here)
- Sleeve memory upgrades require manual user action (no API)
- No formal error recovery for race conditions in `reserve.txt`
