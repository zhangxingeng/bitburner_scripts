import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
    // disable logging
    ns.disableLog('ALL');
    ns.ui.openTail();
    const servers = ns.getPurchasedServers();
    const serverStats = servers.map(server => {
        const ram = ns.getServerMaxRam(server);
        ns.print(`${server}: ${ram}GB`);
    });
}