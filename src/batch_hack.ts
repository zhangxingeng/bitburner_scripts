import { NS } from '@ns';
import { Allocator } from './hack_lib/allocator';
import { formatMoney, formatPercent } from './lib/util_low_ram';
import { findAllServers } from './lib/util_normal_ram';
import { FormulaHelper } from './hack_lib/formulas';
import { execMulti } from './hack_lib/exec_multi';
import {
    getAvailableServers,
    getTargetServers,
    isServerPrepared,
    getOptimalServer,
    formatRamStatusPanel,
    formatBatchInfoPanel,
    calculateServerValue
} from './hack_lib/batch_util';

/**
 * Represents a batch calculation result
 */
interface BatchCalculation {
    // Dollar per second
    dps: number;
    // Threads per batch
    tpb: number;
    // Server allocations
    hackServerAlloc: number[][];
    growServerAlloc: number[][];
    weaken1ServerAlloc: number[][];
    weaken2ServerAlloc: number[][];
    // Batch parameters
    concurrency: number;
    secondPerBatch: number;
    batchGap: number;
    // Operation parameters
    hackPerBatch: number;
    growPerBatch: number;
    // Thread counts
    weaken1ThreadsRaw: number;
    weaken2ThreadsRaw: number;
    // Operation times
    weakenTime: number;
    hackTime: number;
    growTime: number;
}

// Configuration constants
const CONFIG = {
    // Script paths
    SCRIPT_PATHS: {
        hack: '/remote/hack.js',
        grow: '/remote/grow.js',
        weaken1: '/remote/weaken.js',
        weaken2: '/remote/weaken.js',
        autoGrow: '/remote/auto_grow.js',
        share: '/remote/share.js',
        purchaseServer: '/purchase_server.js',
        upgradeHomeServer: '/basic/upgrade_home_server.js',
        buyPortOpener: '/basic/buy_port_opener.js',
        scanNuke: '/lib/scan_nuke.js'
    },
    // Operation timing
    TIMING: {
        stepTime: 20,      // Time between batch operations
        batchGap: 80       // Gap between batches (stepTime * 4)
    },
    // Security impacts
    SECURITY: {
        hackIncrease: 0.002,
        growIncrease: 0.004,
        weakenDecrease: 0.05
    },
    // RAM management
    RAM: {
        scriptRamCost: 1.75,
        useHomeRam: true,
        homeRamReserve: 128,    // GB to reserve on home
        minServerRam: 64,        // Minimum server RAM to use
        maxShareRamPercent: 0.2 // Maximum percentage of RAM to use for share
    },
    // Targeting
    TARGETING: {
        maxTargets: 4,        // Maximum number of targets to hack simultaneously 
        nukeInterval: 60,     // How often to run the nuke scanner (seconds)
        moneyThreshold: 0.9,  // 90% of max money
        securityThreshold: 3, // Within 3 of min security
        portOpenerInterval: 30 // How often to buy port openers (seconds)
    },
    // Maintenance intervals
    INTERVALS: {
        serverPurchase: 300,    // How often to check for server purchases (seconds)
        upgradeHomeServer: 60,  // How often to check for home server upgrades (seconds)
        shareInterval: 10       // How often to redistribute share RAM (seconds)
    },
    // Feature flags
    FEATURES: {
        enableShare: true,      // Whether to use excess RAM for sharing
        enableAutoServerPurchase: true // Whether to automatically purchase servers
    }
};

let formulaHelper: FormulaHelper;
let lastNukeTime = 0;
let lastPortOpenerTime = 0;
let lastServerPurchaseTime = 0;
let lastUpgradeHomeServerTime = 0;
let lastShareTime = 0;

/**
 * Nuke all available servers
 */
async function nukeAll(ns: NS): Promise<void> {
    try {
        const nukePs = await ns.exec(CONFIG.SCRIPT_PATHS.scanNuke, 'home', 1);
        for (let i = 0; i < 1000; i++) {
            if (!ns.isRunning(nukePs)) { break; }
            await ns.sleep(100);
        }
    } catch (error) { /* pass */ }
}

/**
 * Buy port openers if we have enough money
 */
async function buyPortOpeners(ns: NS): Promise<void> {
    try {
        ns.exec(CONFIG.SCRIPT_PATHS.buyPortOpener, 'home', 1);
    } catch (error) { /* pass */ }
}

/**
 * Purchase servers with available funds
 */
async function purchaseServers(ns: NS): Promise<void> {
    try {
        // Calculate budget - use 20% of current money
        const budget = ns.getServerMoneyAvailable('home') * 0.2;

        if (budget > ns.getPurchasedServerCost(CONFIG.RAM.minServerRam)) {
            ns.exec(CONFIG.SCRIPT_PATHS.purchaseServer, 'home', 1, budget);
        }
    } catch (error) { /* pass */ }
}

/**
 * Upgrade home server if we have enough money
 */
async function upgradeHomeServer(ns: NS): Promise<void> {
    try {
        ns.exec(CONFIG.SCRIPT_PATHS.upgradeHomeServer, 'home', 1);
    } catch (error) { /* pass */ }
}

/**
 * Run auto-grow scripts to prepare servers
 */
async function autoGrowServers(ns: NS, targets: string[], availableServers: string[]): Promise<void> {
    const autoGrowScript = CONFIG.SCRIPT_PATHS.autoGrow;

    ns.print(`Preparing ${targets.length} servers for hacking...`);

    // Find servers that need preparation
    const unpreparedTargets = targets.filter(target =>
        !isServerPrepared(ns, target, CONFIG.TARGETING.moneyThreshold, CONFIG.TARGETING.securityThreshold)
    );

    if (unpreparedTargets.length === 0) {
        ns.print('All targets are already prepared.');
        return;
    }

    // Distribute targets across available servers more evenly
    let serverIndex = 0;
    for (const target of unpreparedTargets) {
        // Use multiple servers for each target
        for (let i = 0; i < Math.min(3, availableServers.length); i++) {
            const serverToUse = availableServers[(serverIndex + i) % availableServers.length];
            const ram = ns.getServerMaxRam(serverToUse) - ns.getServerUsedRam(serverToUse);

            // Calculate grow threads
            const scriptRam = ns.getScriptRam(autoGrowScript);
            const growThreads = Math.floor(ram / scriptRam / 2); // Use half the available RAM

            if (growThreads > 0) {
                ns.print(`Growing ${target} on ${serverToUse} with ${growThreads} threads`);

                // Execute grow script
                execMulti(ns, serverToUse, growThreads, autoGrowScript, target);
            }
        }
        serverIndex = (serverIndex + 1) % availableServers.length;
    }

    // Wait for servers to be prepared
    let allPrepared = false;
    let iterations = 0;
    const maxIterations = 300; // Prevent infinite waiting

    while (!allPrepared && iterations < maxIterations) {
        await ns.sleep(1000);
        iterations++;

        // Check if all targets are prepared
        allPrepared = true;

        for (const target of unpreparedTargets) {
            if (!isServerPrepared(ns, target, CONFIG.TARGETING.moneyThreshold, CONFIG.TARGETING.securityThreshold)) {
                allPrepared = false;
                break;
            }
        }

        // Print status every 15 seconds
        if (iterations % 15 === 0) {
            const preparedCount = unpreparedTargets.filter(target =>
                isServerPrepared(ns, target, CONFIG.TARGETING.moneyThreshold, CONFIG.TARGETING.securityThreshold)
            ).length;

            // Create compact stats panel
            const statsPanel = [
                '┌─── SERVER PREPARATION ───┐',
                `│ Total Targets: ${unpreparedTargets.length.toString().padEnd(5)} │`,
                `│ Prepared:      ${preparedCount.toString().padEnd(5)} │`,
                `│ Remaining:     ${(unpreparedTargets.length - preparedCount).toString().padEnd(5)} │`,
                '└────────────────────────┘'
            ].join('\n');

            ns.print(statsPanel);
        }
    }

    // Kill any remaining grow scripts
    for (const server of availableServers) {
        if (ns.scriptRunning(autoGrowScript, server)) {
            ns.scriptKill(autoGrowScript, server);
        }
    }

    ns.print('Server preparation complete!');
}

/**
 * Calculate batch strategy for a target
 */
async function calculateBatchStrategy(
    ns: NS,
    target: string,
    hackThreads: number,
    availableAllocs: number[]
): Promise<BatchCalculation | null> {
    // Get server and player info
    const serverOptimal = getOptimalServer(ns, target);
    const player = ns.getPlayer();

    // Calculate operation times
    const weakenTime = formulaHelper.getWeakenTime(serverOptimal, player);
    const hackTime = formulaHelper.getHackTime(serverOptimal, player);
    const growTime = formulaHelper.getGrowTime(serverOptimal, player);

    // Calculate batch gap
    const batchGap = CONFIG.TIMING.batchGap;

    // Calculate maximum possible batches
    const maxBatches = Math.floor(hackTime / batchGap + 1);

    // Calculate money stolen per hack
    const hackPercent = formulaHelper.getHackPercent(serverOptimal, player);
    const moneyMax = serverOptimal.moneyMax || 1;
    const moneyAvailable = serverOptimal.moneyAvailable || moneyMax;
    const dollarPerHack = Math.min(moneyMax, moneyAvailable * hackPercent * hackThreads);

    // Calculate thread requirements
    const hackThreadsRaw = hackThreads;

    // Create server copy for grow calculation
    const serverBeforeGrow = getOptimalServer(ns, target);
    const serverMoneyMax = serverBeforeGrow.moneyMax || 1;
    serverBeforeGrow.moneyAvailable = Math.max(1, (serverMoneyMax - dollarPerHack));

    // Calculate grow threads needed
    const growThreadsRaw = formulaHelper.getGrowThreads(serverBeforeGrow, player, hackThreads);

    // Calculate weaken threads needed
    const weaken1ThreadsRaw = hackThreadsRaw * CONFIG.SECURITY.hackIncrease / CONFIG.SECURITY.weakenDecrease;
    const weaken2ThreadsRaw = growThreadsRaw * CONFIG.SECURITY.growIncrease / CONFIG.SECURITY.weakenDecrease;

    // Create thread allocation arrays
    const hackServerAlloc: number[][] = [];
    const growServerAlloc: number[][] = [];
    const weaken1ServerAlloc: number[][] = [];
    const weaken2ServerAlloc: number[][] = [];

    // Create an allocator to distribute threads across servers
    const allocator = new Allocator(availableAllocs);

    // Try to allocate threads for each batch
    let batchCount = 0;

    while (batchCount < maxBatches) {
        // Try to allocate hack threads (non-splittable)
        const hackAllocRes = allocator.alloc(Math.ceil(hackThreadsRaw), false);
        if (!hackAllocRes.success) break;
        hackServerAlloc.push(hackAllocRes.allocation);

        // Try to allocate grow threads (non-splittable)
        const growAllocRes = allocator.alloc(Math.ceil(growThreadsRaw), false);
        if (!growAllocRes.success) {
            allocator.free(hackServerAlloc.pop()!);
            break;
        }
        growServerAlloc.push(growAllocRes.allocation);

        // Try to allocate weaken1 threads (splittable)
        const weaken1AllocRes = allocator.alloc(Math.ceil(weaken1ThreadsRaw), true);
        if (!weaken1AllocRes.success) {
            allocator.free(hackServerAlloc.pop()!);
            allocator.free(growServerAlloc.pop()!);
            break;
        }
        weaken1ServerAlloc.push(weaken1AllocRes.allocation);

        // Try to allocate weaken2 threads (splittable)
        const weaken2AllocRes = allocator.alloc(Math.ceil(weaken2ThreadsRaw), true);
        if (!weaken2AllocRes.success) {
            allocator.free(hackServerAlloc.pop()!);
            allocator.free(growServerAlloc.pop()!);
            allocator.free(weaken1ServerAlloc.pop()!);
            break;
        }
        weaken2ServerAlloc.push(weaken2AllocRes.allocation);

        batchCount++;

        // Small wait to prevent excessive CPU usage
        if (batchCount % 5 === 0) {
            await ns.sleep(1);
        }
    }

    // If no batches could be allocated, return null
    if (batchCount === 0) {
        // Try again with just one minimal batch
        const minHackThreads = Math.max(1, Math.floor(hackThreadsRaw / 2));
        const hackAllocRes = allocator.alloc(minHackThreads, false);
        if (!hackAllocRes.success) return null;
        hackServerAlloc.push(hackAllocRes.allocation);

        const minGrowThreads = Math.max(1, Math.floor(growThreadsRaw / 2));
        const growAllocRes = allocator.alloc(minGrowThreads, false);
        if (!growAllocRes.success) {
            allocator.free(hackServerAlloc.pop()!);
            return null;
        }
        growServerAlloc.push(growAllocRes.allocation);

        const minWeaken1Threads = Math.max(1, Math.floor(weaken1ThreadsRaw / 2));
        const weaken1AllocRes = allocator.alloc(minWeaken1Threads, true);
        if (!weaken1AllocRes.success) {
            allocator.free(hackServerAlloc.pop()!);
            allocator.free(growServerAlloc.pop()!);
            return null;
        }
        weaken1ServerAlloc.push(weaken1AllocRes.allocation);

        const minWeaken2Threads = Math.max(1, Math.floor(weaken2ThreadsRaw / 2));
        const weaken2AllocRes = allocator.alloc(minWeaken2Threads, true);
        if (!weaken2AllocRes.success) {
            allocator.free(hackServerAlloc.pop()!);
            allocator.free(growServerAlloc.pop()!);
            allocator.free(weaken1ServerAlloc.pop()!);
            return null;
        }
        weaken2ServerAlloc.push(weaken2AllocRes.allocation);

        batchCount = 1;
    }

    // Calculate batch duration and DPS
    const secondPerBatch = (weakenTime + batchCount * batchGap) / 1000;
    const dps = dollarPerHack * (1 / secondPerBatch) * batchCount;

    // Calculate threads per batch
    const tpb = Math.ceil(hackThreadsRaw) +
        Math.ceil(growThreadsRaw) +
        Math.ceil(weaken1ThreadsRaw) +
        Math.ceil(weaken2ThreadsRaw);

    return {
        dps,
        tpb,
        hackServerAlloc,
        growServerAlloc,
        weaken1ServerAlloc,
        weaken2ServerAlloc,
        concurrency: batchCount,
        secondPerBatch,
        batchGap,
        hackPerBatch: hackThreads,
        growPerBatch: Math.ceil(growThreadsRaw),
        weaken1ThreadsRaw,
        weaken2ThreadsRaw,
        weakenTime,
        hackTime,
        growTime
    };
}

/**
 * Find the best hack threads value for a target
 */
async function findBestHackThreads(
    ns: NS,
    target: string,
    availableAllocs: number[]
): Promise<BatchCalculation | null> {
    let bestHackThreads = 1;
    let bestDps = 0;
    let bestCalc: BatchCalculation | null = null;

    // Try different hack thread values to find the optimal
    const maxHackThreads = 100;  // Reasonable upper limit

    // Start with smaller thread counts to ensure we get at least some batches
    for (let hpb = 1; hpb <= Math.min(10, maxHackThreads); hpb++) {
        const calc = await calculateBatchStrategy(ns, target, hpb, availableAllocs);
        if (calc) {
            if (calc.dps > bestDps) {
                bestDps = calc.dps;
                bestHackThreads = hpb;
                bestCalc = calc;
            }

            // If we found any viable strategy, break early for low-value targets
            if (bestCalc && ns.getServerMaxMoney(target) < 1e6) {
                break;
            }
        }

        // Small wait to prevent excessive CPU usage
        if (hpb % 5 === 0) {
            await ns.sleep(1);
        }
    }

    // For higher-value targets, continue searching for better strategies
    if (ns.getServerMaxMoney(target) >= 1e6) {
        for (let hpb = 11; hpb <= maxHackThreads; hpb++) {
            const calc = await calculateBatchStrategy(ns, target, hpb, availableAllocs);
            if (calc && calc.dps > bestDps) {
                bestDps = calc.dps;
                bestHackThreads = hpb;
                bestCalc = calc;
            }

            // Small wait to prevent excessive CPU usage
            if (hpb % 5 === 0) {
                await ns.sleep(1);
            }
        }
    }

    return bestCalc;
}

/**
 * Execute batches for a target
 */
function executeTargetBatches(
    ns: NS,
    target: string,
    calc: BatchCalculation,
    availableServers: string[]
): void {
    if (!calc || availableServers.length === 0) return;

    const now = Date.now();
    const stepTime = CONFIG.TIMING.stepTime;

    // Calculate finish times for each operation
    const batchFinishTime = now + calc.weakenTime;

    // Schedule batches with staggered start times
    for (let i = 0; i < calc.concurrency; i++) {
        // Calculate batch offset
        const batchOffset = i * calc.batchGap;

        // Calculate finish times for this batch
        const hackFinish = batchFinishTime + batchOffset;
        const weaken1Finish = hackFinish + stepTime;
        const growFinish = weaken1Finish + stepTime;
        const weaken2Finish = growFinish + stepTime;

        // Calculate start times by working backward from finish times
        const hackStart = hackFinish - calc.hackTime;
        const weaken1Start = weaken1Finish - calc.weakenTime;
        const growStart = growFinish - calc.growTime;
        const weaken2Start = weaken2Finish - calc.weakenTime;

        // Generate batch ID
        const batchId = `batch-${target}-${i}`;

        // Execute hack
        if (calc.hackServerAlloc[i] && calc.hackServerAlloc[i].some((t: number) => t > 0)) {
            executeOperation(
                ns,
                CONFIG.SCRIPT_PATHS.hack,
                calc.hackServerAlloc[i],
                availableServers,
                target,
                calc.hackPerBatch,
                hackStart,
                hackFinish,
                `batch-hack-${batchId}`
            );
        }

        // Execute weaken1 (after hack)
        if (calc.weaken1ServerAlloc[i] && calc.weaken1ServerAlloc[i].some((t: number) => t > 0)) {
            executeOperation(
                ns,
                CONFIG.SCRIPT_PATHS.weaken1,
                calc.weaken1ServerAlloc[i],
                availableServers,
                target,
                Math.ceil(calc.weaken1ThreadsRaw),
                weaken1Start,
                weaken1Finish,
                `batch-weaken1-${batchId}`
            );
        }

        // Execute grow
        if (calc.growServerAlloc[i] && calc.growServerAlloc[i].some((t: number) => t > 0)) {
            executeOperation(
                ns,
                CONFIG.SCRIPT_PATHS.grow,
                calc.growServerAlloc[i],
                availableServers,
                target,
                calc.growPerBatch,
                growStart,
                growFinish,
                `batch-grow-${batchId}`
            );
        }

        // Execute weaken2 (after grow)
        if (calc.weaken2ServerAlloc[i] && calc.weaken2ServerAlloc[i].some((t: number) => t > 0)) {
            executeOperation(
                ns,
                CONFIG.SCRIPT_PATHS.weaken2,
                calc.weaken2ServerAlloc[i],
                availableServers,
                target,
                Math.ceil(calc.weaken2ThreadsRaw),
                weaken2Start,
                weaken2Finish,
                `batch-weaken2-${batchId}`
            );
        }
    }
}

/**
 * Execute a batch operation across servers
 */
function executeOperation(
    ns: NS,
    script: string,
    allocation: number[],
    serverList: string[],
    target: string,
    threads: number,
    startTime: number,
    endTime: number,
    description: string
): void {
    for (let i = 0; i < allocation.length; i++) {
        const serverThreads = allocation[i];
        if (serverThreads <= 0) continue;

        const server = serverList[i];

        // Skip if server doesn't exist
        if (!ns.serverExists(server)) continue;

        // Execute script
        execMulti(
            ns,
            server,
            serverThreads,
            script,
            target,
            startTime,
            endTime - startTime,
            description,
            false,  // stock manipulation
            true    // silent
        );
    }
}

/**
 * Use share() command to distribute remaining RAM for increasing faction rep
 */
async function shareRemainingRam(ns: NS, availableServers: string[]): Promise<void> {
    if (!CONFIG.FEATURES.enableShare) return;

    let totalThreads = 0;
    const shareScript = CONFIG.SCRIPT_PATHS.share;
    const scriptRam = ns.getScriptRam(shareScript);

    for (const server of availableServers) {
        // Skip home if reserved RAM would be violated
        if (server === 'home') {
            const freeRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - CONFIG.RAM.homeRamReserve;
            if (freeRam <= 0) continue;

            // Only use a portion of home's RAM for sharing
            const ramForShare = freeRam * CONFIG.RAM.maxShareRamPercent;
            const shareThreads = Math.floor(ramForShare / scriptRam);

            if (shareThreads > 0) {
                execMulti(ns, server, shareThreads, shareScript);
                totalThreads += shareThreads;
            }
            continue;
        }

        // For other servers, use all available RAM
        const freeRam = ns.getServerMaxRam(server) - ns.getServerUsedRam(server);
        if (freeRam <= scriptRam) continue;

        const shareThreads = Math.floor(freeRam / scriptRam);
        if (shareThreads > 0) {
            execMulti(ns, server, shareThreads, shareScript);
            totalThreads += shareThreads;
        }
    }

    if (totalThreads > 0) {
        ns.print(`SHARE: Running ${totalThreads} share threads across all servers`);
    }
}

/**
 * Main function for distributed hacking
 */
export async function main(ns: NS): Promise<void> {
    // Disable logs and enable only print statements
    ns.disableLog('ALL');
    ns.enableLog('print');

    try {
        // Initialize formula helper
        formulaHelper = new FormulaHelper(ns);

        // Start with a nuke to maximize available resources
        await nukeAll(ns);
        lastNukeTime = Date.now();

        // Print startup message
        ns.print('Advanced Batch Hacking System started');

        // Main loop
        let tick = 0;
        let lastTargetCheck = 0;
        const TARGET_CHECK_INTERVAL = 5;  // Seconds

        // Store active batches
        const activeBatches: Map<string, BatchCalculation> = new Map();

        while (true) {
            try {
                const now = Date.now();
                const currentTime = Math.floor(now / 1000);

                // Periodic maintenance tasks

                // Run scan-nuke to get root access on new servers
                if (currentTime - lastNukeTime >= CONFIG.TARGETING.nukeInterval) {
                    await nukeAll(ns);
                    lastNukeTime = currentTime;
                    ns.print('INFO: Ran scan-nuke to gain root access to new servers');
                }

                // Purchase port openers
                if (currentTime - lastPortOpenerTime >= CONFIG.TARGETING.portOpenerInterval) {
                    await buyPortOpeners(ns);
                    lastPortOpenerTime = currentTime;
                    ns.print('INFO: Checked for port opener purchases');
                }

                // Purchase servers
                if (CONFIG.FEATURES.enableAutoServerPurchase &&
                    currentTime - lastServerPurchaseTime >= CONFIG.INTERVALS.serverPurchase) {
                    await purchaseServers(ns);
                    lastServerPurchaseTime = currentTime;
                    ns.print('INFO: Checked for server purchases');
                }

                // Upgrade home server
                if (currentTime - lastUpgradeHomeServerTime >= CONFIG.INTERVALS.upgradeHomeServer) {
                    await upgradeHomeServer(ns);
                    lastUpgradeHomeServerTime = currentTime;
                    ns.print('INFO: Checked for home server upgrades');
                }

                // Use remaining RAM for share
                if (CONFIG.FEATURES.enableShare &&
                    currentTime - lastShareTime >= CONFIG.INTERVALS.shareInterval) {
                    // Get available servers
                    const { servers: availableServers } = getAvailableServers(
                        ns,
                        CONFIG.RAM.minServerRam,
                        CONFIG.RAM.useHomeRam,
                        CONFIG.RAM.homeRamReserve
                    );

                    await shareRemainingRam(ns, availableServers);
                    lastShareTime = currentTime;
                }

                // Periodically check for new servers to hack
                if (currentTime - lastTargetCheck >= TARGET_CHECK_INTERVAL) {
                    lastTargetCheck = currentTime;

                    // Get available servers for running scripts
                    const { servers: availableServers, rams: availableRams, allocs: availableAllocs } =
                        getAvailableServers(
                            ns,
                            CONFIG.RAM.minServerRam,
                            CONFIG.RAM.useHomeRam,
                            CONFIG.RAM.homeRamReserve
                        );

                    // Print detailed server usage info
                    ns.print(`Available servers: ${availableServers.length}`);

                    // Print RAM status
                    const totalRam = availableServers.reduce((sum, server) =>
                        sum + ns.getServerMaxRam(server), 0);
                    const usedRam = availableServers.reduce((sum, server) =>
                        sum + ns.getServerUsedRam(server), 0);
                    const freeRam = totalRam - usedRam;
                    const homeReserved = CONFIG.RAM.homeRamReserve;
                    const homeMaxRam = ns.getServerMaxRam('home');
                    const homeUsedRam = ns.getServerUsedRam('home');
                    const homeFreeRam = homeMaxRam - homeUsedRam;
                    const ramViolated = homeFreeRam < homeReserved;

                    // Create RAM status panel
                    ns.print(formatRamStatusPanel(
                        totalRam,
                        freeRam,
                        homeFreeRam,
                        homeReserved,
                        ramViolated
                    ));

                    // If home RAM is violated, kill some batches
                    if (ramViolated && activeBatches.size > 0) {
                        // Sort targets by DPS (lowest first)
                        const targets = Array.from(activeBatches.entries())
                            .sort((a, b) => a[1].dps - b[1].dps)
                            .map(entry => entry[0]);

                        // Kill the lowest-income batch
                        if (targets.length > 0) {
                            const targetToKill = targets[0];
                            const batchInfo = activeBatches.get(targetToKill);

                            // Kill all scripts for this target
                            for (const server of availableServers) {
                                ns.scriptKill(CONFIG.SCRIPT_PATHS.hack, server);
                                ns.scriptKill(CONFIG.SCRIPT_PATHS.grow, server);
                                ns.scriptKill(CONFIG.SCRIPT_PATHS.weaken1, server);
                                ns.scriptKill(CONFIG.SCRIPT_PATHS.weaken2, server);
                            }

                            // Remove from active batches
                            activeBatches.delete(targetToKill);

                            ns.print(`Killed batch for ${targetToKill} to free RAM (${batchInfo ? formatMoney(batchInfo.dps) : '$0'}/sec)`);
                            continue; // Skip to next tick to let RAM update
                        }
                    }

                    // Get potential target servers
                    const targetServers = getTargetServers(ns);
                    ns.print(`Potential targets: ${targetServers.slice(0, 10).join(', ')}${targetServers.length > 10 ? '...' : ''}`);

                    // Prepare servers if needed
                    const preparedTargets = targetServers.filter(target =>
                        isServerPrepared(ns, target, CONFIG.TARGETING.moneyThreshold, CONFIG.TARGETING.securityThreshold)
                    );
                    const unpreparedTargets = targetServers.filter(target =>
                        !isServerPrepared(ns, target, CONFIG.TARGETING.moneyThreshold, CONFIG.TARGETING.securityThreshold)
                    ).slice(0, CONFIG.TARGETING.maxTargets);

                    if (unpreparedTargets.length > 0) {
                        await autoGrowServers(ns, unpreparedTargets, availableServers);
                    }

                    // Schedule batches for targets not already being hacked
                    const availableTargets = preparedTargets
                        .filter(target => !activeBatches.has(target))
                        .slice(0, CONFIG.TARGETING.maxTargets);

                    // Prioritize using all available servers
                    if (availableTargets.length === 0 && preparedTargets.length > 0) {
                        // If no new targets but we have prepared servers, try to schedule more batches on existing targets
                        // This helps utilize all available RAM
                        ns.print('No new targets available, attempting to increase utilization of existing targets');

                        // Pick a random target that's already prepared to add more batches
                        const randomTarget = preparedTargets[Math.floor(Math.random() * preparedTargets.length)];
                        if (!activeBatches.has(randomTarget)) {
                            availableTargets.push(randomTarget);
                        }
                    }

                    // Process each available target
                    for (const target of availableTargets) {
                        // Only proceed if we have RAM available
                        if (ramViolated) {
                            ns.print('Home RAM reservation violated. Not scheduling new batches.');
                            break;
                        }

                        // Find the best hack threads value for this target
                        const batchCalc = await findBestHackThreads(
                            ns,
                            target,
                            [...availableAllocs] // Copy to avoid modifying original
                        );

                        if (batchCalc) {
                            // Store the active batch
                            activeBatches.set(target, batchCalc);

                            // Execute the batches
                            executeTargetBatches(ns, target, batchCalc, availableServers);

                            ns.print(`Started batching ${target} with ${batchCalc.concurrency} batches, ${formatMoney(batchCalc.dps)}/sec`);
                        } else {
                            ns.print(`Could not find a viable batching strategy for ${target}`);
                        }
                    }

                    // Every few cycles, try to add batches to maximize server utilization
                    if (tick % 5 === 0) {
                        let totalFreeRam = 0;
                        for (const server of availableServers) {
                            totalFreeRam += ns.getServerMaxRam(server) - ns.getServerUsedRam(server);
                        }

                        // If we still have significant RAM available, try to add more batches
                        if (totalFreeRam > 1000 && !ramViolated) {
                            ns.print(`Still have ${totalFreeRam.toFixed(2)}GB free RAM. Attempting to schedule additional batches.`);

                            // Find a target to add more batches to
                            for (const target of preparedTargets) {
                                if (!ramViolated) {
                                    const smallCalc = await calculateBatchStrategy(ns, target, 1, availableAllocs);
                                    if (smallCalc) {
                                        // Execute additional small batches
                                        executeTargetBatches(ns, target, smallCalc, availableServers);
                                        ns.print(`Added supplementary batch for ${target}`);
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    // Print active batch status
                    if (activeBatches.size > 0) {
                        // Convert to Map for formatting
                        const batchDpsMap = new Map<string, number>();
                        let totalBatchThreads = 0;
                        let totalDps = 0;

                        for (const [target, batchInfo] of activeBatches.entries()) {
                            batchDpsMap.set(target, batchInfo.dps);
                            totalDps += batchInfo.dps;
                            totalBatchThreads += batchInfo.tpb * batchInfo.concurrency;
                        }

                        // Print formatted panel
                        ns.print(formatBatchInfoPanel(batchDpsMap, totalBatchThreads, totalDps));
                    }
                }

                // Sleep before next tick
                await ns.sleep(200); // Faster tick rate for more responsive batching
                tick++;

            } catch (innerError) {
                // Log errors but keep running
                ns.print(`ERROR in main loop: ${innerError}`);
                await ns.sleep(5000); // Longer sleep on error
            }
        }
    } catch (error) {
        // Log fatal errors
        ns.tprint(`FATAL ERROR in batch_hack: ${error}`);
    }
}