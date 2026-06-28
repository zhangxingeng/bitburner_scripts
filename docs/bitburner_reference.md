# Bitburner API & Mechanics Reference

> Compiled from official [bitburner-src GitHub](https://github.com/bitburner-official/bitburner-src),
> [readthedocs documentation](https://bitburner-beta.readthedocs.io/),
> and [Steam community guides](https://steamcommunity.com/app/1812820/discussions/).
> Game version: ~3.0.x

---

## 1. Netscript Function Reference with RAM Costs

### 1.1 Core Hacking Operations

| Function | RAM Cost | Description |
|---|---|---|
| `hack(host, opts?)` | 0.1 GB | Steal money from a server. Returns money stolen. |
| `grow(host, opts?)` | 0.15 GB | Increase money available on a server. Returns growth multiplier. |
| `weaken(host, opts?)` | 0.15 GB | Reduce a server's security level. Returns amount security decreased. |
| `hackAnalyze(host)` | 0 GB | Get decimal fraction stolen per thread (e.g. 0.03 = 3%). |
| `hackAnalyzeChance(host)` | 0 GB | Get chance of successful hack (0-1). |
| `hackAnalyzeSecurity(threads, host)` | 0 GB | Security increase from N hack threads. |
| `hackAnalyzeThreads(host, hackAmount)` | 0 GB | Threads needed to steal a specific amount. |
| `growthAnalyze(host, multiplier, cores?)` | 0 GB | Threads needed for a growth multiplier. |
| `growthAnalyzeSecurity(threads, host, cores?)` | 0 GB | Security increase from N grow threads. |
| `weakenAnalyze(threads, cores?)` | 0 GB | Security decrease from N weaken threads. |
| `getHackTime(host)` | 0.05 GB | Execution time of `hack()` in ms. |
| `getGrowTime(host)` | 0.05 GB | Execution time of `grow()` in ms. |
| `getWeakenTime(host)` | 0.05 GB | Execution time of `weaken()` in ms. |

### 1.2 Script Execution & Management

| Function | RAM Cost | Description |
|---|---|---|
| `run(script, threadOrOpts?, ...args)` | 1.0 GB | Start script on the **current** server. Returns PID. |
| `exec(script, host, threadOrOpts?, ...args)` | 1.3 GB | Start script on a **specified** server. Returns PID. |
| `spawn(script, threadOrOpts?, ...args)` | 2.0 GB | Terminate current, start new after delay. |
| `kill(pid)` / `kill(filename, host, args?)` | 0.5 GB | Terminate a script. |
| `killall(host)` | 0.5 GB | Kill all scripts on a server. |
| `ps(host?)` | 0.2 GB | List running scripts on a server. |
| `isRunning(script, host, ...args)` | 0.1 GB | Check if a specific script is running. |
| `scriptRunning(script, host)` | 1.0 GB | Check if any instance of a script is running. |
| `scriptKill(script, host)` | 1.0 GB | Kill all instances of a script. |
| `getScriptName()` | 0 GB | Current script's filename. |
| `getScriptRam(script, host?)` | 0.1 GB | RAM required by a script. |
| `getScriptIncome(script?, host?, ...args?)` | 0.1 GB | Script income rate. |
| `getScriptExpGain(script?, host?, ...args?)` | 0.1 GB | Script exp gain rate. |
| `getRunningScript(filename?, host?, ...args?)` | 0.3 GB | Get detailed info about a running script. |
| `getRecentScripts()` | 0 GB | Get recently killed scripts. |
| `getSharePower()` | 0 GB | Share power for faction rep. |
| `share()` | 4.0 GB | Share RAM with factions for rep gain. |
| `exit()` | 0 GB | Terminate current script immediately. |
| `sleep(millis)` | 0 GB | Suspend script for N ms. |
| `asleep(millis)` | 0 GB | Non-blocking sleep. |
| `atExit(f, id?)` | 0 GB | Register callback on script death. |

### 1.3 Server Information

| Function | RAM Cost | Description |
|---|---|---|
| `scan(host?, returnOpts?)` | 0.2 GB | List all servers connected to a server. |
| `getServer(host)` | 0.3 GB | Get full Server object (for formulas API). |
| `getServerMoneyAvailable(host)` | 0.1 GB | Current money on server. |
| `getServerMaxMoney(host)` | 0.1 GB | Max possible money on server. |
| `getServerSecurityLevel(host)` | 0.1 GB | Current security level. |
| `getServerMinSecurityLevel(host)` | 0.1 GB | Minimum security level. |
| `getServerBaseSecurityLevel(host)` | 0.1 GB | Base security level (deprecated). |
| `getServerGrowth(host)` | 0.1 GB | Server growth parameter. |
| `getServerRequiredHackingLevel(host)` | 0.1 GB | Required hacking level. |
| `getServerNumPortsRequired(host)` | 0.1 GB | Ports needed for NUKE. |
| `getServerMaxRam(host)` | 0.1 GB | Total RAM on server. |
| `getServerUsedRam(host)` | 0.1 GB | Used RAM on server. |
| `hasRootAccess(host)` | 0.05 GB | Check root access. |
| `serverExists(host)` | 0.1 GB | Check if server exists. |
| `getHostname()` | 0.05 GB | Current server hostname. |
| `getHackingLevel()` | 0.05 GB | Player's hacking level. |
| `getHackingMultipliers()` | 4.0 GB | Player's hacking multipliers. |
| `getHacknetMultipliers()` | 4.0 GB | Hacknet multipliers. |
| `getPlayer()` | 0.3 GB | Full player object. |
| `getBitNodeMultipliers(n, lvl?)` | 4.0 GB | BitNode multipliers (requires SF-5). |
| `getResetInfo()` | 0 GB | Info about last augmentation install. |
| `getMoneySources()` | 0 GB | Money source breakdown. |
| `getFavorToDonate()` | 0.1 GB | Favor needed to donate to faction. |
| `hasTorRouter()` | 0 GB | Check darkweb access. |

### 1.4 Port Opening / NUKE (All 0 GB RAM)

| Function | Required Program | Effect |
|---|---|---|
| `brutessh(host)` | BruteSSH.exe | Opens SSH port |
| `ftpcrack(host)` | FTPCrack.exe | Opens FTP port |
| `relaysmtp(host)` | relaySMTP.exe | Opens SMTP port |
| `httpworm(host)` | HTTPWorm.exe | Opens HTTP port |
| `sqlinject(host)` | SQLInject.exe | Opens SQL port |
| `nuke(host)` | NUKE.exe | Gains root access (requires enough open ports) |

### 1.5 File & Port Operations

| Function | RAM Cost | Description |
|---|---|---|
| `scp(files, destination, source?)` | 0.6 GB | Copy files between servers. |
| `ls(host?, substring?)` | 0 GB | List files on server. |
| `rm(name, host?)` | 1.0 GB | Delete a file. |
| `mv(host, source, dest)` | 0 GB | Move/rename file. |
| `read(filename)` | 1.0 GB | Read file content. |
| `write(filename, data, mode?)` | 1.0 GB | Write to file. |
| `clear(handle)` | 1.0 GB | Clear file or port. |
| `fileExists(filename, host?)` | 0 GB | Check if file exists. |
| `wget(url, target, host?)` | 0 GB | Download file from URL (async). |
| `readPort(port)` | 0 GB | Read from port (consumes data). |
| `writePort(port, data)` | 0 GB | Write to port (blocks if full). |
| `tryWritePort(port, data)` | 0 GB | Write to port (non-blocking). |
| `peek(port)` | 0 GB | Peek at port without consuming. |
| `clearPort(port)` | 0 GB | Clear entire port. |
| `getPortHandle(port)` | 10.0 GB | Get port handle object (NS2 only). |
| `nextPortWrite(port)` | 0 GB | Wait/async-listen for port write. |

### 1.6 Server Purchasing

| Function | RAM Cost | Description |
|---|---|---|
| `getPurchasedServerCost(ram)` | 0.25 GB | Cost for a purchased server (use this, not formula). |
| `purchaseServer(name, ram)` | 2.25 GB | Purchase a new server. Returns hostname or "". |
| `deleteServer(name)` | 2.25 GB | Delete a purchased server. |
| `getPurchasedServers()` | 2.25 GB | List all purchased servers. |
| `getPurchasedServerLimit()` | 0.05 GB | Max purchasable servers (default 25). |
| `getPurchasedServerMaxRam()` | 0.05 GB | Max RAM for purchased servers (default 2^20 = 1,048,576 GB). |

### 1.7 Logging & Output (All 0 GB unless noted)

| Function | Description |
|---|---|
| `print(...args)` | Print to script log. |
| `tprint(...args)` | Print to Terminal. |
| `printf(format, ...args)` | Formatted print to log. |
| `tprintf(format, ...args)` | Formatted print to Terminal. |
| `disableLog(fn)` | Disable logging for a function. |
| `enableLog(fn)` | Re-enable logging. |
| `isLogEnabled(fn)` | Check log status. |
| `getScriptLogs(fn?, host?, ...args?)` | Get script log content. |
| `clearLog()` | Clear script log. |
| `toast(msg, variant?, duration?)` | Toast notification (bottom-right). |
| `alert(msg)` | Open message box. |
| `prompt(txt, options?)` | Prompt user input. |

### 1.8 Formatting & Utility (All 0 GB)

| Function | Description |
|---|---|
| `sprintf(format, ...args)` | Format string (C-style). |
| `vsprintf(format, args)` | Format string with array. |
| `flags(schema)` | Parse CLI flags. |
| `getFunctionRamCost(name)` | Get RAM cost of any function. |
| `ramOverride(ram)` | Override script static RAM. |

---

## 2. Singularity API (`ns.singularity.*`)

### Availability
Requires **Source-File 4 (BitNode-4: The Singularity)** at level 1. Each level of SF-4 reduces the RAM cost of Singularity functions. Without SF-4, Singularity functions are unavailable outside BitNode-4.

### Level 1 Functions (Basic Player Interaction)

| Function | Description |
|---|---|
| `universityCourse(university, course)` | Take a course at a university. |
| `gymWorkout(gymName, stat)` | Work out at a gym to train a stat. |
| `travelToCity(cityName)` | Travel to a different city ($200k cost). |
| `purchaseTor()` | Buy TOR router ($200k) for darkweb access. |
| `purchaseProgram(programName)` | Buy a program from the darkweb. |
| `getStats()` | Get player stats object (deprecated, use `getPlayer()`). |
| `getCharacterInformation()` | Detailed character info (deprecated). |
| `isBusy()` | Check if player is doing an action. |
| `stopAction()` | Stop current action and collect earnings. |

### Level 2 Functions (Factions & Companies)

| Function | Description |
|---|---|
| `upgradeHomeRam()` | Upgrade home computer RAM (doubles it). |
| `getUpgradeHomeRamCost()` | Get cost for next RAM upgrade. |
| `upgradeHomeCores()` | Upgrade home computer CPU cores. |
| `getUpgradeHomeCoresCost()` | Get cost for next cores upgrade. |
| `workForCompany(companyName)` | Work for a company (earns money + rep). |
| `applyToCompany(companyName, field)` | Apply for job/promotion at a company. |
| `getCompanyRep(companyName)` | Get company reputation. |
| `getCompanyFavor(companyName)` | Get company favor. |
| `getCompanyFavorGain(companyName)` | Favor gain on reset. |
| `checkFactionInvitations()` | Get outstanding faction invites. |
| `joinFaction(name)` | Accept faction invitation. |
| `workForFaction(factionName, workType)` | Work for a faction (rep + exp). |
| `getFactionRep(factionName)` | Get faction reputation. |
| `getFactionFavor(factionName)` | Get faction favor. |
| `getFactionFavorGain(factionName)` | Faction favor gain on reset. |

### Level 3 Functions (Advanced)

| Function | Description |
|---|---|
| `donateToFaction(factionName, amount)` | Donate money for reputation (10k rep per $1M at 150 favor). |
| `createProgram(programName)` | Create a program manually. |
| `commitCrime(crime)` | Commit a crime. Returns success boolean + earnings. |
| `getCrimeChance(crime)` | Get success chance for a crime. |
| `getOwnedAugmentations(purchased?)` | List owned augmentations. |
| `getOwnedSourceFiles()` | List owned source files. |
| `getAugmentationsFromFaction(facName)` | Faction's available augmentations. |
| `getAugmentationPrereq(augName)` | Prerequisites for an augmentation. |
| `getAugmentationCost(augName)` | Cost of an augmentation. |
| `purchaseAugmentation(factionName, augName)` | Buy an augmentation. |
| `installAugmentations(cbScript?)` | Install augmentations and reset. Optional callback script runs after install. |
| `softReset(cbScript)` | Soft reset (no aug install). |
| `b1tflum3()` | Destroy current BitNode and go to next. |
| `getCurrentServer()` | Get current server hostname. |
| `connect(host)` | Connect to a server (Terminal simulation). |
| `manualHack()` | Manual hack (like typing `hack` in Terminal). |
| `installBackdoor()` | Install a backdoor on the current server. |

---

## 3. Formulas API (`ns.formulas.*`)

### Availability
Requires **Formulas.exe** (purchased from **darkweb for ~$5 billion** after obtaining SF-5, or automatically unlocked with SF-5 level 1).

### Usage
All functions require **Server** and **Player objects** (not strings).

```js
const server = ns.getServer("n00dles");
const player = ns.getPlayer();
```

### 3.1 Hacking Formulas (`ns.formulas.hacking.*`)

| Function | Signature | Returns |
|---|---|---|
| `hackTime(server, player)` | `(Server, Player) => number` | Hack time in **seconds** |
| `growTime(server, player)` | `(Server, Player) => number` | Grow time in seconds |
| `weakenTime(server, player)` | `(Server, Player) => number` | Weaken time in seconds |
| `hackChance(server, player)` | `(Server, Player) => number` | Success probability (0-1) |
| `hackPercent(server, player)` | `(Server, Player) => number` | Fraction stolen per thread |
| `growPercent(server, threads, player, cores?)` | `(Server, number, Player, number?) => number` | Growth multiplier per thread |
| `growAmount(server, player, threads, cores?)` | `(Server, Player, number, number?) => number` | Absolute growth amount |
| `hackExp(server, player)` | `(Server, Player) => number` | Hacking exp per thread |
| `growSecurity(threads, host, cores?)` | `(number, Server, number?) => number` | Security increase from grow |
| `hackSecurity(threads, host)` | `(number, Server) => number` | Security increase from hack |
| `weakenSecurity(threads, host)` | `(number, Server) => number` | Security decrease from weaken |

**Pro tip**: Modify the server object to calculate values at ideal states:

```js
server.hackDifficulty = server.minDifficulty; // theoretical minimum security
const bestTime = ns.formulas.hacking.hackTime(server, ns.getPlayer());
```

### 3.2 Hacknet Formulas (`ns.formulas.hacknetServers.*`)
- `hashGainRate(level, ram, cores, mult)` -- Hash production rate.
- `hashUpgradeCost(level, mult)` -- Cost for hash upgrade.
- `hacknetNodeCost(level, ram, cores)` -- Cost to purchase.
- `hacknetNodeLevelCost(base, level, mult)` -- Level upgrade cost.
- `hacknetNodeRamCost(base, ram, mult)` -- RAM upgrade cost.
- `hacknetNodeCoreCost(base, cores, mult)` -- Core upgrade cost.

### 3.3 Gang Formulas (`ns.formulas.gang.*`)
- `wantedPenalty(gang)` -- Wanted level penalty multiplier.
- `respectGain(gang, member, task)` -- Respect gain rate.

### 3.4 Work Formulas (`ns.formulas.work.*`)
- `crimeGains(crimeType, player, focus?)` -- Crime earnings/exp.
- `classGains(player, classType, locationName)` -- Class earnings/exp.
- `factionGains(player, workType, favor)` -- Faction work gains.

### 3.5 Skills & Reputation (`ns.formulas.skills.*`, `ns.formulas.reputation.*`)
- `calculateSkill(exp, mult)` -- Skill level from exp.
- `calculateExp(skill, mult)` -- Exp needed for skill level.
- `repFromDonation(amount, player)` -- Reputation from donation.
- `donationFromRep(rep, player)` -- Donation needed for rep.

### 3.6 Bladeburner Formulas (`ns.formulas.bladeburner.*`)
- Various formulas for Bladeburner action times, success chances, etc.

### 3.7 Mock Objects (`ns.formulas.mockServer()`, `ns.formulas.mockPlayer()`)
Create empty stub objects for theoretical calculations. All properties default to 0 or empty -- you must fill in values manually.

---

## 4. Hacknet API (`ns.hacknet.*`)

| Function | Description |
|---|---|
| `numNodes()` | Number of Hacknet Nodes owned |
| `purchaseNode()` | Purchase a new node |
| `getPurchaseNodeCost()` | Cost of purchasing a node |
| `getNodeStats(i)` | Stats of node `i` |
| `upgradeLevel(i, n)` | Upgrade node level by n |
| `upgradeRam(i, n)` | Upgrade node RAM by n |
| `upgradeCore(i, n)` | Upgrade node cores by n |
| `upgradeCache(i, n)` | Upgrade node cache |
| `getLevelUpgradeCost(i, n)` | Cost to upgrade level by n |
| `getRamUpgradeCost(i, n)` | Cost to upgrade RAM by n |
| `getCoreUpgradeCost(i, n)` | Cost to upgrade cores by n |
| `getCacheUpgradeCost(i, n)` | Cost to upgrade cache by n |
| `numHashes()` | Number of hashes (Hacknet Servers only) |
| `hashCost(upgName)` | Hash cost for upgrade |
| `spendHashes(upgName, ...args)` | Spend hashes on upgrade |
| `getHashUpgrades()` | List of available hash upgrades |
| `getHashUpgradeLevel(upgName)` | Level of a hash upgrade |
| `getStudyMult()` | Multiplier from studying |
| `getTrainingMult()` | Multiplier from training |

---

## 5. Stock Market API (`ns.stock.*`)

| Function | RAM | Description |
|---|---|---|
| `getSymbols()` | 2 GB | Stock market symbols |
| `getPrice(sym)` | 2 GB | Stock price |
| `getPosition(sym)` | 2 GB | Long & short positions |
| `getMaxShares(sym)` | 2 GB | Maximum purchasable shares |
| `getPurchaseCost(sym, shares, posType)` | 2 GB | Cost to buy shares |
| `getSaleGain(sym, shares, posType)` | 2 GB | Proceeds from sale |
| `buyStock(sym, shares)` | 2.5 GB | Buy shares (long) |
| `sellStock(sym, shares)` | 2.5 GB | Sell shares (long) |
| `shortStock(sym, shares)` | 2.5 GB | Short a stock |
| `sellShort(sym, shares)` | 2.5 GB | Sell short position |
| `placeOrder(sym, shares, price, type, pos)` | 2.5 GB | Limit/stop order |
| `cancelOrder(sym, shares, price, type, pos)` | 2.5 GB | Cancel order |
| `getOrders()` | 2.5 GB | All outstanding orders |
| `getVolatility(sym)` | 2.5 GB | Volatility (requires 4S API) |
| `getForecast(sym)` | 2.5 GB | Probability of price increase (requires 4S API) |
| `purchase4SMarketData()` | 2.5 GB | Buy 4S Market Data ($1b) |
| `purchase4SMarketDataTixApi()` | 2.5 GB | Buy 4S Market Data TIX API ($25b) |

---

## 6. Port Openers & Server Nuking

### Programs Required

| Program | How to Obtain | Opens |
|---|---|---|
| **BruteSSH.exe** | Create (10 min) or buy from darkweb ($?k) | SSH port |
| **FTPCrack.exe** | Create or buy from darkweb | FTP port |
| **relaySMTP.exe** | Create or buy from darkweb | SMTP port |
| **HTTPWorm.exe** | Create or buy from darkweb | HTTP port |
| **SQLInject.exe** | Create or buy from darkweb | SQL port |
| **NUKE.exe** | Create or buy from darkweb | Root access (requires N open ports) |

### Port Requirements by Server Tier

| Ports Required | Example Servers | Typical Max Money |
|---|---|---|
| 0 | `foodnstuff`, `sigma-cosmetics`, `joesguns`, `nectar-net`, `hong-fang-tea`, `harakiri-sushi` | ~1-4M |
| 1 | `neo-net`, `zer0`, `max-hardware`, `iron-gym` | ~10-30M |
| 2 | `phantasy`, `silver-helix`, `omega-net`, `crush-fitness` | ~50-100M |
| 3 | `the-hub`, `johnson-ortho`, `snap-fitness`, `rothman-uni` | ~250-500M |
| 4 | `omnitek`, `unitalife`, `taiyang-digital`, `defcomm` | ~1-10B |
| 5 | `ecorp`, `megacorp`, `fulcrumtech`, `kuai-gong`, `nwo`, `blade` | ~15-250B |

**Key points:**
- Hacking level does NOT matter for nuking -- only port count matters.
- Check with `ns.getServerNumPortsRequired(host)` and `ns.getServerRequiredHackingLevel(host)`.

### Nuking Pattern

```js
const programs = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
const functions = [ns.brutessh, ns.ftpcrack, ns.relaysmtp, ns.httpworm, ns.sqlinject];
let open = 0;
for (let i = 0; i < programs.length; i++) {
  if (ns.fileExists(programs[i], "home")) {
    functions[i](target);
    open++;
  }
}
if (open >= ns.getServerNumPortsRequired(target)) {
  ns.nuke(target);
}
```

---

## 7. Hacking Formulas (Mathematical)

### 7.1 Hack Time

```js
difficultyMult = server.minDifficulty / 75
hackTime = difficultyMult * 4000 * Math.pow(1 + server.requiredHackingSkill / 32, 1 - player.hacking / server.requiredHackingSkill)
```

- **Result**: Seconds (multiply by 1000 for ms).
- **Key insight**: When `player.hacking >> server.requiredHackingSkill`, `hackTime` approaches a floor of `difficultyMult * 4000` ms.

### 7.2 Grow Time

```js
growTime = 3.2 * hackTime(server, player)
```

Always exactly **3.2x** the hack time.

### 7.3 Weaken Time

```js
weakenTime = 4 * hackTime(server, player)
```

Always exactly **4x** the hack time. This is the longest of the three operations -- the timing bottleneck.

### 7.4 Hack Chance

```js
hackChance = (player.hacking - server.requiredHackingSkill + 25) / (player.hacking + 25)
```

- **Min**: 0 (when `player.hacking <= server.requiredHackingSkill - 25`)
- **Max**: Capped at 1.0 (100% chance)
- **Example**: Player level 50, server requires 20: `(50 - 20 + 25) / (50 + 25) = 55/75 = 73.3%`

### 7.5 Hack Percent (Money Stolen Per Thread)

```js
difficultyMult = server.minDifficulty / 75
hackPercent = (1.5 * difficultyMult * (player.hacking - server.requiredHackingSkill + 25)) / (server.requiredHackingSkill + 25) / 100
```

- Returns a decimal (e.g. 0.12 = 12% of available money per thread).
- Scaled linearly with threads.
- Multiplied by `player.hackingMoneyMult` and `bitNodeHackingMoneyMult`.

### 7.6 Grow Percent (Growth Multiplier Per Thread)

```js
difficultyMult = server.minDifficulty / 75
baseFactor = server.serverGrowth / 100
skillFactor = 0.5 + 0.5 * player.hacking / server.requiredHackingSkill
coreBonus = 1 + (cores - 1) / 16

growPercent = Math.pow(baseFactor, skillFactor * player.hackingGrowMult * bitNodeGrowMult * coreBonus)
```

- Each `grow()` thread multiplies available money by `growPercent`.
- With N threads: `money * growPercent^N`.
- Server growth caps at ~4.0 per thread (when `serverGrowth = 400` and level is high).

### 7.7 Security Changes

| Action | Change per Thread |
|---|---|
| `hack()` | +0.002 |
| `grow()` | +0.004 |
| `weaken()` | -0.05 |

**Balance ratio**: For every hack thread, you need 0.002/0.05 = 0.04 weaken threads. For every grow thread, 0.004/0.05 = 0.08 weaken threads.

### 7.8 Hacking Experience (per thread)

```js
hackExp = (3 + server.minDifficulty / 1.5) * player.hackingExpMult * bitNodeHackingExpMult
```

- Modified by all hacking experience multipliers.

---

## 8. Source-Files (SF) & Their Bonuses

Source-Files are persistent upgrades earned by destroying (completing) a BitNode. Each can be leveled to a maximum of **level 3** (except SF-12), with higher levels providing stronger bonuses.

### SF-1: Source Genesis
| Level | Bonus |
|---|---|
| L1 | Home starts with 32 GB RAM; all multipliers +16% |
| L2 | All multipliers +24% |
| L3 | All multipliers +28% |

### SF-2: Rise of the Underworld
| Level | Bonus |
|---|---|
| L1 | Unlocks **Gangs** in other BitNodes; crime +24% |
| L2 | Crime +36% |
| L3 | Crime +42% |

### SF-3: Corporatocracy
| Level | Bonus |
|---|---|
| L1 | Unlocks **Corporations** in other BitNodes; cha/salary +8% |
| L2 | Cha/salary +12% |
| L3 | Cha/salary +14% |

### SF-4: The Singularity
| Level | Bonus |
|---|---|
| L1 | Unlocks **Singularity API** in other BitNodes; reduced RAM cost |
| L2 | Further reduced Singularity RAM costs |
| L3 | Maximum Singularity RAM cost reduction |

### SF-5: Artificial Intelligence
| Level | Bonus |
|---|---|
| L1 | Unlocks **Intelligence** stat; unlocks `getBitNodeMultipliers()`; starts each BitNode with **Formulas.exe**; hacking multipliers +8% |
| L2 | Hacking multipliers +12% |
| L3 | Hacking multipliers +14% |

### SF-6: Bladeburners
| Level | Bonus |
|---|---|
| L1 | Unlocks **Bladeburner** in other BitNodes; combat multipliers +8% |
| L2 | Combat multipliers +12% |
| L3 | Combat multipliers +14% |

### SF-7: Bladeburners 2079
| Level | Bonus |
|---|---|
| L1 | Unlocks **Bladeburner API** in other BitNodes; BB multipliers +8% |
| L2 | BB multipliers +12% |
| L3 | BB multipliers +14% |

### SF-8: Ghost of Wall Street
| Level | Bonus |
|---|---|
| L1 | Permanent WSE + TIX API access; hacking growth +12% |
| L2 | Permanent shorting access; hacking growth +18% |
| L3 | Permanent limit/stop orders; hacking growth +21% |

### SF-9: Hacktocracy
| Level | Bonus |
|---|---|
| L1 | Unlocks **Hacknet Server** in other BitNodes |
| L2 | Start with **128 GB** home RAM |
| L3 | Receive a highly-upgraded Hacknet Server on entering a new BitNode |

### SF-10: Digital Carbon
| Level | Bonus |
|---|---|
| L1 | +1 **Duplicate Sleeve**; unlocks **Sleeve API** |
| L2 | +2 sleeves total |
| L3 | +3 sleeves total; unlocks **Grafting API** in other BitNodes |

### SF-11: The Big Crash
| Level | Bonus |
|---|---|
| L1 | Company favor boosts salary AND rep (normally just rep); salary/rep +32% |
| L2 | Salary/rep +48% |
| L3 | Salary/rep +56% |

### SF-12: The Recursion
| Bonus | Details |
|---|---|
| Unlimited levels | Start each new BitNode with a [NeuroFlux Governor] equal to SF-12 level |

### SF- (-1): Exploits
| Bonus | Source |
|---|---|
| All multipliers +0.1% per level (max level 8) | Secret/exploit-based |

---

## 9. Home Computer & Server Costs

### 9.1 Home Computer RAM Upgrades

**Starting RAM**: 8 GB (varies by SF-1/SF-9 bonuses).
**Max RAM**: 2^30 GB = 1,073,741,824 GB (1 petabyte).
**Upgrade effect**: RAM doubles each upgrade (8->16->32->64->128->...).

**Cost formula** (from source):
```ts
currentRam = homeComputer.maxRam
numUpgrades = Math.log2(currentRam)          // number of doublings from 8GB
mult = Math.pow(1.58, numUpgrades)
cost = currentRam * 32000 * mult * currentNodeMults.HomeComputerRamCost
```

Where `BaseCostFor1GBOfRamHome = 32000`.

**Example costs** (no BitNode multiplier):

| Current RAM | Next RAM | Approx Cost |
|---|---|---|
| 8 GB | 16 GB | ~$405k |
| 16 GB | 32 GB | ~$1.28M |
| 32 GB | 64 GB | ~$4.04M |
| 64 GB | 128 GB | ~$12.8M |
| 128 GB | 256 GB | ~$40.4M |
| 256 GB | 512 GB | ~$128M |
| 512 GB | 1,024 GB | ~$404M |
| 1,024 GB (1 TB) | 2,048 GB | ~$1.28B |
| 2,048 GB (2 TB) | 4,096 GB | ~$4.04B |
| 4,096 GB (4 TB) | 8,192 GB | ~$12.8B |

### 9.2 Home Computer Core Upgrades

**Starting cores**: 1.
**Max cores**: 8.
**Cost formula**: `1e9 * Math.pow(7.5, cpuCores)`.

| Current Cores | Cost |
|---|---|
| 1 -> 2 | ~$7.5B |
| 2 -> 4 | ~$56.25B |
| 4 -> 8 | ~$4.2T |

### 9.3 Purchased Server Costs

**Formula** (use `ns.getPurchasedServerCost(ram)` -- not hardcoded):
```ts
baseCost = 55000
cost = baseCost * ram = 55000 * Math.pow(2, level)
```

| RAM (GB) | Cost | Level |
|---|---|---|
| 2 | $110k | 1 |
| 8 | $440k | 3 |
| 32 | $1.76M | 5 |
| 64 | $3.52M | 6 |
| 128 | $7.04M | 7 |
| 256 | $14.08M | 8 |
| 512 | $28.16M | 9 |
| 1,024 (1 TB) | $56.32M | 10 |
| 2,048 (2 TB) | $112.64M | 11 |
| 4,096 (4 TB) | $225.28M | 12 |
| 8,192 (8 TB) | $450.56M | 13 |
| 16,384 (16 TB) | $901.12M | 14 |
| 32,768 (32 TB) | $1.8B | 15 |
| 65,536 (64 TB) | $3.6B | 16 |
| 131,072 (128 TB) | $7.2B | 17 |
| 262,144 (256 TB) | $14.4B | 18 |
| 524,288 (512 TB) | $28.8B | 19 |
| 1,048,576 (1 PB) | $57.7B | 20 |

**Limits**:
- Max 25 purchased servers (configurable per BitNode).
- Max RAM per purchased server: 1,048,576 GB (2^20).

---

## 10. Additional APIs (Overview)

### 10.1 Gang API (`ns.gang.*`)
Available after joining a gang faction (requires BitNode 2 or SF-2).
- Create/manage gang members, assign tasks, buy equipment, ascend members.
- Territory warfare against other gangs.

### 10.2 Bladeburner API (`ns.bladeburner.*`)
Available after joining Bladeburner division (requires BitNode 6-7 or SF-6-7).
- Contracts, operations, Black Ops, skills, team management.
- City-to-city movement, stamina management.

### 10.3 Sleeve API (`ns.sleeve.*`)
Available after obtaining SF-10.
- Manage duplicate sleeves (up to 3).
- Assign sleeves to crimes, faction work, company work, study, or gym.
- Synchronize sleeves, purchase sleeve augmentations.

### 10.4 Corporation API (`ns.corporation.*`)
Available after joining a corporation (requires BitNode 3 or SF-3).
- Full corporation management: divisions, products, warehouses, materials, R&D.
- IPO, stocks, bonuses, and more.

### 10.5 Coding Contract API (`ns.codingcontract.*`)
- `attempt(answer, fn, host, opts?)` -- Submit solution.
- `getContractType(fn, host)` -- Get problem type.
- `getDescription(fn, host)` -- Get full description.
- `getData(fn, host)` -- Get contract data.
- `getNumTriesRemaining(fn, host)` -- Remaining attempts.

### 10.6 Grafting API (`ns.grafting.*`)
Available after SF-10 L3 (VitaLife secret lab access).
- `getGraftableAugmentations()` -- List graftable augs.
- `getGraftingCost(augName)` -- Cost to graft.
- `getGraftingTime(augName)` -- Time to graft.
- `graftAugmentation(augName)` -- Start grafting process.

### 10.7 Stanek's Gift API (`ns.stanek.*`)
- Charge, fragment management for the gift.

### 10.8 Go API (`ns.go.*`)
- Play the game of Go on the world stock exchange.

### 10.9 Dark Web / Darknet API
- `darkweb` and related purchases.

### 10.10 Infiltration API (`ns.infiltration.*`)
- `getInfiltration(host)` -- Get location data.
- `getPossibleInfiltrationLocations()` -- All infiltration locations.

### 10.11 User Interface API (`ns.ui.*`)
- `openTail(pid)` -- Open tail window.
- `closeTail(pid)` -- Close tail window.
- `setTitle(pid, title)` -- Set tail window title.
- `update` -- Update UI components.
- `getTheme()` / `setTheme(theme)` -- Theme management.
- `getStyles()` / `setStyles(styles)` -- Style management.
- `isFocused()` / `getGameInfo()` -- Game state info.

---

## 11. Game Mechanics Summary

### Key Formulas Reference

| Value | Formula |
|---|---|
| Hack time | `(minDiff/75) * 4000 * (1 + reqSkill/32)^(1 - playerHack/reqSkill)` sec |
| Grow time | `3.2 * hackTime` |
| Weaken time | `4 * hackTime` |
| Hack chance | `(playerHack - reqSkill + 25) / (playerHack + 25)` (capped at 1.0) |
| Hack percent | `(1.5 * diffMult * (playerHack - reqSkill + 25)) / (reqSkill + 25) / 100` |
| Grow percent | `(growth/100) ^ (skillFactor * growMult * BNmult * coreBonus)` per thread |
| Hack exp | `(3 + minDiff/1.5) * expMult` per thread |
| Hack security | `+0.002` per thread |
| Grow security | `+0.004` per thread |
| Weaken security | `-0.05` per thread |

### Multiplier Stacking
All percentage bonuses stack **multiplicatively**:
- Augmentations provide the largest multiplier bonuses.
- Source-Files provide per-BitNode global bonuses.
- BitNode multipliers can penalize or boost specific mechanics.

### Batch Hacking Guidelines
- **Maximum safe batch size**: ~1,500-2,000 threads total (above this, timing windows collapse).
- **Timing order**: Weaken first (longest), then grow, then hack (shortest).
- **Delay between phases**: ~20-100ms depending on player latency.
- **Security budget**: For optimal money, keep server at `minSecurity`. Each hack costs 0.002 security to fix; each grow costs 0.004.

---

## Sources

- [Bitburner source code (GitHub)](https://github.com/bitburner-official/bitburner-src)
- [Official readthedocs documentation](https://bitburner-beta.readthedocs.io/en/latest/)
- [DeepWiki: Alain Bryden's scripts](https://deepwiki.com/alainbryden/bitburner-scripts/)
- [Steam Community Guides](https://steamcommunity.com/app/1812820/discussions/)
- [Readthedocs fork (older)](https://bitburner-fork-oddiz.readthedocs.io/en/stable/)
