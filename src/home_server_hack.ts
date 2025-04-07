import { NS } from '@ns';
import { findAllServers, gainRootAccess } from './lib/utils';

/**
 * Finds the best server to hack based on money and security
 * @param {NS} ns - Netscript API
 * @returns {string} Name of the best server to hack
 */
function findBestTarget(ns: NS, servers: string[]): string {
    let bestServer = 'n00dles'; // Default
    let bestScore = 0;
    for (const server of servers) {
        const maxMoney = ns.getServerMaxMoney(server);
        const minSecurity = ns.getServerMinSecurityLevel(server);
        if (maxMoney <= 0) continue;
        const score = maxMoney / minSecurity;
        if (score > bestScore) {
            bestScore = score;
            bestServer = server;
        }
    }
    return bestServer;
}

/**
 * Main function that hacks servers from home
 * @param {NS} ns - Netscript API
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    const allServers = findAllServers(ns);
    ns.print('Attempting to gain root access to servers...');
    const allRootedServers = allServers.filter(s => gainRootAccess(ns, s));
    const allTargetServers: string[] = allRootedServers.filter(s => s !== 'home' && !s.includes('hacknet-'));
    ns.print(`Total servers with root access: ${allTargetServers.length}`);

    // Find best target to hack
    const bestTarget = findBestTarget(ns, allTargetServers);
    ns.print(`Best server to hack: ${bestTarget}`);
    let running = true;
    while (running) {
        try {
            // Get current server security and money
            const security = ns.getServerSecurityLevel(bestTarget);
            const minSecurity = ns.getServerMinSecurityLevel(bestTarget);
            const money = ns.getServerMoneyAvailable(bestTarget);
            const maxMoney = ns.getServerMaxMoney(bestTarget);

            // Update progress
            const moneyPercent = (money / maxMoney * 100).toFixed(2);
            const securityDiff = (security - minSecurity).toFixed(2);
            ns.print(`${bestTarget}: $${moneyPercent}% of max money, security ${securityDiff} above minimum`);

            // Decide what action to take
            if (security > minSecurity + 5) {
                ns.print(`Weakening ${bestTarget}...`);
                await ns.weaken(bestTarget);
            } else if (money < maxMoney * 0.75) {
                ns.print(`Growing ${bestTarget}...`);
                await ns.grow(bestTarget);
            } else {
                ns.print(`Hacking ${bestTarget}...`);
                const stolenMoney = await ns.hack(bestTarget);
                ns.print(`Hacked ${bestTarget} for $${ns.formatNumber(stolenMoney)}`);
            }
        } catch (error) {
            ns.print(`Error in hacking loop: ${error}`);
            running = false;
        }
    }
} 