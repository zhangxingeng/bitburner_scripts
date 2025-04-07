import { NS } from '@ns';
import { formatMoney, formatTime, isSingleInstance } from './lib/utils';

// Constants
const MAX_PAYOFF_TIME = 3600; // 1 hour in seconds
const CONTINUOUS = true; // Set to false to run once
const INTERVAL = 1000; // Rate at which the program purchases upgrades when running continuously
const MAX_SPEND = Number.MAX_VALUE; // The maximum amount of money to spend on upgrades
const RESERVE = 0; // Reserve this much cash

let haveHacknetServers = true; // Cached flag after detecting whether we do (or don't) have hacknet servers

export async function main(ns: NS): Promise<void> {
    // Ensure only one instance is running
    if (!isSingleInstance(ns, true)) {
        ns.print('Another instance is already running. Exiting.');
        return;
    }

    disableLogs(ns);

    setStatus(ns, `Starting hacknet-upgrade-manager with purchase payoff time limit of ${formatTime(MAX_PAYOFF_TIME * 1000)} and ` +
        (MAX_SPEND == Number.MAX_VALUE ? 'no spending limit' : `a spend limit of ${formatMoney(MAX_SPEND)}`) +
        `. Current fleet: ${ns.hacknet.numNodes()} nodes...`);

    // Main loop
    let remainingBudget = MAX_SPEND;
    do {
        try {
            const moneySpent = upgradeHacknet(ns);

            // Check if we have hacknet servers
            if (haveHacknetServers && ns.hacknet.numNodes() > 0 && ns.hacknet.hashCapacity() === 0) {
                haveHacknetServers = false;
            }

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
            setStatus(ns, `WARNING: auto_hacknet.ts caught an unexpected error: ${errorMessage}`);
        }

        if (CONTINUOUS) await ns.sleep(INTERVAL);
    } while (CONTINUOUS);
}

/**
 * Disable logs to reduce spam
 */
function disableLogs(ns: NS): void {
    ns.disableLog('ALL');
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

interface HacknetNodeStats {
    name: string;
    level: number;
    ram: number;
    cores: number;
    cache?: number;
    hashCapacity?: number;
    production: number;
    timeOnline: number;
    totalProduction: number;
}

interface HacknetUpgrade {
    name: string;
    upgrade?: (index: number, count: number) => boolean;
    cost: (index: number) => number;
    nextValue: (nodeStats: HacknetNodeStats) => number;
    addedProduction: (nodeStats: HacknetNodeStats) => number;
}

/**
 * Main function to find and purchase the best hacknet upgrade
 */
function upgradeHacknet(ns: NS): number | false {
    const currentHacknetMult = ns.getPlayer().mults.hacknet_node_money;

    // Find the minimum cache level across all nodes
    const minCacheLevel = ns.hacknet.numNodes() === 0 ? 0 :
        [...Array(ns.hacknet.numNodes()).keys()].reduce((min, i) => {
            const cache = ns.hacknet.getNodeStats(i).cache;
            return typeof cache === 'number' ? Math.min(min, cache) : min;
        }, Number.MAX_VALUE);

    // Define all possible upgrade types
    const upgrades: HacknetUpgrade[] = [
        {
            name: 'none',
            cost: () => 0,
            nextValue: () => 0,
            addedProduction: () => 0
        },
        {
            name: 'level',
            upgrade: ns.hacknet.upgradeLevel,
            cost: (i: number) => ns.hacknet.getLevelUpgradeCost(i, 1),
            nextValue: (nodeStats: HacknetNodeStats) => nodeStats.level + 1,
            addedProduction: (nodeStats: HacknetNodeStats) => nodeStats.production * ((nodeStats.level + 1) / nodeStats.level - 1)
        },
        {
            name: 'ram',
            upgrade: ns.hacknet.upgradeRam,
            cost: (i: number) => ns.hacknet.getRamUpgradeCost(i, 1),
            nextValue: (nodeStats: HacknetNodeStats) => nodeStats.ram * 2,
            addedProduction: (nodeStats: HacknetNodeStats) => nodeStats.production * 0.07
        },
        {
            name: 'cores',
            upgrade: ns.hacknet.upgradeCore,
            cost: (i: number) => ns.hacknet.getCoreUpgradeCost(i, 1),
            nextValue: (nodeStats: HacknetNodeStats) => nodeStats.cores + 1,
            addedProduction: (nodeStats: HacknetNodeStats) => nodeStats.production * ((nodeStats.cores + 5) / (nodeStats.cores + 4) - 1)
        }
    ];

    // Only add cache upgrade if we have hacknet servers
    if (haveHacknetServers) {
        upgrades.push({
            name: 'cache',
            upgrade: ns.hacknet.upgradeCache,
            cost: (i: number) => ns.hacknet.getCacheUpgradeCost(i, 1),
            nextValue: (nodeStats: HacknetNodeStats) => (nodeStats.cache || 0) + 1,
            addedProduction: (nodeStats: HacknetNodeStats) => {
                const cache = nodeStats.cache || 0;
                if (!haveHacknetServers) return 0;
                if (cache > minCacheLevel) return 0;
                return nodeStats.production * 0.01 / cache;
            }
        });
    }

    let nodeToUpgrade = -1;
    let bestUpgrade: HacknetUpgrade = upgrades[0]; // Default to 'none'
    let bestUpgradePayoff = 0;
    let cost = 0;
    let upgradedValue = 0;
    let worstNodeProduction = Number.MAX_VALUE;

    // Evaluate upgrades for each existing node
    for (let i = 0; i < ns.hacknet.numNodes(); i++) {
        const nodeStats = ns.hacknet.getNodeStats(i);

        // If we have hacknet servers, try to use the formula API to get more accurate production value
        if (haveHacknetServers) {
            try {
                nodeStats.production = ns.formulas.hacknetServers.hashGainRate(
                    nodeStats.level,
                    0,
                    nodeStats.ram,
                    nodeStats.cores,
                    currentHacknetMult
                );
            } catch {
                // If formula API is not available, use the default production value
            }
        }

        worstNodeProduction = Math.min(worstNodeProduction, nodeStats.production);

        // Check each upgrade type for this node
        for (let up = 1; up < upgrades.length; up++) {
            const currentUpgradeCost = upgrades[up].cost(i);
            const addedProd = upgrades[up].addedProduction(nodeStats as HacknetNodeStats);

            // Calculate the payoff (production increase per dollar spent)
            const payoff = addedProd / currentUpgradeCost;

            // If this is the best payoff so far, save it
            if (payoff > bestUpgradePayoff) {
                nodeToUpgrade = i;
                bestUpgrade = upgrades[up];
                bestUpgradePayoff = payoff;
                cost = currentUpgradeCost;
                upgradedValue = upgrades[up].nextValue(nodeStats as HacknetNodeStats);
            }
        }
    }

    // Consider buying a new node
    const newNodeCost = ns.hacknet.getPurchaseNodeCost();
    // If we're at max nodes, payoff is 0, otherwise use the worst production as an estimate
    const newNodePayoff = ns.hacknet.numNodes() === ns.hacknet.maxNumNodes() ? 0 : worstNodeProduction / newNodeCost;
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
        `a new node "hacknet-node-${ns.hacknet.numNodes()}"` :
        `hacknet-node-${nodeToUpgrade} ${bestUpgrade.name} ${upgradedValue}`) +
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

    // Check if we have enough money after reserve
    const playerMoney = ns.getPlayer().money;
    if (cost > playerMoney - RESERVE) {
        setStatus(ns, `The next best purchase would be ${strPurchase}, but the cost exceeds our ` +
            'current available funds' + (RESERVE === 0 ? '.' : ` (after reserving ${formatMoney(RESERVE)}).`));
        return 0;
    }

    // Purchase the upgrade or new node
    const success = shouldBuyNewNode ?
        ns.hacknet.purchaseNode() !== -1 :
        bestUpgrade.upgrade ? bestUpgrade.upgrade(nodeToUpgrade, 1) : false;

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
        ns.print(`Current money: ${formatMoney(ns.getServerMoneyAvailable('home'))}`);
        ns.print(`Next node cost: ${formatMoney(ns.hacknet.getPurchaseNodeCost())}`);
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
        const stats = ns.hacknet.getNodeStats(i);
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