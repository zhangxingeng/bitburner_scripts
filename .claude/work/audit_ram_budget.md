# Audit Report: Wave 4 Strategy Engine — RAM Budget & Deployment Feasibility

**Auditor:** Cold audit, adversarial stance
**Date:** 2026-06-28
**Source:** Section 4.5 of `continuous_improvement.md`
**Reference:** `bitburner_reference.md` (verified RAM costs)
**Cross-checked against:** `game_agent.ts` (source), `game_agent.js` (compiled dist), `status_reporter.ts`, `network.ts`

---

## 1. RAM Cost Verification — Function-by-Function

**Method:** Every `ns.*` function cited in the plan was looked up in `bitburner_reference.md` section 1.

### State Snapshot Functions

| Function | Plan Claim | Reference Doc | Verdict |
|---|---|---|---|
| `getServer(host)` | 0.3 GB | 0.3 GB | MATCH |
| `getPlayer()` | 0.3 GB | 0.3 GB | MATCH |
| `scan(host)` | 0.2 GB | 0.2 GB | MATCH |
| `fileExists(f)` | 0 GB | 0 GB | MATCH |
| `getHackingLevel()` | 0.05 GB | 0.05 GB | MATCH |
| **Subtotal** | **~0.85 GB** | **0.85 GB** | MATCH |

### Action Execution Functions

| Function | Plan Claim | Reference Doc | Verdict |
|---|---|---|---|
| `run(script, ...)` | 1.0 GB | 1.0 GB | MATCH |
| `exec(script, host, ...)` | 1.3 GB | 1.3 GB | MATCH |
| `scp(files, dest, source?)` | 0.6 GB | 0.6 GB | MATCH |
| `scriptKill(script, host)` | 1.0 GB | 1.0 GB | MATCH |
| `kill(pid)` | 0.5 GB | 0.5 GB | MATCH |
| `read(filename)` | 1.0 GB | 1.0 GB | MATCH |
| `write(filename, ...)` | 1.0 GB | 1.0 GB | MATCH |
| `rm(name, host?)` | 1.0 GB | 1.0 GB | MATCH |
| `sleep(millis)` | 0 GB | 0 GB | MATCH |
| `print(...)` | 0 GB | 0 GB | MATCH |
| `disableLog(fn)` | 0 GB | 0 GB | MATCH |

### Port Openers (all 0 GB)

`brutessh`, `ftpcrack`, `relaysmtp`, `httpworm`, `sqlinject`, `nuke` — all verified 0 GB. MATCH.

### Individual Getters (the optimization baseline)

| Getter | Plan Claim | Reference Doc | Verdict |
|---|---|---|---|
| `getServerMaxRam` | 0.1 GB | 0.1 GB | MATCH |
| `getServerUsedRam` | 0.1 GB | 0.1 GB | MATCH |
| `getServerMaxMoney` | 0.1 GB | 0.1 GB | MATCH |
| `getServerRequiredHackingLevel` | 0.1 GB | 0.1 GB | MATCH |
| `getServerMinSecurityLevel` | 0.1 GB | 0.1 GB | MATCH |
| `hasRootAccess` | 0.05 GB | 0.05 GB | MATCH |
| **Total** | **0.55 GB** | **0.55 GB** | MATCH |

**Verdict on function costs:** All individual function costs in the plan are verified correct. No discrepancies at the single-function level.

---

## 2. Two-Tier Architecture Feasibility

### 2.1 The Critical Problem: Boot Agent RAM Estimate

The plan claims `boot_agent.ts` costs **~3.3 GB** with functions: `run`, `exec`, `read`, `write`, `rm`, `fileExists`, `sleep`.

**Reality check — summing just the non-zero function costs:**
```
run(1.0) + exec(1.3) + read(1.0) + write(1.0) + rm(1.0) = 5.3 GB
```

Even **before** adding any base script cost, the function costs alone total 5.3 GB. The plan's estimate of 3.3 GB is off by **2.0 GB (61% error)** against the raw function sum. The plan never defines what the "base script cost" is, just mentions "~1.6 GB" elsewhere without attribution.

**Possible ways to reach 3.3 GB:**
- Drop `exec` (1.3 GB) and `rm` (1.0 GB): `run + read + write + fileExists = 3.0 GB` → Then ~0.3 GB overhead to reach 3.3 GB. **But** the plan explicitly lists both `exec` and `rm` in the boot agent's function set. This contradicts.
- If the plan envisions the boot agent as a pure file-polling relay (`read`, `write`, `rm`, `fileExists`, no `run`/`exec`), that would be 3.0 GB + overhead. **But** then the boot agent could not run anything — defeating its purpose.

**Verdict: The boot_agent 3.3 GB estimate is unsupported by the data. The actual minimum is 5.3 GB (function costs only) or more.**

### 2.2 Strategy Agent Estimate: More Plausible

The plan claims `strategy_agent.ts` costs **~4.5 GB** with state snapshot + strategy + decision log.

Minimum plausible function set:
```
getServer(0.3) + getPlayer(0.3) + scan(0.2) + getHackingLevel(0.05) +
run(1.0) + exec(1.3) + write(1.0) + fileExists(0) = 4.15 GB
```

This is close to 4.5 GB with a small overhead margin. **The estimate is in the right ballpark**, assuming the base cost is negligible or zero.

If the plan's assumed base cost of 1.6 GB applies: 4.15 + 1.6 = 5.75 GB, exceeding 4.5 GB by 28%.

### 2.3 Home Server (8 GB)

- If boot_agent is actually 5.3 GB (function costs minimum): 8 - 5.3 = **2.7 GB free** on home
- If boot_agent is 3.3 GB (plan's claim): 8 - 3.3 = **4.7 GB free**
- Either way, enough room for scan_nuke (~0.35 GB) during bootstrap
- **Boot works in both cases**, but the margin is thinner with the real cost

### 2.4 foodnstuff (16 GB)

The plan says strategy_agent (~4.5 GB) runs here with workers.

- At the plan's claimed 4.5 GB: 16 - 4.5 = **11.5 GB free** for hack/grow/weaken workers
- At a more realistic 5.75 GB (with 1.6 GB base): 16 - 5.75 = **10.25 GB free** for workers
- **Works in both cases.** foodnstuff has ample headroom.

**But:** On a fresh game after the tutorial, foodnstuff is already rooted. However, foodnstuff requires hacking level **1** (minimum). If the player has completed the tutorial, they have hacking level > 1. So the strategy agent can operate on foodnstuff immediately after bootstrap.

### 2.5 n00dles (4 GB)

The plan correctly states the strategy agent won't fit on n00dles. At minimum 4.15 GB function costs, it barely exceeds 4 GB even without any base cost. **Assessment is correct.** n00dles should never host the strategy agent.

### 2.6 SF-1 Home RAM (32 GB)

If the player has Source-File 1 (level 1+), home starts with 32 GB RAM. The plan's bootstrap condition is `homeMaxRam <= 16`, which would skip BOOTSTRAP and go to SNOWBALL. This means a player with SF-1 would skip the two-tier architecture entirely and run everything from home. The plan does not discuss this edge case.

---

## 3. `getServer()` Optimization Claim

**Claim:** Using `getServer(host)` (0.3 GB) instead of 6 individual getters (0.55 GB) saves **0.25 GB** per cycle.

**Verification:**
```
6 getters: getServerMaxRam(0.1) + getServerUsedRam(0.1) +
           getServerMaxMoney(0.1) + getServerRequiredHackingLevel(0.1) +
           getServerMinSecurityLevel(0.1) + hasRootAccess(0.05) = 0.55 GB

getServer: 0.3 GB

Savings: 0.55 - 0.3 = 0.25 GB
```

**Verdict: Math checks out.** The 0.25 GB savings is confirmed assuming the script queries both current and max money, current/max security, etc.

**But there is a subtlety:** `getServer()` in modern Bitburner returns many more properties than the 6 listed getters cover. Critically, it also returns:
- `serverGrowth` (normally `getServerGrowth` = 0.1 GB)
- `backdoorInstalled` (no direct getter exists)
- `cpuCores` (no direct getter)

If the strategy agent needs serverGrowth for target valuation calculations, the savings grow: adding `getServerGrowth` (0.1 GB) would make the individual-getter total 0.65 GB vs getServer at 0.3 GB, saving **0.35 GB**.

**Additional consideration:** `getServer()` returns a single object, which must be destructured or accessed as properties. The individual getters return scalar values. This is a code ergonomics tradeoff, not a functional one — either approach provides the same data.

---

## 4. File I/O Costs

### 4.1 Verification

| Function | Plan Claim | Reference Doc | Verdict |
|---|---|---|---|
| `read()` | 1.0 GB | 1.0 GB | MATCH |
| `write()` | 1.0 GB | 1.0 GB | MATCH |
| `rm()` | 1.0 GB | 1.0 GB | MATCH |
| **File I/O subtotal** | **3.0 GB** | **3.0 GB** | MATCH |

### 4.2 Optimization Opportunity: Port-Based IPC

The plan mentions port-based IPC in section 4.9 but does not apply it to RAM optimization. The savings are substantial:

| Current (File I/O) | Alternative (Ports) | Savings |
|---|---|---|
| `read()` = 1.0 GB | `readPort()` = 0 GB | 1.0 GB |
| `write()` = 1.0 GB | `writePort()` = 0 GB | 1.0 GB |
| `rm()` = 1.0 GB | `clearPort()` = 0 GB | 1.0 GB |
| **Total** = 3.0 GB | **Total** = 0 GB | **3.0 GB** |

Port operations (`readPort`, `writePort`, `tryWritePort`, `peek`, `clearPort`) are all **0 GB**. Using ports for communication between the boot agent and the strategy agent (or between the strategy agent and workers) could save 3.0 GB — this is the single largest RAM optimization available.

**Caveat:** External MCP communication (Claude reading `status/*.txt` files) still requires file I/O. But *internal* agent-to-worker communication can use ports. The plan could keep file writes for external observability while switching internal signaling to ports.

**Verdict:** The costs are correct, and the plan understates the potential savings from switching to ports.

---

## 5. Base Script Cost Mystery

The plan states: "The base script cost is ~1.6 GB." This number appears to come from an older version of Bitburner or NS1 (`.script` format).

**Evidence of the problem:**

1. `status_reporter.ts` header claims "RAM: ~3.5 GB." Function costs are:
   `write(1.0) + getPlayer(0.3) + getServerMaxRam(0.1) + getServerUsedRam(0.1) + hasRootAccess(0.05) + ps(0.2) + scan(0.2) = 1.95 GB`
   To reach 3.5 GB, a base of **1.55 GB** is needed. This is consistent with the plan's 1.6 GB claim.

2. `game_agent.ts` header claims "RAM: ~4.8 GB." Function costs are:
   `write(1.0) + read(1.0) + rm(1.0) + getPlayer(0.3) + getServerMaxRam(0.1) + getServerUsedRam(0.1) + hasRootAccess(0.05) + ps(0.2) + run(1.0) + exec(1.3) + scriptKill(1.0) + killall(0.5) + getServer(0.3) + scan(0.2) = 8.05 GB`
   To reach 4.8 GB, either: (a) the base cost is negative (absurd), or (b) the header is wrong/outdated.

3. The `calculate_ram` MCP tool was unavailable (game not connected), so actual RAM could not be measured.

**Bottom line:** The existence and magnitude of a "base script cost" is unverified. The plan's numbers are inconsistent with each other. **Two contradictory base models** exist in the same plan:
- Model A (base = 1.6 GB): Makes status_reporter 3.5 GB work, but makes boot_agent cost 6.9 GB (not 3.3 GB)
- Model B (base = 0 GB): Makes boot_agent cost 5.3 GB (closer to 3.3 but still off), strategy_agent cost 4.15 GB (plausible)

Neither model fully reconciles all the plan's estimates.

---

## 6. Deployment Sequence (Fresh Game Bootstrap)

Assumption: Fresh BitNode-1, tutorial completed (foodnstuff is already rooted), home = 8 GB.

### Step-by-Step RAM Budget

| Step | Action | Home Free | foodnstuff Free | Notes |
|---|---|---|---|---|
| 0 | Fresh start, nothing running | 8 GB | 16 GB | After tutorial |
| 1 | User runs `boot_agent.js` (5.3 GB min, 6.9 GB with base) | 2.7 GB (or 1.1 GB) | 16 GB | This is the only manual step |
| 2 | boot_agent reads cmd.json, runs `scan_nuke.js` (0.35 GB) | 2.35 GB (or 0.75 GB) | 16 GB | scan_nuke runs briefly then exits |
| 3 | boot_agent SCPs strategy_agent to foodnstuff | 2.35 GB | 16 GB | scp costs 0.6 GB on boot_agent (already counted) |
| 4 | boot_agent execs strategy_agent on foodnstuff | 2.35 GB | 16 - 4.5 = 11.5 GB | Strategy agent starts on foodnstuff |
| 5 | Strategy agent deploys workers to rooted servers | 2.35 GB | Variable | Workers consume RAM per server |

### Feasibility Assessment

**Critical bottleneck: Step 2 free RAM.**
- With 6.9 GB boot_agent (base 1.6 GB model): home free drops to 0.75 GB during scan_nuke execution. Tight but still works.
- With 5.3 GB boot_agent (no base model): home free is 2.35 GB. Comfortable.

**Mid-game risk:** Once other scripts are running on home (workers, port openers), free RAM approaches zero. The boot agent's home reservation is not discussed in the plan.

**Recovery gap:** The boot agent cannot detect if the strategy agent crashes on foodnstuff — the plan lists no `ps` or `isRunning` functions for the boot agent. If foodnstuff is nuked or the strategy agent is killed, the boot agent has no way to know and re-deploy. The plan acknowledges this as a "Phase 2 concern" in section 4.10.

### Optional: SF-1 Edge Case

With SF-1 (32 GB home), the phase detection condition `homeMaxRam <= 16` is false, so the system skips BOOTSTRAP entirely. The strategy agent runs directly on home. This bypasses the two-tier architecture. The plan does not discuss this scenario.

---

## 7. Missed Optimization: `kill` vs `scriptKill`

The plan's action execution table lists both:
- `scriptKill(script, host)` = 1.0 GB
- `kill(pid)` = 0.5 GB

**But** the reference doc shows:
> `kill(pid)` / `kill(filename, host, args?)` = 0.5 GB

`kill()` can kill by **filename AND host**, same as `scriptKill()` — but costs **0.5 GB less**. If the strategy agent tracks PIDs (or calls `kill` with filename+host), it can replace `scriptKill` (1.0 GB) with `kill` (0.5 GB), saving **0.5 GB** with identical functionality.

The plan mentions `scriptKill` as a major cost but does not recommend replacing it with the cheaper `kill`.

---

## 8. Other Discrepancies and Observations

### 8.1 `hasRootAccess` Not in Plan's Snapshot

The plan's `GameState` interface (section 4.2) includes `rootedServers: string[]` and `rootedCount`, but to populate these fields the agent must call `hasRootAccess(host)` (0.05 GB) or check `getServer(host).hasAdminRights`. If using individual getters, this adds 0.05 GB. If using `getServer()`, it's already included. The plan accounts for this correctly only in the `getServer()` optimization model.

### 8.2 `snapshotProcesses` Uses `ps` — Not Discussed

The current `game_agent.ts` calls `ns.ps()` (0.2 GB) in `snapshotProcesses`. The plan's S5 says "remove ns.ps() from agent, lazy snapshot." Removing `ps` saves 0.2 GB. Valid optimization.

### 8.3 `findAllServers` Only Adds `scan` (0.2 GB)

Verified: `findAllServers` in `network.ts` uses `scanNetwork` which only calls `ns.scan`. The other functions in `network.ts` (`isSingleInstance` uses `ns.ps`, `ns.getHostname`, `ns.pid`) are not imported by `findAllServers`. So the import only adds 0.2 GB.

### 8.4 The Current game_agent.ts RAM Budget

The compiled `dist/monitor/game_agent.js` is the canonical deployment. Based on source analysis:
- Function cost total: **~8.1 GB** (or ~9.7 GB with 1.6 GB base)
- Header claims: **~4.8 GB** (likely outdated)
- This discrepancy means the header comment should not be trusted as authoritative

### 8.5 `status_reporter.ts` Consolidation Claim

The plan says to remove `status_reporter.ts` because `game_agent.ts` does everything it does. Verified: game_agent.ts has THREE additional `snapshotProcesses` features vs status_reporter:
1. Iterates ALL rooted servers for `ps`, not just home
2. Includes command relay functionality
3. Uses `getServer` for detailed server queries

The status_reporter uses a subset of the same functions (write, getPlayer, getServerMaxRam, getServerUsedRam, hasRootAccess, ps, scan). Consolidation is feasible. **However**, if the goal is to minimize RAM on home, having a SEPARATE status_reporter (3.5 GB) and boot_agent (5.3+ GB) running simultaneously would consume 8.8+ GB on home — exceeding the 8 GB budget. This is another reason to consolidate or run them on different servers.

---

## 9. Overall Verdict

### Realistic Components

- **Individual function costs:** All verified correct
- **`getServer()` optimization:** 0.25 GB savings is real; potentially more if additional getters are replaced
- **Base script cost:** ~1.6 GB is plausible (consistent with status_reporter estimate), but has contradictory implications
- **Strategy agent feasibility on foodnstuff (16 GB):** Works, ample headroom
- **n00dles (4 GB) disqualification:** Correct assessment
- **File I/O costs:** Correct, and a 3.0 GB savings opportunity via ports is overlooked

### Unrealistic Components

1. **CRITICAL: boot_agent estimated at 3.3 GB when minimum function costs are 5.3 GB.** This is a 61% error. The plan lists functions (run, exec, read, write, rm) whose costs alone sum to 5.3 GB. The 3.3 GB number appears fabricated or derived from incorrect math. This must be corrected before implementation.
2. **Strategy agent at 4.5 GB is optimistic.** The minimum is 4.15 GB (no base) or 5.75 GB (with 1.6 GB base). Tight but feasible if functions are chosen carefully.
3. **Base script cost is inconsistently applied.** Different parts of the plan implicitly assume different base costs.

### Single Biggest RAM Optimization

**Switch from file I/O to ports for inter-agent communication.** Replace `read`/`write`/`rm` (3.0 GB) with `readPort`/`writePort`/`tryWritePort` (all 0 GB) for internal signaling between the boot agent, strategy agent, and workers. File I/O only needs to remain for external MCP-observable status files.

Potential savings:
- Remove `read` from boot agent: **-1.0 GB**
- Remove `rm` from boot agent: **-1.0 GB**
- Remove `read` from strategy agent: **-1.0 GB**
- Replace `scriptKill` with `kill`: **-0.5 GB**
- Remove `ps`: **-0.2 GB**
- **Total potential savings: 3.7 GB**

This could bring boot_agent from 5.3 GB down to **~3.3 GB** — exactly the number the plan claims, but only achievable by dropping most file I/O.
