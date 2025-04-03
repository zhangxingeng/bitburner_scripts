import { NS } from '@ns';
import { scanAndNuke, copyScripts, calculateServerScore, formatTime, formatRam, formatMoney, prettyDisplay } from './utils';
import { buyAllPortOpeners } from './lib/buy_port_opener';

const SCRIPT_PATH = {
    hack: 'remote/hack.js',
    weaken: 'remote/weaken.js',
    grow: 'remote/grow.js',
    share: 'remote/share.js',
    solveContracts: 'remote/solve-contracts.js',
};

const SCRIPT_RAM = {
    slaveScript: 1.75,    // RAM usage in GB for weaken/hack/grow scripts
    shareScript: 4.0,     // RAM usage in GB for share script
    solveContractsScript: 22.0, // RAM usage in GB for solve-contracts script
};

// Restructured CONFIG with better organization
const CONFIG = {
    maxParallelAttacks: 60,
    thresholds: {
        ramUsageLow: 0.8,
        ramUsageHigh: 0.9,
        securityThresholdOffset: 5,
        moneyThresholdPercentage: 0.8,
        minimumServerRam: 1.6,
        hackMoneyRatioMin: 0.01,
        hackMoneyRatioMax: 0.99
    },
    timing: {
        cycleSleep: 200,
        maxThreadCalculationTime: 240000, // 4 minutes timeout for thread calculations
    },
    ram: {
        useHomeRam: true,
        reservedHomeRamPercentage: 0.2,
        maxReserveHomeRAM: 256,
        minReserveHomeRam: 32,
        ignoreServersLowerThanPurchased: true // New flag to control server filtering feature
    },
    serverPurchase: {
        cashRatio: 0.9,
        maxPurchasedRam: 1048576,
        minCashReserve: 10000000
    },
    security: {
        growThreadSecurityIncrease: 0.004,
        hackThreadSecurityIncrease: 0.002,
        weakenSecurityDecrease: 0.05,
    },
    features: {
        solveContracts: true,
        useTimedThreadAdjustment: true, // New feature flag for thread adjustment with timeout
    }
};

interface AttackStrategy {
    hackThreads: number;
    growThreads: number;
    weakenThreads: number;
    weakenForHackThreads: number;
    totalThreads: number;
    totalRAM: number;
    serverValue: number;
    maxStealPercentage: number;
}

// Core interfaces - simplified
interface ServerRamInfo {
    host: string;
    freeRam: number;
    maxRam: number; // Add maxRam to track total RAM per server
    hasCapacityFor: (threads: number) => boolean;
}
// RamUsage Class Implementation - Define at the top of the file and make properties public
class RamUsage {
    private _serverRams: ServerRamInfo[] = [];

    // Computed property - calculated on access
    get overallFreeRam(): number {
        return this._serverRams.reduce((sum, server) => sum + server.freeRam, 0);
    }

    // Computed property - calculated on access
    get overallMaxRam(): number {
        return this._serverRams.reduce((sum, server) => sum + server.maxRam, 0);
    }

    get utilization(): number {
        return this.overallMaxRam > 0
            ? (this.overallMaxRam - this.overallFreeRam) / this.overallMaxRam
            : 0;
    }

    addServer(host: string, freeRam: number, maxRam: number): void {
        this._serverRams.push({
            host,
            freeRam,
            maxRam,
            hasCapacityFor: (threads: number) => freeRam >= SCRIPT_RAM.slaveScript * threads
        });
        // No need to update totals - they're calculated on access
    }

    reserveRam(amount: number, serverHost?: string): void {
        if (serverHost) {
            // Reduce RAM on specific server
            const server = this._serverRams.find(s => s.host === serverHost);
            if (server) {
                server.freeRam = Math.max(0, server.freeRam - amount);
            }
        } else {
            // Distribute across servers
            // Implementation would depend on your strategy
        }
        // No need to update totals - they're calculated on access
    }

    get serverRams(): ServerRamInfo[] {
        return [...this._serverRams]; // Return a copy to prevent direct modification
    }
}

// Global variables
let partialWeakGrow: string | null = null;
const partialAttacks = 1;
const profitsMap = new Map<string, number>();

// Add stock market manipulation configuration
const STOCK_MANIPULATION_CONFIG = {
    enabled: true,
    manipulationThreshold: 0.02, // Minimum forecast change to trigger manipulation
    maxManipulationServers: 5, // Max number of servers to manipulate simultaneously
    manipulationCooldown: 60000, // 1 minute cooldown between manipulations
    hackEffect: -0.01, // Forecast change per hack
    growEffect: 0.01, // Forecast change per grow
    minServerMoney: 1e6, // Minimum server money to consider for manipulation
    maxSecurityOffset: 5 // Maximum security level above minimum to manipulate
};

// Add stock manipulation state
let lastManipulationTime = 0;
const manipulatedStocks = new Map<string, number>(); // Tracks last manipulation time per stock

/**
 * Main function that orchestrates the distributed hacking operation
 * @param {NS} ns - The Netscript API
 */
export async function main(ns: NS): Promise<void> {
    ns.ui.openTail();
    ns.disableLog('ALL');
    ns.clearLog();

    const startTime = Date.now();
    // Make sure scripts exist
    ensureSlaveScriptsExist(ns);

    // Initialize variables
    let hackMoneyRatio = adjustInitialHackMoneyRatio(ns);
    let servers: Set<string> = new Set<string>(['home']); // At least start with home server
    let targets: string[];
    let freeRams: RamUsage;
    let ramUsage = 0;
    let lastServerCount = 0;
    let lastFilteredCount = 0;

    // Stock market variables
    const growStocks = new Set<string>();
    const hackStocks = new Set<string>();
    const moneyXpShare = true;
    const shareThreadIndex = 0;

    // Main loop
    let tick = 1;
    const scanAndNukeFreq = 20;
    const displayFreq = 1;
    const purchaseServerFreq = 21;
    const portOpenerFreq = 6; // Check every 5 ticks

    const scriptsToDeploy = [SCRIPT_PATH.hack, SCRIPT_PATH.grow, SCRIPT_PATH.weaken, SCRIPT_PATH.share];

    // Main loop with enhanced structure
    while (tick++) {
        try {
            // Scan and nuke network periodically
            if (tick % scanAndNukeFreq === 0) {
                servers = scanAndUpdateNetwork(ns, scriptsToDeploy);
            }

            /* CORE ATTACK LOGIC - More modular approach */
            freeRams = getFreeRam(ns, servers);

            // Log when servers are filtered
            const filteredServers = filterServersByRam(ns, servers);
            if (CONFIG.ram.ignoreServersLowerThanPurchased &&
                (lastServerCount !== servers.size || lastFilteredCount !== filteredServers.size)) {
                lastServerCount = servers.size;
                lastFilteredCount = filteredServers.size;
            }

            targets = getHackableServers(ns, Array.from(servers));

            // Launch attacks with timeout protection
            const attacksLaunched = await manageAndHackWithTimeout(ns, freeRams, targets, growStocks, hackStocks, hackMoneyRatio);

            if (attacksLaunched > 0) {
                ramUsage = freeRams.utilization;
                hackMoneyRatio = adjustHackMoneyRatio(ns, ramUsage, hackMoneyRatio);
            }

            // Handle additional features in a more modular way
            await runAdditionalFeatures(ns, freeRams, servers, targets, moneyXpShare, hackMoneyRatio, shareThreadIndex);

            // Periodic server purchases
            if (tick % purchaseServerFreq === 0) {
                handleServerPurchases(ns);
            }

            // Check and buy port openers periodically
            if (tick % portOpenerFreq === 0) {
                // buyAllPortOpeners(ns);
                ns.exec('lib/buy_port_opener.js', 'home', 1);

            }

            // Calculate income per second
            const incomePerSecond = Array.from(profitsMap.values()).reduce((sum, profit) => sum + profit, 0);

            // Display status periodically
            if (tick % displayFreq === 0) {
                displayAllStats(
                    ns,
                    startTime,
                    targets,
                    profitsMap,
                    hackMoneyRatio,
                    ramUsage,
                    servers,
                    attacksLaunched,
                    freeRams.overallFreeRam,
                    freeRams.overallMaxRam,
                    incomePerSecond
                );
            }

        } catch (error) {
            ns.tprint(`ERROR: ${String(error)}`);
        }
        await ns.sleep(CONFIG.timing.cycleSleep);
    }
}

/**
 * Scan the network, nuke servers, and copy scripts
 * @param {NS} ns - Netscript API
 * @param {string[]} scriptsToDeploy - Scripts to copy to servers
 * @returns {Set<string>} Set of available servers
 */
function scanAndUpdateNetwork(ns: NS, scriptsToDeploy: string[]): Set<string> {
    const servers = scanAndNuke(ns);
    copyScripts(ns, scriptsToDeploy, 'home', Array.from(servers));
    return servers;
}

/**
 * Main hacking logic with timeout protection
 * @param {NS} ns - Netscript API
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string[]} targets - Array of potential hack targets
 * @param {Set<string>} growStocks - Set of stocks to grow
 * @param {Set<string>} hackStocks - Set of stocks to hack
 * @param {number} hackMoneyRatio - Current hack money ratio
 * @returns {Promise<number>} Number of attacks launched
 */
async function manageAndHackWithTimeout(
    ns: NS,
    freeRams: RamUsage,
    targets: string[],
    growStocks: Set<string>,
    hackStocks: Set<string>,
    hackMoneyRatio: number
): Promise<number> {
    // Add timeout protection for thread calculations
    const startTime = Date.now();
    let attacksLaunched = 0;

    // First, handle stock manipulation if enabled and cooldown has passed
    if (STOCK_MANIPULATION_CONFIG.enabled &&
        Date.now() - lastManipulationTime > STOCK_MANIPULATION_CONFIG.manipulationCooldown) {
        const manipulationTargets = getManipulationTargets(ns, targets);
        if (manipulationTargets.length > 0) {
            attacksLaunched += manipulateStocks(ns, freeRams, manipulationTargets);
            lastManipulationTime = Date.now();
        }
    }

    for (const target of targets) {
        // Check for timeout
        if (CONFIG.features.useTimedThreadAdjustment && Date.now() - startTime > CONFIG.timing.maxThreadCalculationTime) {
            ns.tprint(`WARNING: Thread calculation timeout reached after ${CONFIG.timing.maxThreadCalculationTime}ms`);
            break;
        }

        // Skip if we've maxed out parallel attacks
        if (attacksLaunched >= CONFIG.maxParallelAttacks) break;

        // Handle server preparation (weaken/grow) and attacks
        const attackResult = await handleServerAttack(ns, freeRams, target, growStocks, hackStocks, hackMoneyRatio);
        if (attackResult) attacksLaunched++;
    }

    return attacksLaunched;
}

/**
 * Handle attack preparation and execution for a single server
 * @param {NS} ns - Netscript API
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string} target - Target server
 * @param {Set<string>} growStocks - Set of stocks to grow
 * @param {Set<string>} hackStocks - Set of stocks to hack
 * @param {number} hackMoneyRatio - Current hack money ratio
 * @returns {Promise<boolean>} Whether an attack was launched
 */
async function handleServerAttack(
    ns: NS,
    freeRams: RamUsage,
    target: string,
    growStocks: Set<string>,
    hackStocks: Set<string>,
    hackMoneyRatio: number
): Promise<boolean> {
    const serverMoney = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const securityLevel = ns.getServerSecurityLevel(target);
    const minSecurityLevel = ns.getServerMinSecurityLevel(target);

    // If security is too high, weaken first
    if (securityLevel > minSecurityLevel + CONFIG.thresholds.securityThresholdOffset) {
        if (launchWeaken(ns, freeRams, target)) {
            partialWeakGrow = target;
            return true;
        }
        return false;
    }

    // If money is too low, grow first
    if (serverMoney < maxMoney * CONFIG.thresholds.moneyThresholdPercentage) {
        // Check if this server needs to be grown for stocks
        const shouldGrow = growStocks.has(target) || !hackStocks.has(target);

        if (shouldGrow && launchGrow(ns, freeRams, target)) {
            partialWeakGrow = target;
            return true;
        }
        return false;
    }

    // If we reached here, server is ready for hacking
    // Reset partial weak/grow indicator
    if (partialWeakGrow === target) {
        partialWeakGrow = null;
    }

    // Should we hack this server for stock manipulation?
    const shouldHack = !growStocks.has(target) || hackStocks.has(target);

    if (shouldHack) {
        const strategy = await calculateStrategyWithTimeout(ns, target, hackMoneyRatio);

        if (launchAttack(ns, freeRams, target, strategy)) {
            // Track profit per minute for this server
            const profit = strategy.hackThreads * maxMoney * hackMoneyRatio * ns.hackAnalyze(target);
            const hackTime = ns.getHackTime(target);
            const profitPerMinute = profit / (hackTime / 60000);
            profitsMap.set(target, profitPerMinute);
            return true;
        }
    }

    return false;
}

/**
 * Calculate attack strategy with timeout protection
 * @param {NS} ns - Netscript API
 * @param {string} target - Target server
 * @param {number} hackMoneyRatio - Current hack money ratio
 * @returns {Promise<AttackStrategy>} Attack strategy
 */
async function calculateStrategyWithTimeout(ns: NS, target: string, hackMoneyRatio: number): Promise<AttackStrategy> {
    const startTime = Date.now();

    // Base strategy calculation
    let strategy = calculateStrategy(ns, target, hackMoneyRatio);

    // If the feature is enabled, attempt to optimize threads within time limit
    if (CONFIG.features.useTimedThreadAdjustment) {
        let iterationCount = 0;
        const maxIterations = 10000; // Safety limit

        // Dynamic thread adjustment with timeout
        while (!isStrategyFeasible(ns, strategy) &&
            Date.now() - startTime < CONFIG.timing.maxThreadCalculationTime / 10 &&
            iterationCount < maxIterations) {

            // Adjust ratio to find a feasible strategy
            hackMoneyRatio = Math.max(CONFIG.thresholds.hackMoneyRatioMin, hackMoneyRatio * 0.95);
            strategy = calculateStrategy(ns, target, hackMoneyRatio);

            iterationCount++;
            await ns.sleep(1); // Prevent UI freezing
        }

        if (iterationCount >= maxIterations) {
            ns.tprint(`WARNING: Hit max iterations (${maxIterations}) when calculating strategy for ${target}`);
        }
    }

    return strategy;
}

/**
 * Check if a strategy is feasible given current RAM constraints
 * @param {NS} ns - Netscript API
 * @param {AttackStrategy} strategy - Attack strategy
 * @returns {boolean} Whether the strategy is feasible
 */
function isStrategyFeasible(ns: NS, strategy: AttackStrategy): boolean {
    // Simple feasibility check - can be expanded
    return strategy.totalThreads > 0 && strategy.hackThreads > 0;
}

/**
 * Run additional features like contract solving, sharing, and XP weakening
 * @param {NS} ns - Netscript API
 * @param {RamUsage} freeRams - RAM usage information
 * @param {Set<string>} servers - Set of servers
 * @param {string[]} targets - Array of potential hack targets
 * @param {boolean} moneyXpShare - Whether to share computing power
 * @param {number} hackMoneyRatio - Current hack money ratio
 * @param {number} shareThreadIndex - Current thread index for sharing
 * @returns {Promise<number>} Updated shareThreadIndex
 */
async function runAdditionalFeatures(
    ns: NS,
    freeRams: RamUsage,
    servers: Set<string>,
    targets: string[],
    moneyXpShare: boolean,
    hackMoneyRatio: number,
    shareThreadIndex: number
): Promise<number> {
    let updatedShareThreadIndex = shareThreadIndex;

    // Try to solve contracts if we have RAM
    attemptSolveContracts(ns);
    // Share computing power if configured
    if (moneyXpShare && hackMoneyRatio >= 0.99) {
        updatedShareThreadIndex = shareComputingPower(ns, shareThreadIndex, freeRams);
    }

    // Run XP weaken if we have spare RAM
    const ramUsage = freeRams.utilization;
    if (ramUsage < CONFIG.thresholds.ramUsageLow && hackMoneyRatio >= 0.99) {
        await xpWeakenWithTimeout(ns, freeRams, servers, targets);
    }

    return updatedShareThreadIndex;
}

/**
 * Run XP weaken with timeout protection
 * @param {NS} ns - Netscript API
 * @param {RamUsage} freeRams - RAM usage information
 * @param {Set<string>} servers - Set of servers
 * @param {string[]} targets - Array of potential hack targets
 */
async function xpWeakenWithTimeout(ns: NS, freeRams: RamUsage, servers: Set<string>, targets: string[]): Promise<void> {
    const startTime = Date.now();
    const xpWeakSleep = 1;

    // Sort targets by XP gain potential
    const playerHackingLevel = ns.getHackingLevel();
    targets.sort((a, b) => {
        return weakenXPgainCompare(ns, playerHackingLevel, a) - weakenXPgainCompare(ns, playerHackingLevel, b);
    });

    // Find a good target for XP
    for (const target of targets) {
        // Check for timeout
        if (CONFIG.features.useTimedThreadAdjustment && Date.now() - startTime > CONFIG.timing.maxThreadCalculationTime / 10) {
            ns.tprint('WARNING: XP weaken calculation timeout reached');
            break;
        }

        // Only target servers that don't already have XP attacks running
        if (!xpAttackOngoing(ns, servers, target, xpWeakSleep)) {
            // Calculate threads based on available RAM (use only 60% to leave buffer)
            const weakThreads = Math.floor((freeRams.overallFreeRam / SCRIPT_RAM.slaveScript) * 0.6);
            const weakenTime = ns.getWeakenTime(target);

            if (weakThreads > 0) {
                await distributeTaskWithRetry(ns, SCRIPT_PATH.weaken, weakThreads, freeRams, target, xpWeakSleep);
                return;
            }
        }
    }
}

/**
 * Distribute a task across servers with retry mechanism
 * @param {NS} ns - Netscript API
 * @param {string} script - Script to run
 * @param {number} threads - Number of threads to run the script with
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string} target - Target server
 * @param {number} sleepTime - Sleep time for the script
 * @param {boolean | string} manipulateStock - Whether to manipulate stock
 * @returns {Promise<boolean>} Whether the task was successfully distributed
 */
async function distributeTaskWithRetry(
    ns: NS,
    script: string,
    threads: number,
    freeRams: RamUsage,
    target: string,
    sleepTime: number = 0,
    manipulateStock: boolean | string = false
): Promise<boolean> {
    const maxRetries = 3;
    let retriesLeft = maxRetries;

    while (retriesLeft > 0) {
        const success = distributeTask(ns, script, threads, freeRams, target, sleepTime, manipulateStock);
        if (success) return true;

        // If failed, wait a bit and retry with fewer threads
        retriesLeft--;
        threads = Math.floor(threads * 0.8); // Try with 80% of threads
        if (threads < 1) return false;

        await ns.sleep(100);
    }

    return false;
}

/**
 * Handle server purchases
 * @param {NS} ns - Netscript API
 */
function handleServerPurchases(ns: NS): void {
    const { baseReserve, cashToSpend, currentCash } = calculateDynamicReserve(ns);
    if (cashToSpend > 0) {
        // upgradeByBudget(ns, CONFIG.serverPurchase.maxPurchasedRam, cashToSpend); 
        ns.exec('purchase_server.js', 'home', 1, CONFIG.serverPurchase.maxPurchasedRam, cashToSpend);
    }
}

/**
 * Adjusts initial hack money ratio based on home server RAM
 * @param {NS} ns - Netscript API
 */
function adjustInitialHackMoneyRatio(ns: NS, initRatio: number = 0.1): number {
    const homeRam = ns.getServerMaxRam('home');
    let hackMoneyRatio = initRatio;
    if (homeRam >= 65536) { hackMoneyRatio = 0.99; }
    else if (homeRam >= 16384) { hackMoneyRatio = 0.9; }
    else if (homeRam > 8192) { hackMoneyRatio = 0.5; }
    else if (homeRam > 2048) { hackMoneyRatio = 0.2; }
    return hackMoneyRatio;
}

/**
 * Attempts to run solve-contracts script if enough RAM is available
 * @param {NS} ns - Netscript API
 */
function attemptSolveContracts(ns: NS): void {
    if (!CONFIG.features.solveContracts) return;

    // Check if the script exists
    if (!ns.fileExists(SCRIPT_PATH.solveContracts, 'home')) return;

    // Check if it's already running
    if (ns.isRunning(SCRIPT_PATH.solveContracts, 'home')) return;

    // Get home server RAM
    const homeMaxRam = ns.getServerMaxRam('home');
    const homeUsedRam = ns.getServerUsedRam('home');
    const scriptRam = ns.getScriptRam(SCRIPT_PATH.solveContracts, 'home');

    // Only run if enough RAM is available
    if (homeMaxRam - homeUsedRam >= scriptRam + CONFIG.ram.minReserveHomeRam) {
        ns.exec(SCRIPT_PATH.solveContracts, 'home', 1);
    }
}

/**
 * Share computing power for faction reputation
 * @param {NS} ns - Netscript API
 * @param shareThreadIndex - Current thread index
 * @param freeRams - RAM usage information
 * @returns Updated shareThreadIndex
 */
function shareComputingPower(ns: NS, shareThreadIndex: number, freeRams: RamUsage): number {
    const maxRam = ns.getServerMaxRam('home');
    const usedRam = ns.getServerUsedRam('home');
    const freeRam = maxRam - usedRam;
    const shareThreads = Math.floor(freeRam / SCRIPT_RAM.shareScript);

    if (shareThreads > 0) {
        ns.exec(SCRIPT_PATH.share, 'home', shareThreads, shareThreadIndex);
        freeRams.reserveRam(shareThreads * SCRIPT_RAM.shareScript, 'home');
        if (shareThreadIndex > 9) {
            shareThreadIndex = 0;
        } else {
            shareThreadIndex++;
        }
    }
    return shareThreadIndex;
}

/**
 * Adjusts hack money ratio based on RAM usage and attack success
 * @param {NS} ns - Netscript API
 * @param ramUsage - Current RAM usage ratio
 * @param hackMoneyRatio - Current hack money ratio
 * @returns Adjusted hack money ratio
 */
function adjustHackMoneyRatio(ns: NS, ramUsage: number, currentRatio: number): number {
    // Already using lots of RAM at high ratio, decrease
    if (ramUsage > CONFIG.thresholds.ramUsageHigh && currentRatio > CONFIG.thresholds.hackMoneyRatioMin) {
        const newRatio = Math.max(CONFIG.thresholds.hackMoneyRatioMin, currentRatio * 0.95);
        return newRatio;
    }
    // Low RAM usage, increase ratio to use more capacity
    if (ramUsage < CONFIG.thresholds.ramUsageLow && currentRatio < CONFIG.thresholds.hackMoneyRatioMax) {
        const newRatio = Math.min(CONFIG.thresholds.hackMoneyRatioMax, currentRatio * 1.05);
        return newRatio;
    }
    // No adjustment needed
    return currentRatio;
}


/**
 * Calculate the optimal strategy for a target server
 * @param {NS} ns - Netscript API
 * @param {string} target - Target server
 * @param {number} hackMoneyRatio - Current hack money ratio
 * @returns {AttackStrategy} Attack strategy
 */
function calculateStrategy(ns: NS, target: string, hackMoneyRatio: number): AttackStrategy {
    const server = ns.getServer(target);
    const player = ns.getPlayer();
    const cores = ns.getServer('home').cpuCores;

    // Add null checks for server properties
    const maxMoney = server.moneyMax ?? 0;
    const serverGrowth = server.serverGrowth ?? 0;
    const minDifficulty = server.minDifficulty ?? 0;

    let hackThreads: number;
    let growThreads: number;
    let weakenThreads: number;
    let weakenForHackThreads: number;

    if (ns.fileExists('Formulas.exe')) {
        const formulas = ns.formulas.hacking;

        // Calculate hack threads using formulas
        const hackPercent = formulas.hackPercent(server, player);
        hackThreads = Math.floor(hackMoneyRatio / hackPercent);

        // Calculate grow threads using formulas
        const targetMoney = maxMoney;
        growThreads = formulas.growThreads(server, player, targetMoney, cores);

        // Calculate weaken threads using formulas
        const hackSecurityIncrease = ns.hackAnalyzeSecurity(hackThreads);
        weakenForHackThreads = Math.ceil(hackSecurityIncrease / CONFIG.security.weakenSecurityDecrease);

        const growSecurityIncrease = ns.growthAnalyzeSecurity(growThreads);
        weakenThreads = Math.ceil(growSecurityIncrease / CONFIG.security.weakenSecurityDecrease);
    } else {
        // Fallback to original calculations
        const serverMoney = ns.getServerMoneyAvailable(target);
        const hackPercent = ns.hackAnalyze(target);
        const stealAmount = serverMoney * hackMoneyRatio;
        hackThreads = Math.floor(stealAmount / (serverMoney * hackPercent));
        const hackSecurityIncrease = ns.hackAnalyzeSecurity(hackThreads);
        weakenForHackThreads = Math.ceil(hackSecurityIncrease / CONFIG.security.weakenSecurityDecrease);
        const growthRequired = 1 / (1 - hackMoneyRatio);
        growThreads = Math.ceil(ns.growthAnalyze(target, growthRequired));
        const growSecurityIncrease = ns.growthAnalyzeSecurity(growThreads);
        weakenThreads = Math.ceil(growSecurityIncrease / CONFIG.security.weakenSecurityDecrease);
    }

    const totalThreads = hackThreads + growThreads + weakenThreads + weakenForHackThreads;
    const totalRAM = totalThreads * (ns.getServerMaxRam('home') * SCRIPT_RAM.slaveScript);

    return {
        hackThreads,
        growThreads,
        weakenThreads,
        weakenForHackThreads,
        totalThreads,
        totalRAM,
        serverValue: maxMoney * serverGrowth * ns.hackAnalyze(target),
        maxStealPercentage: hackMoneyRatio
    };
}

/**
 * Given a strategy, launch the HGW attack
 * @param {NS} ns - Netscript API
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string} target - Target server
 * @param {AttackStrategy} strategy - Attack strategy
 * @returns {boolean} True if the attack was successful, false otherwise
 */
function launchAttack(ns: NS, freeRams: RamUsage, target: string, strategy: AttackStrategy): boolean {
    const { hackThreads, growThreads, weakenThreads, weakenForHackThreads } = strategy;

    if (freeRams.overallFreeRam < (hackThreads + growThreads + weakenThreads + weakenForHackThreads) * SCRIPT_RAM.slaveScript) {
        return false; // Skip if not enough ram
    }

    // Compact single-line output
    if (hackThreads > 0 && !distributeTask(ns, SCRIPT_PATH.hack, hackThreads, freeRams, target)) { return false; }
    if (growThreads > 0 && !distributeTask(ns, SCRIPT_PATH.grow, growThreads, freeRams, target)) { return false; }
    if (weakenThreads > 0 && !distributeTask(ns, SCRIPT_PATH.weaken, weakenThreads, freeRams, target, 0)) { return false; }
    if (weakenForHackThreads > 0 && !distributeTask(ns, SCRIPT_PATH.weaken, weakenForHackThreads, freeRams, target, 0)) { return false; }
    return true;
}

/**
 * Performing a Weaken attack
 * @param {NS} ns - Netscript API
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string} target - Target server
 * @returns {boolean} True if the attack was successful, false otherwise
 */
function launchWeaken(ns: NS, freeRams: RamUsage, target: string): boolean {
    const securityLevel = ns.getServerSecurityLevel(target);
    const minSecurityLevel = ns.getServerMinSecurityLevel(target);
    const securityDiff = securityLevel - minSecurityLevel;
    const threads = Math.ceil(securityDiff / CONFIG.security.weakenSecurityDecrease);
    return distributeTask(ns, SCRIPT_PATH.weaken, threads, freeRams, target, 0);
}

/**
 * Performing a Grow-Weaken attack
 * @param {NS} ns - Netscript API
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string} target - Target server
 * @returns {boolean} True if the attack was successful, false otherwise
 */
function launchGrow(ns: NS, freeRams: RamUsage, target: string): boolean {
    const currentMoney = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const moneyRatio = maxMoney / Math.max(1, currentMoney);
    const growThreads = Math.ceil(ns.growthAnalyze(target, moneyRatio));
    const growSecurityIncrease = ns.growthAnalyzeSecurity(growThreads);
    const weakenThreads = Math.ceil(growSecurityIncrease / CONFIG.security.weakenSecurityDecrease);
    const totalThreads = growThreads + weakenThreads;
    if (freeRams.overallFreeRam < totalThreads * SCRIPT_RAM.slaveScript) {
        return false; // Skip if not enough total RAM
    }
    const growDone = distributeTask(ns, SCRIPT_PATH.grow, growThreads, freeRams, target);
    if (!growDone) { return false; }
    const weakenDone = distributeTask(ns, SCRIPT_PATH.weaken, weakenThreads, freeRams, target, 0);
    return weakenDone;
}

/**
 * Finds a place to run a script on a server
 * @param {NS} ns - Netscript API
 * @param {string} script - Script to run
 * @param {number} threads - Number of threads to run the script with
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string} target - Target server
 * @param {number} sleepTime - Sleep time for the script
 * @param {boolean | string} manipulateStock - Whether to manipulate stock
 * @returns {boolean} True if the script was successfully launched, false otherwise
 */
function distributeTask(ns: NS, script: string, threads: number, freeRams: RamUsage,
    target: string, sleepTime: number = 0, manipulateStock: boolean | string = false): boolean {
    if (threads <= 0) return true;

    const scriptRam = ns.getScriptRam(script);
    const totalRamNeeded = scriptRam * threads;
    // Check if we have enough total RAM
    if (freeRams.overallFreeRam < totalRamNeeded) { return false; }
    // Copy the serverRams array to avoid modifying during iteration
    const serverRamsCopy = freeRams.serverRams;
    // Distribute threads among servers
    let remainingThreads = threads;
    const serversUsed: string[] = [];
    // 
    for (const serverRamInfo of serverRamsCopy) {
        if (remainingThreads <= 0) break;
        const maxThreads = Math.floor(serverRamInfo.freeRam / scriptRam);
        if (maxThreads <= 0) continue;
        const threadsToRun = Math.min(maxThreads, remainingThreads);
        if (!ns.fileExists(script, serverRamInfo.host)) {
            if (!ns.scp(script, serverRamInfo.host, 'home')) {
                const errorMsg = `Failed to copy ${script} to ${serverRamInfo.host}`;
                ns.write('/tmp/log.txt', errorMsg + '\n', 'a');
                continue;
            }
        }

        // Run the script with arguments matching the original JS design
        let pid;
        if (manipulateStock) {
            pid = ns.exec(script, serverRamInfo.host, threadsToRun, target, sleepTime, manipulateStock);
        } else {
            pid = ns.exec(script, serverRamInfo.host, threadsToRun, target, sleepTime);
        }

        if (pid > 0) {
            // Successfully started script
            remainingThreads -= threadsToRun;
            serversUsed.push(serverRamInfo.host);
            // Update the original server in freeRams
            freeRams.reserveRam(threadsToRun * scriptRam, serverRamInfo.host);
        } else {
            const errorMsg = `Failed to execute ${script} on ${serverRamInfo.host} with ${threadsToRun} threads`;
            ns.write('/tmp/log.txt', errorMsg + '\n', 'a');
        }
    }

    // Only log distribution across multiple servers to the error log to keep main log clean
    if (serversUsed.length > 1) {
        ns.write('/tmp/log.txt', `Distributed ${script} for ${target} across ${serversUsed.length} servers\n`, 'a');
    }

    return remainingThreads === 0;
}

/**
 * Compare targets for XP gain potential
 * @param {NS} ns - Netscript API
 * @param playerHackingLevel - Current player hacking level
 * @param target - Target server
 * @returns Relative XP gain value
 */
function weakenXPgainCompare(ns: NS, playerHackingLevel: number, target: string): number {
    // Calculate XP factor
    const xpPerWeaken = (playerHackingLevel - ns.getServerRequiredHackingLevel(target)) / playerHackingLevel;
    // XP per time unit
    const xpPerTime = xpPerWeaken / ns.getWeakenTime(target);
    return xpPerTime;
}

/**
 * Check if there's already an XP attack ongoing against a target
 * @param {NS} ns - Netscript API
 * @param servers - Set of servers
 * @param target - Target server
 * @param weakSleep - Sleep time for XP weaken threads
 * @returns Whether an XP attack is ongoing
 */
function xpAttackOngoing(ns: NS, servers: Set<string>, target: string, weakSleep: number): boolean {
    for (const server of servers) {
        if (ns.isRunning(SCRIPT_PATH.weaken, server, target, weakSleep)) {
            return true;
        }
    }
    return false;
}

/**
 * Get a list of hackable servers sorted by profitability with improved metrics
 * @param {NS} ns - Netscript API
 * @param servers - Array of servers
 * @returns Array of hackable servers sorted by priority
 */
function getHackableServers(ns: NS, allServers: string[]): string[] {
    // Get all servers that can be hacked, sorted by profitability
    const playerHackLevel = ns.getHackingLevel();
    const targets = allServers.filter(server => {
        const maxMoney = ns.getServerMaxMoney(server);
        const requiredHackLevel = ns.getServerRequiredHackingLevel(server);
        return maxMoney > 0 && requiredHackLevel <= playerHackLevel;
    });
    return targets.sort((a, b) => calculateServerScore(ns, b) - calculateServerScore(ns, a));
}

/**
 * Calculate available RAM across the network with enhanced functionality
 * @param {NS} ns - Netscript API
 * @param servers - Set of servers
 * @returns RAM usage information with utility methods
 */
function getFreeRam(ns: NS, servers: Set<string>): RamUsage {
    const freeRams = new RamUsage();

    // Filter servers based on purchased server RAM if feature is enabled
    const filteredServers = filterServersByRam(ns, servers);

    for (const server of filteredServers) {
        if (server === 'home' && !CONFIG.ram.useHomeRam) continue;
        const maxRam = ns.getServerMaxRam(server);
        const usedRam = ns.getServerUsedRam(server);
        let freeRam = maxRam - usedRam;

        // Use dynamic RAM reservation for home server based on percentage
        if (server === 'home') {
            // Calculate the amount to reserve based on percentage
            const reserveAmount = Math.min(
                CONFIG.ram.maxReserveHomeRAM,
                Math.max(
                    maxRam * CONFIG.ram.reservedHomeRamPercentage,
                    CONFIG.ram.minReserveHomeRam // Ensure backward compatibility
                )
            );

            freeRam -= reserveAmount;
            if (freeRam < 0) freeRam = 0;
        }

        if (freeRam >= CONFIG.thresholds.minimumServerRam) {
            freeRams.addServer(server, freeRam, maxRam);
        }
    }

    return freeRams;
}

/**
 * Filter servers based on purchased server RAM
 * Only include servers with RAM >= minimum purchased server RAM
 * @param {NS} ns - Netscript API
 * @param {Set<string>} servers - Set of all available servers
 * @returns {Set<string>} Filtered set of servers
 */
function filterServersByRam(ns: NS, servers: Set<string>): Set<string> {
    const purchasedServers = ns.getPurchasedServers();
    let minPurchasedRam = 4; // 4GB min if no purchased servers
    if (purchasedServers.length > 0) {
        minPurchasedRam = purchasedServers.reduce((min, server) => {
            const ram = ns.getServerMaxRam(server);
            return Math.min(min, ram);
        }, Infinity);
    }
    const filteredServers = new Set<string>();
    for (const server of servers) {
        if (server === 'home' || purchasedServers.includes(server)) {
            filteredServers.add(server);
            continue;
        }
        const ram = ns.getServerMaxRam(server);
        if (ram >= minPurchasedRam) {
            filteredServers.add(server);
        }
    }
    return filteredServers;
}

/**
 * Get content from a port for stock market manipulation
 * @param {NS} ns - Netscript API
 * @param portNumber - Port number to read from
 * @param content - Current content of the port
 * @returns Updated set of servers for stock manipulation
 */
function getStockPortContent(ns: NS, portNumber: number, currentSet: Set<string>): Set<string> {
    const portHandle = ns.getPortHandle(portNumber);

    if (portHandle.peek() !== 'NULL PORT DATA') {
        try {
            const data = JSON.parse(portHandle.read() as string);
            return new Set(data);
        } catch (error) {
            ns.tprint(`Error reading from port ${portNumber}: ${String(error)}`);
        }
    }
    return currentSet;
}

/**
 * Checks for the presence of required slave scripts, throws error if any are missing
 * @param {NS} ns - Netscript API
 */
function ensureSlaveScriptsExist(ns: NS): void {
    const requiredScripts = [
        SCRIPT_PATH.hack,
        SCRIPT_PATH.grow,
        SCRIPT_PATH.weaken,
        SCRIPT_PATH.share,
        SCRIPT_PATH.solveContracts
    ];

    const missingScripts = requiredScripts.filter(path => !ns.fileExists(path));
    if (missingScripts.length > 0) {
        ns.tprint(`Required script files missing: ${missingScripts.join(', ')}. Exiting.`);
        ns.exit();
    }
}

/**
 * Calculates a dynamic cash reserve based on owned server values
 * @param {NS} ns - Netscript API
 * @returns {Object} Information about the calculated reserve and available spending
 */
function calculateDynamicReserve(ns: NS): { baseReserve: number, cashToSpend: number, currentCash: number } {
    // Calculate the total cost of all owned servers
    const ownedServers = ns.getPurchasedServers();
    let totalServerValue = 0;

    // Calculate the total value of all owned servers
    for (const server of ownedServers) {
        const serverRam = ns.getServerMaxRam(server);
        totalServerValue += ns.getPurchasedServerCost(serverRam);
    }

    // Calculate reserve as a ratio of the total server cost
    // As server value grows, reserve grows proportionally
    const baseReserve = Math.max(
        CONFIG.serverPurchase.minCashReserve,
        totalServerValue * CONFIG.serverPurchase.cashRatio
    );

    // Calculate available cash after maintaining reserve
    const currentCash = ns.getPlayer().money;
    const cashToSpend = Math.max(0, currentCash - baseReserve);

    return { baseReserve, cashToSpend, currentCash };
}

// Add function to get manipulation targets
function getManipulationTargets(ns: NS, allTargets: string[]): string[] {
    const now = Date.now();
    return allTargets.filter(target => {
        // Only manipulate servers with corresponding stocks
        const stockSymbol = getStockSymbolFromServer(ns, target);
        if (!stockSymbol) return false;

        // Check cooldown for this stock
        const lastManipulated = manipulatedStocks.get(stockSymbol) || 0;
        if (now - lastManipulated < STOCK_MANIPULATION_CONFIG.manipulationCooldown) return false;

        // Check server conditions
        const money = ns.getServerMoneyAvailable(target);
        const maxMoney = ns.getServerMaxMoney(target);
        const security = ns.getServerSecurityLevel(target);
        const minSecurity = ns.getServerMinSecurityLevel(target);

        return money >= STOCK_MANIPULATION_CONFIG.minServerMoney &&
            security <= minSecurity + STOCK_MANIPULATION_CONFIG.maxSecurityOffset;
    }).slice(0, STOCK_MANIPULATION_CONFIG.maxManipulationServers);
}

// Add function to manipulate stocks
function manipulateStocks(ns: NS, freeRams: RamUsage, targets: string[]): number {
    let manipulationsLaunched = 0;

    for (const target of targets) {
        const stockSymbol = getStockSymbolFromServer(ns, target);
        if (!stockSymbol) continue;

        // Get current forecast
        const forecast = ns.stock.getForecast(stockSymbol);
        const desiredChange = STOCK_MANIPULATION_CONFIG.manipulationThreshold;

        // Determine whether to hack or grow based on current forecast
        if (forecast > 0.5 + desiredChange) {
            // If forecast is too high, hack to lower it
            if (launchHackForManipulation(ns, freeRams, target)) {
                manipulatedStocks.set(stockSymbol, Date.now());
                manipulationsLaunched++;
            }
        } else if (forecast < 0.5 - desiredChange) {
            // If forecast is too low, grow to raise it
            if (launchGrowForManipulation(ns, freeRams, target)) {
                manipulatedStocks.set(stockSymbol, Date.now());
                manipulationsLaunched++;
            }
        }
    }

    return manipulationsLaunched;
}

// Add function to get stock symbol from server name
function getStockSymbolFromServer(ns: NS, server: string): string | null {
    const org = ns.getServer(server).organizationName;
    if (!org) return null;

    // Try to find matching stock symbol
    const symbols = ns.stock.getSymbols();
    const symbol = symbols.find(s => s.includes(org.substring(0, 3)));
    return symbol || null;
}

// Add specialized hack function for manipulation
function launchHackForManipulation(ns: NS, freeRams: RamUsage, target: string): boolean {
    const hackThreads = Math.ceil(STOCK_MANIPULATION_CONFIG.manipulationThreshold /
        Math.abs(STOCK_MANIPULATION_CONFIG.hackEffect));
    return distributeTask(ns, SCRIPT_PATH.hack, hackThreads, freeRams, target, 0, true);
}

// Add specialized grow function for manipulation
function launchGrowForManipulation(ns: NS, freeRams: RamUsage, target: string): boolean {
    const growThreads = Math.ceil(STOCK_MANIPULATION_CONFIG.manipulationThreshold /
        STOCK_MANIPULATION_CONFIG.growEffect);
    return distributeTask(ns, SCRIPT_PATH.grow, growThreads, freeRams, target, 0, true);
}

function displayAllStats(
    ns: NS,
    startTime: number,
    targets: string[],
    profitsMap: Map<string, number>,
    hackMoneyRatio: number,
    ramUsage: number,
    servers: Set<string>,
    attacksLaunched: number,
    homeFree: number,
    homeRam: number,
    incomePerSecond: number
): void {
    // Get purchased server info for display
    const purchasedServers = ns.getPurchasedServers();
    const filteredServers = filterServersByRam(ns, servers);
    const filteredCount = filteredServers.size;
    const totalCount = servers.size;
    const filteredInfo = CONFIG.ram.ignoreServersLowerThanPurchased && purchasedServers.length > 0
        ? `${filteredCount}/${totalCount}`
        : `${totalCount}`;

    const displayLines = [
        '=== HACKING STATUS ===',
        `Hack Ratio: ${hackMoneyRatio.toFixed(2)}`,
        `RAM Usage: ${Math.round(ramUsage * 100)}%`,
        `Targets: ${targets.length}`,
        `Servers: ${filteredInfo}${purchasedServers.length > 0 ? ` (${purchasedServers.length} purchased)` : ''}`,
        `Attacks: ${attacksLaunched}`,
        `Home RAM: ${formatRam(homeFree)}/${formatRam(homeRam)}`,
        `Hacking Level: ${ns.getHackingLevel()}`,
        '',
        '=== PERFORMANCE ===',
        `Runtime: ${formatTime((Date.now() - startTime) / 1000)}`,
        `Income/sec: ${formatMoney(incomePerSecond)}`,
        '',
        '=== TOP TARGETS ===',
        'Server | Money | Security | Chance | Profit'
    ];

    // Add top 5 targets
    const topTargets = targets.slice(0, 5);
    for (const target of topTargets) {
        try {
            const money = ns.getServerMoneyAvailable(target);
            const maxMoney = ns.getServerMaxMoney(target);
            const security = ns.getServerSecurityLevel(target);
            const minSecurity = ns.getServerMinSecurityLevel(target);
            const hackChance = ns.hackAnalyzeChance(target);
            const profit = profitsMap.get(target) || 0;

            const moneyPercent = money / maxMoney * 100;
            const moneyText = `${formatMoney(money)}/${formatMoney(maxMoney)}`;
            const securityText = `${security.toFixed(1)}/${minSecurity.toFixed(1)}`;
            const chanceText = `${(hackChance * 100).toFixed(0)}%`;
            const profitText = formatMoney(profit);

            displayLines.push(`${target} | ${moneyText} (${moneyPercent.toFixed(1)}%) | ${securityText} | ${chanceText} | ${profitText}`);
        } catch (error) {
            displayLines.push(`${target} | Error: ${error} | Retrieving data`);
        }
    }
    prettyDisplay(ns, displayLines);
}
