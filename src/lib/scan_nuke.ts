import { NS } from '@ns';
import { isSingleInstance } from './util_low_ram';
/** @param {NS} ns */
export async function main(ns: NS) {
    if (!isSingleInstance(ns)) { return; }
    await nukeNetwork(ns, 'home');
}

/** 
 * Use BFS to discover and nuke all servers on the network
 * @param {NS} ns 
 * @param {string} startHost - Server to start from
 */
async function nukeNetwork(ns: NS, startHost: string = 'home') {
    const visited = new Set<string>();
    const queue: string[] = [startHost];
    let rootedCount = 0;

    while (queue.length > 0) {
        const host = queue.shift()!;
        if (visited.has(host)) continue;
        visited.add(host);

        // Count rooted servers
        if (ns.hasRootAccess(host)) {
            rootedCount++;
        }

        // Get connected hosts using the lower RAM cost function
        const connectedHosts = ns.scan(host);

        for (const connectedHost of connectedHosts) {
            // Skip if already visited
            if (visited.has(connectedHost)) continue;

            // Try to nuke the server
            ns.run('/lib/autonuke.js', 1, connectedHost);

            // Add to queue for further exploration
            queue.push(connectedHost);
        }
    }

    // Print the total number of rooted servers
    ns.tprint(`Total servers with root access: ${rootedCount}`);
}