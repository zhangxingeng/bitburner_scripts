import { NS } from '@ns';
import { isSingleInstance, findAllServers } from '../lib/net_scan';
/** @param {NS} ns */
export async function main(ns: NS) {
    if (!isSingleInstance(ns)) { return; }
    await nukeNetwork(ns, 'home');
}

/**
 * Nuke every reachable server — no child processes spawned.
 * Checks port openers once upfront, then applies them per-server.
 */
async function nukeNetwork(ns: NS, startHost: string = 'home') {
    const openers: Array<(h: string) => void> = [
        h => ns.brutessh(h),
        h => ns.ftpcrack(h),
        h => ns.relaysmtp(h),
        h => ns.httpworm(h),
        h => ns.sqlinject(h),
    ];
    const openerFiles = ['/BruteSSH.exe', '/FTPCrack.exe', '/relaySMTP.exe', '/HTTPWorm.exe', '/SQLInject.exe'];
    // Check which port openers exist once — not once per server
    const available = openerFiles.map((f, i) => ({ have: ns.fileExists(f), fn: openers[i] }));

    let rootedCount = 0;

    for (const host of findAllServers(ns, startHost)) {
        if (host !== startHost) {
            const portsNeeded = ns.getServerNumPortsRequired(host);
            for (let i = 0; i < portsNeeded && i < available.length; i++) {
                if (available[i].have) try { available[i].fn(host); } catch { /* ignore */ }
            }
            try { ns.nuke(host); } catch { /* not enough ports yet */ }
        }

        if (ns.hasRootAccess(host)) rootedCount++;
    }

    ns.tprint(`Total servers with root access: ${rootedCount}`);
}
