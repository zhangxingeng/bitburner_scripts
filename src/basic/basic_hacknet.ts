import { NS } from '@ns';
import { isSingleInstance } from '../lib/util_low_ram';
// import { formatMoney, formatTime } from '../lib/utils';

function formatMoney(money: number): string {
    return money.toLocaleString();
}

function formatTime(ms: number): string {
    return (ms / 1000).toFixed(2) + 's';
}

// Constants
const MAX_PAYOFF_TIME = 18000; // 5 hours in seconds
const CONTINUOUS = true; // Set to false to run once
const INTERVAL = 200; // Rate at which the program purchases upgrades when running continuously
const MAX_SPEND = Number.MAX_VALUE; // The maximum amount of money to spend on upgrades
const RESERVE = 0; // Reserve this much cash

// Flag to track if we have hacknet servers (hashes) or traditional nodes (money)
let haveHacknetServers = true;

export async function main(ns: NS): Promise<void> {
    // Ensure only one instance is running
    if (!isSingleInstance(ns)) { return; }

    // Disable logs to reduce clutter
    ns.disableLog('ALL');
    ns.ui.openTail(); // Open the script's log window

    const numNodes = ns.hacknet.numNodes();

    setStatus(ns, `Starting hacknet-upgrade-manager with purchase payoff time limit of ${formatTime(MAX_PAYOFF_TIME * 1000)} and ` +
        (MAX_SPEND == Number.MAX_VALUE ? 'no spending limit' : `a spend limit of ${formatMoney(MAX_SPEND)}`) +
        `. Current fleet: ${numNodes} nodes...`);

    // Check if we have hacknet servers
    try {
        if (numNodes > 0) {
            const hashCapacity = ns.hacknet.hashCapacity();
            haveHacknetServers = hashCapacity > 0;
        }
    } catch {
        // If hashCapacity() fails, we don't have hacknet servers
        haveHacknetServers = false;
    }

    // Main loop
    let remainingBudget = MAX_SPEND;
    do {
        try {
            const moneySpent = upgradeHacknet(ns);

            // Track spending
            if (moneySpent === false) {
                setStatus(ns, 'Spending limit reached or no worthwhile upgrades available. Breaking...');
                break;
            } else if (moneySpent > 0) {
                remainingBudget -= moneySpent;
                if (remainingBudget <= 0) {
                    setStatus(ns, 'Budget depleted. Breaking...');
                    break;
                }
            }

            // Display current status
            displayHacknetStatus(ns);

        } catch (err: unknown) {
            const errorMessage = typeof err === 'string' ? err :
                err instanceof Error ? err.message :
                    JSON.stringify(err);
            setStatus(ns, `WARNING: basic_hacknet.ts caught an unexpected error: ${errorMessage}`);
        }

        if (CONTINUOUS) await ns.sleep(INTERVAL);
    } while (CONTINUOUS);
}

let lastUpgradeLog = '';
/**
 * Set status in the log, avoiding duplicates
 */
function setStatus(ns: NS, logMessage: string): void {
    if (logMessage !== lastUpgradeLog) {
        ns.print(lastUpgradeLog = logMessage);
    }
}

/**
 * Get node stats
 */
function getNodeStats(ns: NS, index: number): {
    name: string,
    level: number,
    ram: number,
    cores: number,
    production: number,
    totalProduction: number,
    cache?: number
} {
    const nodeStats = ns.hacknet.getNodeStats(index);
    const name = nodeStats.name;
    const level = nodeStats.level;
    const ram = nodeStats.ram;
    const cores = nodeStats.cores;
    const production = nodeStats.production;
    const totalProduction = nodeStats.totalProduction;

    // Cache might not exist for traditional hacknet nodes
    let cache: number | undefined = undefined;
    try {
        cache = nodeStats.cache;
    } catch {
        // If this fails, cache is not available
    }

    return { name, level, ram, cores, production, totalProduction, cache };
}

/**
 * Get player's hacknet multiplier
 */
function getHacknetMult(ns: NS): number {
    try {
        return ns.getPlayer().mults.hacknet_node_money;
    } catch {
        return 1; // Default multiplier if we can't get it
    }
}

/**
 * Main function to find and purchase the best hacknet upgrade
 */
function upgradeHacknet(ns: NS): number | false {
    // Get current hacknet multiplier
    const currentHacknetMult = getHacknetMult(ns);

    // Find the minimum cache level across all nodes
    const numNodes = ns.hacknet.numNodes();

    let minCacheLevel = Number.MAX_VALUE;
    if (numNodes > 0) {
        for (let i = 0; i < numNodes; i++) {
            const nodeStats = getNodeStats(ns, i);
            const cache = nodeStats.cache;
            if (typeof cache === 'number' && cache < minCacheLevel) {
                minCacheLevel = cache;
            }
        }

        // Re-check if we have hacknet servers based on hash capacity
        if (haveHacknetServers) {
            try {
                const hashCapacity = ns.hacknet.hashCapacity();
                haveHacknetServers = hashCapacity > 0;
            } catch {
                haveHacknetServers = false;
            }
        }
    } else {
        minCacheLevel = 0;
    }

    // Track the best upgrade option
    let nodeToUpgrade = -1;
    let bestUpgradeType = 'none';
    let bestUpgradePayoff = 0;
    let cost = 0;
    let upgradedValue = 0;
    let worstNodeProduction = Number.MAX_VALUE;

    // Evaluate upgrades for each existing node
    for (let i = 0; i < numNodes; i++) {
        const nodeStats = getNodeStats(ns, i);

        // Try to calculate production using formulas if available
        if (haveHacknetServers) {
            try {
                const formulaProduction = ns.formulas.hacknetServers.hashGainRate(
                    nodeStats.level,
                    0,
                    nodeStats.ram,
                    nodeStats.cores,
                    currentHacknetMult
                );
                nodeStats.production = formulaProduction;
            } catch {
                // If formula API is not available, use the default production value
            }
        }

        worstNodeProduction = Math.min(worstNodeProduction, nodeStats.production);

        // Check level upgrade
        const levelCost = ns.hacknet.getLevelUpgradeCost(i, 1);
        const levelProd = nodeStats.production * ((nodeStats.level + 1) / nodeStats.level - 1);
        const levelPayoff = levelProd / levelCost;

        // Check RAM upgrade
        const ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
        const ramProd = nodeStats.production * 0.07;
        const ramPayoff = ramProd / ramCost;

        // Check cores upgrade
        const coresCost = ns.hacknet.getCoreUpgradeCost(i, 1);
        const coresProd = nodeStats.production * ((nodeStats.cores + 5) / (nodeStats.cores + 4) - 1);
        const coresPayoff = coresProd / coresCost;

        // Check cache upgrade if we have hacknet servers
        let cachePayoff = 0;
        let cacheCost = Number.MAX_VALUE;
        let cacheProd = 0;

        if (haveHacknetServers) {
            try {
                cacheCost = ns.hacknet.getCacheUpgradeCost(i, 1);
                const cache = nodeStats.cache || 0;
                if (cache <= minCacheLevel) {
                    cacheProd = nodeStats.production * 0.01 / cache;
                    cachePayoff = cacheProd / cacheCost;
                }
            } catch {
                // Cache upgrades not available
            }
        }

        // Find the best upgrade for this node
        let bestNodePayoff = 0;
        let bestType = 'none';
        let bestCost = 0;
        let bestNextValue = 0;

        if (levelPayoff > bestNodePayoff) {
            bestNodePayoff = levelPayoff;
            bestType = 'level';
            bestCost = levelCost;
            bestNextValue = nodeStats.level + 1;
        }

        if (ramPayoff > bestNodePayoff) {
            bestNodePayoff = ramPayoff;
            bestType = 'ram';
            bestCost = ramCost;
            bestNextValue = nodeStats.ram * 2;
        }

        if (coresPayoff > bestNodePayoff) {
            bestNodePayoff = coresPayoff;
            bestType = 'cores';
            bestCost = coresCost;
            bestNextValue = nodeStats.cores + 1;
        }

        if (cachePayoff > bestNodePayoff) {
            bestNodePayoff = cachePayoff;
            bestType = 'cache';
            bestCost = cacheCost;
            bestNextValue = (nodeStats.cache || 0) + 1;
        }

        // Update the global best if this node has a better upgrade
        if (bestNodePayoff > bestUpgradePayoff) {
            nodeToUpgrade = i;
            bestUpgradeType = bestType;
            bestUpgradePayoff = bestNodePayoff;
            cost = bestCost;
            upgradedValue = bestNextValue;
        }
    }

    // Consider buying a new node
    const newNodeCost = ns.hacknet.getPurchaseNodeCost();
    const maxNodes = ns.hacknet.maxNumNodes();

    // If we're at max nodes, payoff is 0, otherwise use the worst production as an estimate
    const newNodePayoff = numNodes === maxNodes ? 0 : worstNodeProduction / newNodeCost;
    const shouldBuyNewNode = newNodePayoff > bestUpgradePayoff;

    // If neither upgrade nor new node has value
    if (newNodePayoff === 0 && bestUpgradePayoff === 0) {
        setStatus(ns, 'All upgrades have no value (is hashNet income disabled in this BN?)');
        return false;
    }

    // Calculate payoff time based on hash dollar value
    const hashDollarValue = haveHacknetServers ? 2.5e5 : 1;
    const payoffTimeSeconds = 1 / (hashDollarValue * (shouldBuyNewNode ? newNodePayoff : bestUpgradePayoff));

    // Update cost if we're buying a new node
    if (shouldBuyNewNode) cost = newNodeCost;

    // Create strings for logging
    const strPurchase = (shouldBuyNewNode ?
        `a new node "hacknet-node-${numNodes}"` :
        `hacknet-node-${nodeToUpgrade} ${bestUpgradeType} ${upgradedValue}`) +
        ` for ${formatMoney(cost)}`;

    const strPayoff = `production ${((shouldBuyNewNode ? newNodePayoff : bestUpgradePayoff) * cost).toPrecision(3)} payoff time: ${formatTime(payoffTimeSeconds * 1000)}`;

    // Check against spending limit
    if (cost > MAX_SPEND) {
        setStatus(ns, `The next best purchase would be ${strPurchase}, but the cost exceeds the spending limit (${formatMoney(MAX_SPEND)})`);
        return false;
    }

    // Check against payoff time limit
    if (payoffTimeSeconds > MAX_PAYOFF_TIME) {
        setStatus(ns, `The next best purchase would be ${strPurchase}, but the ${strPayoff} is worse than the limit (${formatTime(MAX_PAYOFF_TIME * 1000)})`);
        return false;
    }

    // Get player money
    const playerMoney = ns.getServerMoneyAvailable('home');

    // Check if we have enough money after reserve
    if (cost > playerMoney - RESERVE) {
        setStatus(ns, `The next best purchase would be ${strPurchase}, but the cost exceeds our ` +
            'current available funds' + (RESERVE === 0 ? '.' : ` (after reserving ${formatMoney(RESERVE)}).`));
        return 0;
    }

    // Purchase the upgrade or new node
    let success = false;

    if (shouldBuyNewNode) {
        const newNodeIndex = ns.hacknet.purchaseNode();
        success = newNodeIndex !== -1;
    } else {
        // Perform the upgrade based on type
        switch (bestUpgradeType) {
            case 'level':
                success = ns.hacknet.upgradeLevel(nodeToUpgrade, 1);
                break;
            case 'ram':
                success = ns.hacknet.upgradeRam(nodeToUpgrade, 1);
                break;
            case 'cores':
                success = ns.hacknet.upgradeCore(nodeToUpgrade, 1);
                break;
            case 'cache':
                success = ns.hacknet.upgradeCache(nodeToUpgrade, 1);
                break;
            default:
                success = false;
        }
    }

    setStatus(ns, success ?
        `Purchased ${strPurchase} with ${strPayoff}` :
        `Insufficient funds to purchase the next best upgrade: ${strPurchase}`);

    return success ? cost : 0;
}

/**
 * Display the current status of hacknet nodes
 */
function displayHacknetStatus(ns: NS): void {
    ns.clearLog();

    const numNodes = ns.hacknet.numNodes();
    if (numNodes === 0) {
        ns.print('No Hacknet Nodes purchased yet');
        const currentMoney = ns.getServerMoneyAvailable('home');
        const nextNodeCost = ns.hacknet.getPurchaseNodeCost();

        ns.print(`Current money: ${formatMoney(currentMoney)}`);
        ns.print(`Next node cost: ${formatMoney(nextNodeCost)}`);
        return;
    }

    // Calculate total production and stats
    let totalProduction = 0;
    let totalProduced = 0;

    ns.print(`=== HACKNET DASHBOARD (${numNodes} nodes) ===`);

    // Table header
    ns.print('NODE | LEVEL | RAM   | CORES | PRODUCTION  | TOTAL PRODUCED');
    ns.print('-----+-------+-------+-------+-------------+---------------');

    // Show details for each node
    for (let i = 0; i < numNodes; i++) {
        const stats = getNodeStats(ns, i);
        totalProduction += stats.production;
        totalProduced += stats.totalProduction;

        ns.print(
            `${i.toString().padEnd(4)} | ` +
            `${stats.level.toString().padEnd(5)} | ` +
            `${stats.ram.toString().padEnd(5)} | ` +
            `${stats.cores.toString().padEnd(5)} | ` +
            `${formatMoney(stats.production)}/s | ` +
            `${formatMoney(stats.totalProduction)}`
        );
    }

    // Summary
    ns.print('-----+-------+-------+-------+-------------+---------------');
    ns.print(`TOTAL ${' '.repeat(21)}| ${formatMoney(totalProduction)}/s | ${formatMoney(totalProduced)}`);

    // Budget info
    const currentMoney = ns.getServerMoneyAvailable('home');
    ns.print(`\nCurrent money: ${formatMoney(currentMoney)}`);
    ns.print(`Hacknet budget: ${formatMoney(currentMoney - RESERVE)}`);
}
