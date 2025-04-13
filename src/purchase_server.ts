import { NS } from '@ns';
import { formatRam, padNum } from './lib/util_normal_ram';
import { isSingleInstance } from './lib/util_low_ram';
/** @param {NS} ns */
export async function main(ns: NS): Promise<void> {
    // Ensure single instance
    if (!isSingleInstance(ns)) { return; }

    // Parse budget argument, default to 90% of available money if not provided
    const budgetArg = ns.args[0];
    const budget = typeof budgetArg === 'number'
        ? budgetArg
        : ns.getServerMoneyAvailable('home') * 0.9;

    if (isAllMaxed(ns, 1048576)) {
        ns.print('All servers are already maxed out.');
        return;
    }

    const upgradeResult = findOptimalUpgrade(ns, 1048576, 64, budget);
    if (upgradeResult.shouldUpgrade) {
        upgradeServer(ns, upgradeResult.server, upgradeResult.currentRam, upgradeResult.targetRam);
    } else {
        ns.print('No optimal server upgrades found within budget.');
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

function isAllMaxed(ns: NS, maxRam: number): boolean {
    const own_servers = ns.getPurchasedServers();
    const server_rams = own_servers.map(server => ns.getServerMaxRam(server));
    const max_server_count = ns.getPurchasedServerLimit();
    return own_servers.length >= max_server_count && server_rams.every(ram => ram >= maxRam);
}

function avgPrice(ns: NS): number {
    const own_servers = ns.getPurchasedServers();
    const server_rams = own_servers.map(server => ns.getServerMaxRam(server));
    const avg_ram = server_rams.reduce((a, b) => a + b, 0) / server_rams.length;
    return getCostByRam(ns, avg_ram);
}

/**
 * Gets the RAM power (log base 2) of a given RAM amount
 * @param {number} ram - RAM amount
 * @returns {number} Power of 2 as integer
 */
function getRamPower(ram: number): number {
    return Math.floor(Math.log2(ram));
}

/**
 * Calculates the required power difference threshold based on current RAM
 * @param {number} currentRam - Current RAM of the server
 * @returns {number} Required power difference
 */
function getRequiredPowerDifference(currentRam: number): number {
    const currentPower = getRamPower(currentRam);

    if (currentPower >= 20) return 0; // Max reached
    if (currentPower >= 19) return 1; // At 2^19, even x2 is acceptable
    if (currentPower >= 18) return 2; // At 2^18, x4 is acceptable
    return 3; // Otherwise require x8
}

/**
 * Gets the lowest RAM server or determines if we need to buy a new one
 * @param {NS} ns - Netscript API
 * @param {number} minInitialRam - Minimum RAM for new servers
 * @returns {Object} Object containing the lowest RAM server info or new server info
 */
function planNextTarget(ns: NS, minInitialRam: number = 8): { targetServer: string, currentRam: number, isNew: boolean } {
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
 * Finds the optimal RAM to upgrade to based on power difference threshold
 * @param {NS} ns - Netscript API
 * @param {number} maxRam - Maximum RAM allowed
 * @param {number} minInitialRam - Minimum RAM for new servers
 * @param {number} budget - Available budget
 * @returns {Object} Upgrade details including whether we should upgrade
 */
function findOptimalUpgrade(ns: NS, maxRam: number, minInitialRam: number, budget: number): {
    shouldUpgrade: boolean,
    server: string,
    currentRam: number,
    targetRam: number
} {
    const { targetServer, currentRam, isNew } = planNextTarget(ns, minInitialRam);

    // If it's a new server, start with the minimum initial RAM
    const effectiveCurrentRam = isNew ? minInitialRam : currentRam;

    // Determine the required power difference
    const requiredPowerDiff = getRequiredPowerDifference(effectiveCurrentRam);

    // If the server is already maxed, don't upgrade
    if (effectiveCurrentRam >= maxRam) {
        return {
            shouldUpgrade: false,
            server: targetServer,
            currentRam: currentRam,
            targetRam: currentRam
        };
    }

    // Calculate target RAM based on power difference
    const currentPower = getRamPower(effectiveCurrentRam);
    const targetPower = currentPower + requiredPowerDiff;
    const targetRam = Math.min(maxRam, Math.pow(2, targetPower));

    // Check if we can afford this upgrade
    const cost = getCostByRam(ns, targetRam);

    return {
        shouldUpgrade: cost <= budget,
        server: targetServer,
        currentRam: currentRam,
        targetRam: targetRam
    };
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

    // For new servers
    if (currentRam === 0) {
        return buyServer(ns, server, newRam);
    }

    // For existing servers
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
export function upgradeByBudget(ns: NS, maxRam: number, budget: number): boolean {
    // Find the server with the lowest RAM or determine if we need a new one
    const { targetServer, currentRam, isNew } = planNextTarget(ns, 8);

    // Minimum RAM for new servers is 8GB
    const minRam = isNew ? 8 : (currentRam * 2);

    // Calculate the best upgrade we can afford
    const { ram: newRam, cost } = estimateCost(ns, currentRam, minRam, maxRam, budget);

    // If we can't afford any upgrade, return failure
    if (cost === 0) {
        ns.print(`Cannot afford to upgrade server ${targetServer} from ${formatRam(currentRam)} RAM`);
        return false;
    }

    // Attempt to buy/upgrade the server
    return upgradeServer(ns, targetServer, currentRam, newRam);
}

/**
 * Given a server, a min ram, a max ram, and a budget, return the ram and cost to upgrade the server to as high as possible
 * @param ns - Netscript API
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
