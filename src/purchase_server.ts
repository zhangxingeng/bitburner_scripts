import { NS } from '@ns';
import { formatRam, padNum } from './utils';

/** @param {NS} ns */
export async function main(ns: NS): Promise<void> {
    // check argument legth first
    const args = ns.args;
    if (args.length === 0) {
        ns.disableLog('ALL');
        ns.ui.openTail();
        ns.ui.setTailTitle('Purchase Server');
        while (true) {
            upgradeByBudget(ns, 1048576, ns.getServerMoneyAvailable('home') * 0.9);
            await ns.sleep(1000);
        }
    } else {
        const maxRam = Number(ns.args[0]);
        const budget = Number(ns.args[1]);
        upgradeByBudget(ns, maxRam, budget);
    }
}

/**
 * Gets the cost of the next server upgrade/purchase
 * @param {NS} ns - Netscript API
 * @param {number} targetRam - RAM size to check
 * @returns {number} Cost of the server
 */
function getCostByRam(ns: NS, targetRam: number): number {
    return ns.getPurchasedServerCost(targetRam);
}

/**
 * Gets the lowest RAM server or determines if we need to buy a new one
 * @param {NS} ns - Netscript API
 * @returns {Object} Object containing the lowest RAM server info or new server info
 */
function planNextTarget(ns: NS): { targetServer: string, currentRam: number, isNew: boolean } {
    const own_servers = ns.getPurchasedServers();
    const max_server_count = ns.getPurchasedServerLimit();

    // If we can buy a new server
    if (own_servers.length < max_server_count) {
        return {
            targetServer: `pserv-${padNum(own_servers.length, 2)}`,
            currentRam: 0,
            isNew: true
        };
    }
    // Find the lowest RAM server to upgrade
    else {
        const servers_with_ram = own_servers.map(server => ({
            name: server,
            ram: ns.getServerMaxRam(server)
        }));

        const min_server = servers_with_ram.reduce(
            (min, curr) => curr.ram < min.ram ? curr : min,
            { name: '', ram: Infinity }
        );

        return {
            targetServer: min_server.name,
            currentRam: min_server.ram,
            isNew: false
        };
    }
}

/**
 * Given a server, a min ram, a max ram, and a budget, return the ram and cost to upgrade the server to as high as possible
 * @param ns - Netscript API
 * @param server - Server to upgrade
 * @param currentRam - Current RAM of the server (0 if new server)
 * @param minRam - Minimum RAM to upgrade to
 * @param maxRam - Maximum RAM to upgrade to
 * @param budget - Budget to spend
 * @returns {Object} Object containing the ram and cost to upgrade the server. Returns {ram: current_ram, cost: 0} if not enough money to upgrade.
 */
function estimateCost(
    ns: NS,
    currentRam: number,
    minRam: number,
    maxRam: number,
    budget: number
): { ram: number, cost: number } {
    const nextRam = Math.max(minRam, currentRam > 0 ? currentRam * 2 : minRam);

    // If we can't even afford the next tier, return current RAM and cost 0
    if (nextRam > maxRam || getCostByRam(ns, nextRam) > budget) {
        return { ram: currentRam, cost: 0 };
    }

    // Find the highest affordable RAM upgrade
    let bestRam = nextRam;
    let bestCost = getCostByRam(ns, nextRam);

    while (true) {
        const potentialRam = bestRam * 2;
        if (potentialRam > maxRam) break;

        const potentialCost = getCostByRam(ns, potentialRam);
        if (potentialCost > budget) break;

        bestRam = potentialRam;
        bestCost = potentialCost;
    }

    return { ram: bestRam, cost: bestCost };
}

/**
 * Buys a new server with the specified RAM
 * @param ns - Netscript API
 * @param serverName - Name of the server to buy
 * @param ram - RAM to buy
 * @returns {boolean} Whether the purchase was successful
 */
function buyServer(ns: NS, serverName: string, ram: number): boolean {
    const purchasedName = ns.purchaseServer(serverName, ram);
    if (purchasedName) {
        ns.print(`Purchased new server ${purchasedName} with ${formatRam(ram)} RAM`);
        return true;
    } else {
        ns.print(`Failed to purchase server ${serverName} with ${formatRam(ram)} RAM`);
        return false;
    }
}

/**
 * Deletes a server
 * @param ns - Netscript API
 * @param server - Server to delete
 * @returns {boolean} Whether the deletion was successful
 */
function deleteServer(ns: NS, server: string): boolean {
    ns.killall(server);
    return ns.deleteServer(server);
}

/**
 * Upgrades a server to a new RAM size
 * @param ns - Netscript API
 * @param server - Server to upgrade
 * @param currentRam - Current RAM of the server
 * @param newRam - New RAM to upgrade to
 * @returns {boolean} Whether the upgrade was successful
 */
function upgradeServer(ns: NS, server: string, currentRam: number, newRam: number): boolean {
    if (currentRam >= newRam) {
        ns.print(`Cannot upgrade from ${formatRam(currentRam)} to ${formatRam(newRam)}`);
        return false;
    }

    // Save the old RAM value before deleting
    ns.print(`Upgrading server ${server} from ${formatRam(currentRam)} to ${formatRam(newRam)} RAM`);

    // Delete the server and buy a new one with the same name
    if (!deleteServer(ns, server)) {
        ns.print(`Failed to delete server ${server}`);
        return false;
    }

    return buyServer(ns, server, newRam);
}

/**
 * Given a budget, upgrades the lowest RAM server (or buys a new one) to the highest possible tier
 * @param ns - Netscript API
 * @param maxRam - Maximum RAM to upgrade to
 * @param budget - Budget to spend
 * @returns {Object} Information about the upgrade that occurred
 */
export function upgradeByBudget(ns: NS, maxRam: number, budget: number): void {
    // Find the server with the lowest RAM or determine if we need a new one
    const { targetServer, currentRam, isNew } = planNextTarget(ns);

    // Minimum RAM for new servers is 2GB
    const minRam = isNew ? 2 : (currentRam * 2);

    // Calculate the best upgrade we can afford
    const { ram: newRam, cost } = estimateCost(ns, currentRam, minRam, maxRam, budget);

    // If we can't afford any upgrade, return failure
    if (cost === 0) {
        ns.print(`Cannot afford to upgrade server ${targetServer} from ${formatRam(currentRam)} RAM`);
        return;
    }

    // Attempt to buy/upgrade the server
    let success: boolean;

    if (isNew) {
        success = buyServer(ns, targetServer, newRam);
    } else {
        success = upgradeServer(ns, targetServer, currentRam, newRam);
    }
}
