import { NS } from '@ns';
import {
    scanAndNuke, formatTime, formatRam, formatMoney, formatPercent, findAllServers,
    getHackableServers, calculateServerValue, ensureScriptExists, calculateWeakenThreads,
    calculateGrowThreads, distributeThreads, reserveRamOnHost
} from './utils';
import { AutoGrowManager, RamManager, IRamManager, AutoGrowConfig } from './lib/auto_grow';

// Script paths for various operations
const SCRIPT_PATH = {
    hack: 'remote_batch/hack.js',
    weaken: 'remote_batch/weaken.js',
    grow: 'remote_batch/grow.js',
    share: 'remote/share.js',
    solveContracts: 'remote/solve-contracts.js',
};

// RAM usage for different scripts
const SCRIPT_RAM = {
    slaveScript: 1.75,    // RAM usage in GB for weaken/hack/grow scripts
    shareScript: 4.0,     // RAM usage in GB for share script
    solveContractsScript: 22.0 // RAM usage in GB for solve-contracts script
};

// Configuration settings
const CONFIG = {
    maxParallelAttacks: 1000,
    timing: {
        cycleSleep: 2000,
        maxThreadCalculationTime: 240000, // 4 minutes timeout
    },
    ram: {
        useHomeRam: true,
        reservedHomeRamPercentage: 0.15,
        maxReserveHomeRAM: 128,
        minReserveHomeRam: 32,
    },
    security: {
        growThreadSecurityIncrease: 0.004,
        hackThreadSecurityIncrease: 0.002,
        weakenSecurityDecrease: 0.05,
    },
    features: {
        solveContracts: true,
    },
    batch: {
        enabled: true,
        batchSpacing: 100,          // ms between each batch
        operationDelay: 50,         // ms between each operation in a batch
        maxBatchesPerTarget: 5,     // max batches per target
        silentMisfires: true,       // avoid printing toast messages for misfires
        debugLogs: false,           // detailed debug logs (can be very verbose)
        prepSecurity: 3,            // security threshold for preparation
        prepMoneyThreshold: 0.9,    // money threshold for preparation
        targetHackPercentage: 0.25, // percentage of money to hack per batch
        prioritizeHighValue: true,  // prioritize high-value servers
        maxTargetsPerCycle: 8,      // maximum targets to process per cycle
    }
};

// Core interfaces for batch hacking
interface BatchTimings {
    batchStart: Date;
    hackStart: Date;
    hackEnd: Date;
    weaken1Start: Date;
    weaken1End: Date;
    growStart: Date;
    growEnd: Date;
    weaken2Start: Date;
    weaken2End: Date;
    lastStart: Date; // Last operation to start
    firstEnd: Date;  // First operation to end
}

interface BatchOperation {
    description: string;
    script: string;
    startTime: Date;
    endTime: Date;
    threads: number;
    target: string;
    manipulateStock?: boolean;
}

interface BatchPlan {
    batchNumber: number;
    operations: BatchOperation[];
    target: string;
    startTime: Date;
    endTime: Date;
}

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

// Track server values and batch counts
const profitsMap = new Map<string, number>();

/**
 * BatchScheduler - Handles scheduling and execution of batched operations
 */
class BatchScheduler {
    private ns: NS;
    private activeBatchCount: Map<string, number> = new Map();
    private batchNumber: number = 0;

    constructor(ns: NS) {
        this.ns = ns;
    }

    /**
     * Calculate timing schedule for a batch
     */
    calculateBatchTiming(startTime: Date, target: string): BatchTimings {
        // Get operation times
        const hackTime = this.ns.getHackTime(target);
        const growTime = this.ns.getGrowTime(target);
        const weakenTime = this.ns.getWeakenTime(target);
        const delayBetweenOperations = CONFIG.batch.operationDelay;

        // We want operations to complete in this order: 
        // Hack -> Weaken1 -> Grow -> Weaken2
        // with a delay between each completion

        // Calculate completion times (working backward)
        const weaken2End = new Date(startTime.getTime() + weakenTime);
        const growEnd = new Date(weaken2End.getTime() - delayBetweenOperations);
        const weaken1End = new Date(growEnd.getTime() - delayBetweenOperations);
        const hackEnd = new Date(weaken1End.getTime() - delayBetweenOperations);

        // Calculate start times based on completion times
        const hackStart = new Date(hackEnd.getTime() - hackTime);
        const weaken1Start = new Date(weaken1End.getTime() - weakenTime);
        const growStart = new Date(growEnd.getTime() - growTime);
        const weaken2Start = new Date(weaken2End.getTime() - weakenTime);

        // Find first operation to end and last to start for overall timing
        const firstEnd = hackEnd;
        const lastStart = new Date(
            Math.max(
                hackStart.getTime(),
                weaken1Start.getTime(),
                growStart.getTime(),
                weaken2Start.getTime()
            )
        );

        return {
            batchStart: startTime,
            hackStart,
            hackEnd,
            weaken1Start,
            weaken1End,
            growStart,
            growEnd,
            weaken2Start,
            weaken2End,
            firstEnd,
            lastStart
        };
    }

    /**
     * Schedule a batch of operations for a target server
     */
    scheduleHWGWBatch(target: string, ramManager: IRamManager, hackMoneyRatio: number): boolean {
        const currentBatches = this.activeBatchCount.get(target) || 0;

        // Don't exceed max concurrent batches per target
        if (currentBatches >= CONFIG.batch.maxBatchesPerTarget) {
            return false;
        }

        // Calculate batch timing
        const startTime = new Date(Date.now() + CONFIG.batch.batchSpacing * currentBatches);
        const timings = this.calculateBatchTiming(startTime, target);

        // Calculate thread strategy
        const strategy = this.calculateBatchStrategy(target, hackMoneyRatio);

        // Check if we have enough RAM
        const totalThreads = strategy.hackThreads + strategy.weakenForHackThreads +
            strategy.growThreads + strategy.weakenThreads;

        const totalRamNeeded = totalThreads * SCRIPT_RAM.slaveScript;

        if (ramManager.getTotalFreeRam() < totalRamNeeded) {
            return false;
        }

        // Create batch operations
        const operations: BatchOperation[] = [
            {
                description: 'hack',
                script: SCRIPT_PATH.hack,
                startTime: timings.hackStart,
                endTime: timings.hackEnd,
                threads: strategy.hackThreads,
                target
            },
            {
                description: 'weaken1',
                script: SCRIPT_PATH.weaken,
                startTime: timings.weaken1Start,
                endTime: timings.weaken1End,
                threads: strategy.weakenForHackThreads,
                target
            },
            {
                description: 'grow',
                script: SCRIPT_PATH.grow,
                startTime: timings.growStart,
                endTime: timings.growEnd,
                threads: strategy.growThreads,
                target
            },
            {
                description: 'weaken2',
                script: SCRIPT_PATH.weaken,
                startTime: timings.weaken2Start,
                endTime: timings.weaken2End,
                threads: strategy.weakenThreads,
                target
            }
        ];

        // Create and execute batch plan
        const batchPlan: BatchPlan = {
            batchNumber: this.batchNumber++,
            operations,
            target,
            startTime,
            endTime: timings.weaken2End
        };

        if (this.executeBatchPlan(batchPlan, ramManager)) {
            // Update active batch count
            this.activeBatchCount.set(target, currentBatches + 1);
            return true;
        }

        return false;
    }

    /**
     * Verify active batches to maintain accurate counts
     */
    verifyActiveBatches(): void {
        this.activeBatchCount.clear();
    }

    /**
     * Calculate the strategy for a batch attack
     */
    calculateBatchStrategy(target: string, hackMoneyRatio: number): AttackStrategy {
        const serverValue = calculateServerValue(this.ns, target);

        // Get server info
        const maxMoney = this.ns.getServerMaxMoney(target);
        const growthRate = this.ns.getServerGrowth(target);
        const minSecurity = this.ns.getServerMinSecurityLevel(target);

        // Calculate hack threads to steal the desired percentage of money
        const hackPercent = this.ns.hackAnalyze(target);
        let hackThreads = Math.floor(hackMoneyRatio / hackPercent);

        // Ensure we don't use too many threads (at most 25% of money)
        const maxStealPercentage = Math.min(0.25, hackMoneyRatio);
        if (hackThreads * hackPercent > maxStealPercentage) {
            hackThreads = Math.floor(maxStealPercentage / hackPercent);
        }

        // Calculate security increase from hack
        const hackSecurityIncrease = hackThreads * CONFIG.security.hackThreadSecurityIncrease;

        // Calculate threads to weaken after hack
        const weakenForHackThreads = Math.ceil(hackSecurityIncrease / CONFIG.security.weakenSecurityDecrease);

        // Calculate grow threads needed to recover from the hack
        const growRatio = 1 / (1 - maxStealPercentage);
        const growThreads = this.ns.fileExists('Formulas.exe')
            ? Math.ceil(this.ns.formulas.hacking.growThreads(
                this.ns.getServer(target),
                this.ns.getPlayer(),
                maxMoney,
                1 // cores
            ))
            : Math.ceil(this.ns.growthAnalyze(target, growRatio));

        // Calculate security increase from grow
        const growSecurityIncrease = growThreads * CONFIG.security.growThreadSecurityIncrease;

        // Calculate threads to weaken after grow
        const weakenThreads = Math.ceil(growSecurityIncrease / CONFIG.security.weakenSecurityDecrease);

        // Calculate total threads and RAM needed
        const totalThreads = hackThreads + weakenForHackThreads + growThreads + weakenThreads;
        const totalRAM = totalThreads * SCRIPT_RAM.slaveScript;

        return {
            hackThreads,
            growThreads,
            weakenThreads,
            weakenForHackThreads,
            totalThreads,
            totalRAM,
            serverValue,
            maxStealPercentage
        };
    }

    /**
     * Execute a batch plan by distributing operations across servers
     */
    executeBatchPlan(batchPlan: BatchPlan, ramManager: IRamManager): boolean {
        // Check if we have enough RAM for all operations
        let totalRamNeeded = 0;
        for (const op of batchPlan.operations) {
            totalRamNeeded += op.threads * SCRIPT_RAM.slaveScript;
        }

        if (ramManager.getTotalFreeRam() < totalRamNeeded) {
            return false;
        }

        // Execute each operation in the batch
        for (const operation of batchPlan.operations) {
            const success = this.executeOperation(operation, ramManager);
            if (!success) {
                return false;
            }
        }

        return true;
    }

    /**
     * Execute a single batch operation
     */
    executeOperation(operation: BatchOperation, ramManager: IRamManager): boolean {
        if (operation.threads <= 0) {
            return true; // No threads to run
        }

        // Calculate sleep time until operation should start
        const sleepTime = operation.startTime.getTime() - Date.now();

        // Get servers sorted by free RAM
        const servers = ramManager.getServersByFreeRam().map(host => ({
            host,
            freeRam: ramManager.getFreeRam(host)
        }));

        // Prepare args for the script
        const args = [
            operation.target,
            operation.startTime.getTime(),
            0, // Duration (0 = automatic)
            operation.description,
            false, // Stock manipulation
            CONFIG.batch.silentMisfires
        ];

        // Distribute threads across servers
        const success = distributeThreads(
            this.ns,
            operation.script,
            operation.threads,
            servers,
            ...args
        );

        // If distribution was successful, update the RAM usage in ramManager
        if (success) {
            // The distributeThreads function already used the RAM from the servers array
            // We need to update the ramManager with the new values
            for (const server of servers) {
                const originalFreeRam = ramManager.getFreeRam(server.host);
                const ramUsed = originalFreeRam - server.freeRam;

                if (ramUsed > 0) {
                    ramManager.reserveRam(ramUsed, server.host);
                }
            }
        }

        return success;
    }

    /**
     * Get the active batch count for a target
     */
    getActiveBatchCount(target: string): number {
        return this.activeBatchCount.get(target) || 0;
    }

    /**
     * Get the size of the active batch count map
     */
    getActiveBatchCountMapSize(): number {
        return this.activeBatchCount.size;
    }

    /**
     * Reset active batch counts
     */
    resetActiveBatchCounts(): void {
        this.activeBatchCount.clear();
    }
}

/**
 * Main script entry point
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.enableLog('print');

    try {
        // Wait for other scripts to initialize
        await ns.sleep(200);

        // Initialize batch scheduler
        const batchScheduler = new BatchScheduler(ns);

        // Create config for AutoGrowManager
        const autoGrowConfig: Partial<AutoGrowConfig> = {
            security: {
                threshold: CONFIG.batch.prepSecurity,
                weakenAmount: CONFIG.security.weakenSecurityDecrease
            },
            money: {
                threshold: CONFIG.batch.prepMoneyThreshold
            },
            debug: CONFIG.batch.debugLogs
        };

        // Create the AutoGrowManager with proper config
        const prepManager = new AutoGrowManager(ns, autoGrowConfig);

        // Reset active batch counts at startup
        batchScheduler.resetActiveBatchCounts();

        ns.print(`Distributed Hack started - targeting up to ${CONFIG.maxParallelAttacks} servers`);

        let tick = 0;
        while (true) {
            try {
                // Reset server preparation states
                prepManager.resetServerStates();

                // Create a RAM manager for this tick
                const ramManager = createConfiguredRamManager(ns);

                // Process one tick of the preparation manager
                await prepManager.tick(ramManager);

                // Get hackable targets
                const targets = getHackableServers(ns);

                // Execute batch attacks with current RAM and targets
                const batchesLaunched = await manageBatchAttacks(
                    ns,
                    batchScheduler,
                    prepManager,
                    ramManager,
                    targets,
                    CONFIG.batch.targetHackPercentage
                );

                // Periodically verify batch counters (every 30 ticks)
                if (tick % 30 === 0) {
                    batchScheduler.verifyActiveBatches();

                    // Print only every 30 ticks to avoid spam
                    ns.print(`Status: ${batchesLaunched} batches launched, ${formatRam(ramManager.getTotalFreeRam())} RAM free, ${formatPercent(ramManager.getUtilization())} utilized`);
                }

                // Wait before next cycle
                await ns.sleep(CONFIG.timing.cycleSleep);
                tick++;
            } catch (innerError) {
                // Catch and log any errors in the main loop, but keep running
                ns.print(`ERROR in main loop: ${innerError}`);
                await ns.sleep(5000); // Sleep a bit longer on error
            }
        }
    } catch (error) {
        // Catch and log any errors that would cause the script to exit
        ns.tprint(`FATAL ERROR: ${error}`);
    }
}

/**
 * Create and configure a RAM manager with the appropriate settings
 */
function createConfiguredRamManager(ns: NS): RamManager {
    const ramManager = new RamManager(ns, false); // Don't update RAM on creation

    // Clear existing data
    ramManager['servers'].clear();

    const homeReservedRam = Math.max(
        Math.min(ns.getServerMaxRam('home') * CONFIG.ram.reservedHomeRamPercentage, CONFIG.ram.maxReserveHomeRAM),
        CONFIG.ram.minReserveHomeRam
    );

    // Add purchased servers
    for (const server of ns.getPurchasedServers()) {
        const maxRam = ns.getServerMaxRam(server);
        const usedRam = ns.getServerUsedRam(server);
        const freeRam = maxRam - usedRam;

        if (freeRam > 0) {
            ramManager['servers'].set(server, {
                freeRam,
                maxRam
            });
        }
    }

    // Add home if enabled
    if (CONFIG.ram.useHomeRam) {
        const maxRam = ns.getServerMaxRam('home');
        const usedRam = ns.getServerUsedRam('home');
        const freeRam = Math.max(0, maxRam - usedRam - homeReservedRam);

        if (freeRam > 0) {
            ramManager['servers'].set('home', {
                freeRam,
                maxRam
            });
        }
    }

    // Add all other servers with at least 2GB RAM
    const hackableServers = findAllServers(ns).filter(s =>
        s !== 'home' && !ns.getPurchasedServers().includes(s) && ns.hasRootAccess(s) &&
        ns.getServerMaxRam(s) >= 2
    );

    for (const server of hackableServers) {
        const maxRam = ns.getServerMaxRam(server);
        const usedRam = ns.getServerUsedRam(server);
        const freeRam = maxRam - usedRam;

        if (freeRam > 0) {
            ramManager['servers'].set(server, {
                freeRam,
                maxRam
            });
        }
    }

    return ramManager;
}

/**
 * Main batch hacking logic with server preparation
 */
async function manageBatchAttacks(
    ns: NS,
    batchScheduler: BatchScheduler,
    prepManager: AutoGrowManager,
    ramManager: IRamManager,
    targets: string[],
    hackMoneyRatio: number
): Promise<number> {
    // Add timeout protection for thread calculations
    const startTime = Date.now();
    let batchesLaunched = 0;

    // If no RAM available, exit early
    if (ramManager.getTotalFreeRam() < SCRIPT_RAM.slaveScript * 10) {
        return 0;
    }

    // Limit targets if prioritizing high-value servers
    let targetsToProcess = [...targets];
    if (CONFIG.batch.prioritizeHighValue && CONFIG.batch.maxTargetsPerCycle > 0) {
        // Apply a more aggressive filter for high-value targets
        targetsToProcess = targetsToProcess
            .sort((a, b) => {
                const aScore = calculateServerValue(ns, a);
                const bScore = calculateServerValue(ns, b);
                return bScore - aScore;
            })
            .slice(0, CONFIG.batch.maxTargetsPerCycle);
    }

    // Continue scheduling batches until we run out of RAM or targets
    let iterationCount = 0;
    const maxIterations = 5; // Safety limit to prevent infinite loops

    while (ramManager.getTotalFreeRam() > SCRIPT_RAM.slaveScript * 10 &&
        batchesLaunched < CONFIG.maxParallelAttacks &&
        iterationCount < maxIterations) {

        iterationCount++;

        // Check timeout
        if (Date.now() - startTime > CONFIG.timing.maxThreadCalculationTime) {
            ns.print(`Batch calculation timeout reached (${CONFIG.timing.maxThreadCalculationTime}ms)`);
            break;
        }

        // If batch mode is disabled, skip
        if (!CONFIG.batch.enabled) {
            break;
        }

        // Process each target
        for (const target of targetsToProcess) {
            // Skip if we've maxed out parallel attacks
            if (batchesLaunched >= CONFIG.maxParallelAttacks) {
                break;
            }

            // If we're running out of RAM, break
            if (ramManager.getTotalFreeRam() < SCRIPT_RAM.slaveScript * 10) {
                break;
            }

            // First check if the server is prepared
            const isReady = prepManager.isServerPrepared(target);

            if (!isReady) {
                // Process the server for one tick
                if (iterationCount === 1) { // Only try to prepare on first iteration
                    await prepManager.processTick(target, ramManager);
                }
                continue; // Skip to next target
            }

            // Check if we have active batches for this target already
            const activeBatchCount = batchScheduler.getActiveBatchCount(target);
            const maxBatchesForTarget = CONFIG.batch.maxBatchesPerTarget;

            // If we've already maxed out batches for this target, skip
            if (activeBatchCount >= maxBatchesForTarget) {
                continue;
            }

            // Try to schedule a batch
            if (batchScheduler.scheduleHWGWBatch(target, ramManager, hackMoneyRatio)) {
                batchesLaunched++;

                // For more uniform distribution, only schedule one batch per target per iteration
                continue;
            }
        }

        // If we didn't schedule any batches this iteration, break 
        if (batchesLaunched === 0) {
            break;
        }
    }

    return batchesLaunched;
}

