import type { NS } from '@ns';

export * from './net_scan';

/**
 * SERVER SCORING — the one genuinely heavy (hack-formula) function that
 * survives here. Deliberately kept out of lib/net_scan.ts: importing this
 * file costs ~1.35 GB (hackAnalyzeChance + getHackTime + getServerGrowth +
 * getServerMinSecurityLevel + getServerMaxMoney) that pure scan/discovery
 * consumers shouldn't pay — see docs/ram_evasion_rules.md §4. Only
 * compute/target_selector.ts needs this; every other consumer in the repo
 * imports from lib/net_scan.ts directly.
 *
 * calculateWeakenThreads/calculateGrowThreads/calculateHackThreads/
 * getHackableServers used to live here too — removed as dead code (2026-07-01):
 * hwgw_batcher.ts computes thread counts via its own `formulas` wrapper, and
 * grepping the repo found zero other call sites for any of the four.
 */

/** Score a server's value as a hack target. Higher = better. */
export function calculateServerValue(ns: NS, target: string): number {
    const maxMoney = ns.getServerMaxMoney(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const hackChance = ns.hackAnalyzeChance(target);
    const hackTime = ns.getHackTime(target);
    const growthFactor = ns.getServerGrowth(target);

    // Combined score with weights; lower security and faster hack time are better
    const moneyScore = maxMoney;
    const securityScore = 1 / (minSecurity + 1);
    const timeScore = 1 / (hackTime / 1000 + 1);
    const chanceScore = hackChance;
    const growthScore = growthFactor / 100;

    return moneyScore * securityScore * timeScore * chanceScore * growthScore;
}
