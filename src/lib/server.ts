import type { NS } from '@ns';
import { findAllServers } from './network';

/** Score a server's value as a hack target. Higher = better. */
export function calculateServerValue(ns: NS, target: string): number {
    const maxMoney = ns.getServerMaxMoney(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const hackChance = ns.hackAnalyzeChance(target);
    const hackTime = ns.getHackTime(target);

    return maxMoney * (1 / (minSecurity + 1)) * (1 / (hackTime / 1000 + 1)) * hackChance;
}

/** Threads needed to weaken a server to its minimum security level. */
export function calculateWeakenThreads(ns: NS, target: string): number {
    const currentSecurity = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const securityDiff = Math.max(0, currentSecurity - minSecurity);
    return Math.ceil(securityDiff / ns.weakenAnalyze(1));
}

/** Threads needed to grow a server from current money to max money. */
export function calculateGrowThreads(ns: NS, target: string): number {
    const currentMoney = Math.max(1, ns.getServerMoneyAvailable(target));
    const maxMoney = ns.getServerMaxMoney(target);
    return Math.ceil(ns.growthAnalyze(target, maxMoney / currentMoney));
}

/** Threads needed to hack a given fraction of a server's money (default 50%). */
export function calculateHackThreads(ns: NS, target: string, hackFraction = 0.5): number {
    const hackPerThread = ns.hackAnalyze(target);
    return Math.max(1, Math.floor(hackFraction / hackPerThread));
}

/** Filter to servers the player can hack right now, sorted by required level ascending. */
export function getHackableServers(ns: NS, servers?: string[]): string[] {
    const serverList = servers ?? findAllServers(ns);
    const hackLevel = ns.getHackingLevel();
    const purchased = ns.getPurchasedServers();
    const levels = new Map<string, number>();

    const hackable: string[] = [];
    for (const server of serverList) {
        if (server === 'home' || purchased.includes(server)) continue;
        const level = ns.getServerRequiredHackingLevel(server);
        levels.set(server, level);
        if (ns.hasRootAccess(server) && ns.getServerMaxMoney(server) > 0 && level <= hackLevel) {
            hackable.push(server);
        }
    }
    return hackable.sort((a, b) => levels.get(a)! - levels.get(b)!);
}
