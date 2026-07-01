import type { NS } from '@ns';

/**
 * Early-Game Smart Prepper — replaces naive simple_hack_loop spraying.
 *
 * Instead of blindly H-W-G-W on every rooted server, this worker:
 *   1. Scans the network for the BEST single target
 *      (highest money-per-second at current hack level, filtered to 0-port servers
 *       early on, expanding as port openers are acquired)
 *   2. PREPS that target: weaken to min security, grow to max money
 *   3. Hacks efficiently: hack → weaken → grow → weaken cycle, only when prepped
 *
 * Designed for ≤ 3 GB RAM per thread. Deliberately self-contained — no imports
 * from lib/config or compute/ to keep the import footprint minimal.
 *
 * Launch: run /workers/early_prepper.js [target]
 *   With target: hacks only that server
 *   Without target: auto-selects the best target
 *
 * Usage in bootstrap: replaces deployWorkers() spray with one instance of this
 * on home (or on the target server itself via ns.exec).
 */

// ── Tuning ──────────────────────────────────────────────────────────────────────

const LOOP_INTERVAL_MS      = 200;
const PREP_WEAKEN_THRESHOLD = 1.05;  // weaken if security > min * this
const PREP_GROW_THRESHOLD   = 0.90;  // grow if money < max * this
const HACK_FRACTION         = 0.50;  // steal this fraction of money per hack
const MIN_HACK_CHANCE       = 0.30;  // don't hack if chance below this

// ── Types ───────────────────────────────────────────────────────────────────────

interface TargetInfo {
    hostname:           string;
    moneyMax:           number;
    moneyAvailable:     number;
    hackDifficulty:     number;
    minDifficulty:      number;
    requiredHacking:    number;
    hackChance:         number;  // 0..1
    hackAnalyze:        number;  // fraction of money stolen per thread
    hasRoot:            boolean;
    portsRequired:      number;
}

// ── Target selection ──────────────────────────────────────────────────────────

/** Quick BFS scan — returns all reachable hostnames. */
function scanAll(ns: NS): string[] {
    const visited = new Set<string>(['home']);
    const queue   = ['home'];
    const result: string[] = ['home'];
    while (queue.length > 0) {
        for (const neighbor of ns.scan(queue.shift()!)) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
                result.push(neighbor);
            }
        }
    }
    return result;
}

/** Count how many port openers we have. */
function countOpeners(ns: NS): number {
    const files = ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe', 'HTTPWorm.exe', 'SQLInject.exe'];
    let count = 0;
    for (const f of files) {
        try { if (ns.fileExists(f, 'home')) count++; } catch { /* nop */ }
    }
    return count;
}

/** Gather target info for all hackable servers. */
function analyzeTargets(ns: NS): TargetInfo[] {
    const player       = ns.getPlayer();
    const hackLevel    = player.skills.hacking;
    const maxOpeners   = countOpeners(ns);
    const results: TargetInfo[] = [];

    for (const host of scanAll(ns)) {
        if (host === 'home') continue;

        const sv = ns.getServer(host);
        if (!sv.hasAdminRights) continue;
        if ((sv.moneyMax ?? 0) <= 0) continue;

        const requiredHacking = sv.requiredHackingSkill ?? Infinity;
        if (requiredHacking > hackLevel) continue;

        const hackChance  = ns.hackAnalyzeChance(host);
        if (hackChance < MIN_HACK_CHANCE) continue;

        const hackAnalyze = ns.hackAnalyze(host);

        results.push({
            hostname:        host,
            moneyMax:        sv.moneyMax ?? 0,
            moneyAvailable:  sv.moneyAvailable ?? 0,
            hackDifficulty:  sv.hackDifficulty ?? 0,
            minDifficulty:   sv.minDifficulty ?? 1,
            requiredHacking,
            hackChance,
            hackAnalyze,
            hasRoot:         true,
            portsRequired:   sv.numOpenPortsRequired ?? 0,
        });
    }

    // Sort by effective value: maxMoney * hackAnalyze * hackChance
    // This prioritizes servers that pay well per hack action
    results.sort((a, b) => {
        const scoreA = a.moneyMax * a.hackAnalyze * a.hackChance;
        const scoreB = b.moneyMax * b.hackAnalyze * b.hackChance;
        return scoreB - scoreA;
    });

    return results;
}

// ── Prep logic ────────────────────────────────────────────────────────────────

/** Check if a target needs weakening. */
function needsWeaken(ns: NS, host: string): boolean {
    const sv = ns.getServer(host);
    return (sv.hackDifficulty ?? 99) > (sv.minDifficulty ?? 1) * PREP_WEAKEN_THRESHOLD;
}

/** Check if a target needs growing. */
function needsGrow(ns: NS, host: string): boolean {
    const sv = ns.getServer(host);
    return (sv.moneyAvailable ?? 0) < (sv.moneyMax ?? 1) * PREP_GROW_THRESHOLD;
}

/** Check if target is fully prepped (at min security and max money). */
function isPrepped(ns: NS, host: string): boolean {
    const sv = ns.getServer(host);
    const secOk   = (sv.hackDifficulty ?? 99) <= (sv.minDifficulty ?? 1) * 1.02;
    const moneyOk = (sv.moneyAvailable ?? 0) >= (sv.moneyMax ?? 1) * 0.98;
    return secOk && moneyOk;
}

// ── Main ────────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    // If a target is passed as argument, use it exclusively
    const forcedTarget = ns.args.length > 0 ? String(ns.args[0]) : null;

    if (forcedTarget) {
        ns.print(`[prepper] Targeting: ${forcedTarget}`);
    } else {
        ns.print('[prepper] Auto-selecting best target...');
    }

    let currentTarget: string | null = forcedTarget;
    let prepped = false;

    while (true) {
        try {
            // If no forced target, periodically re-evaluate
            if (!forcedTarget) {
                const targets = analyzeTargets(ns);
                if (targets.length === 0) {
                    ns.print('[prepper] No hackable targets found — sleeping');
                    await ns.sleep(5000);
                    continue;
                }
                const best = targets[0];
                if (currentTarget !== best.hostname) {
                    ns.print(
                        `[prepper] Best target: ${best.hostname} ` +
                        `(max=$${best.moneyMax.toLocaleString()} ` +
                        `chance=${(best.hackChance * 100).toFixed(0)}% ` +
                        `analyze=${(best.hackAnalyze * 100).toFixed(2)}%)`,
                    );
                    currentTarget = best.hostname;
                    prepped = false; // new target, re-prep
                }
            }

            if (!currentTarget) {
                await ns.sleep(5000);
                continue;
            }

            const target = currentTarget;

            // Check prep state
            prepped = isPrepped(ns, target);

            if (!prepped) {
                // Prep phase: weaken first, then grow
                if (needsWeaken(ns, target)) {
                    await ns.weaken(target);
                } else if (needsGrow(ns, target)) {
                    await ns.grow(target);
                } else {
                    // Weaken again after grow (growth increases security)
                    if (needsWeaken(ns, target)) {
                        await ns.weaken(target);
                    } else {
                        prepped = true;
                    }
                }
            } else {
                // Hack phase: only hack when prepped
                const chance = ns.hackAnalyzeChance(target);
                const currentMoney = ns.getServer(target).moneyAvailable ?? 0;
                const maxMoney     = ns.getServer(target).moneyMax ?? 1;

                if (currentMoney >= maxMoney * 0.5 && chance >= MIN_HACK_CHANCE) {
                    const earned = await ns.hack(target);
                    if (earned > 0) {
                        ns.print(`[prepper] Hacked ${target}: +$${earned.toLocaleString()}`);
                    }
                }

                // Repair: weaken if security climbed, grow if money dropped
                if (needsWeaken(ns, target)) {
                    await ns.weaken(target);
                }
                if (needsGrow(ns, target)) {
                    await ns.grow(target);
                }
                // Final weaken after grow
                if (needsWeaken(ns, target)) {
                    await ns.weaken(target);
                }

                prepped = isPrepped(ns, target);
            }
        } catch (err) {
            ns.print(`[prepper] ERROR: ${String(err)}`);
            await ns.sleep(1000);
        }

        await ns.sleep(LOOP_INTERVAL_MS);
    }
}
