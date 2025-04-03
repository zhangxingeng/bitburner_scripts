import { NS } from '@ns';
import { scanAndNuke, copyScripts, calculateServerScore, formatTime, formatRam, formatMoney, prettyDisplay } from './utils';
// Updated script paths to point to batch scripts
const SCRIPT_PATH = {
    hack: 'remote_batch/hack.js',
    weaken: 'remote_batch/weaken.js',
    grow: 'remote_batch/grow.js',
    share: 'remote/share.js',
    solveContracts: 'remote/solve-contracts.js',
};

const SCRIPT_RAM = {
    slaveScript: 1.75,    // RAM usage in GB for weaken/hack/grow scripts
    shareScript: 4.0,     // RAM usage in GB for share script
    solveContractsScript: 22.0, // RAM usage in GB for solve-contracts script
};

// Restructured CONFIG with additional batch-specific settings
const CONFIG = {
    maxParallelAttacks: 60,
    thresholds: {
        ramUsageLow: 0.8,
        ramUsageHigh: 0.9,
        securityThresholdOffset: 2, // Tightened security threshold for batching
        moneyThresholdPercentage: 0.9, // Higher money threshold for batching
        minimumServerRam: 1.6,
        hackMoneyRatioMin: 0.01,
        hackMoneyRatioMax: 0.5 // Reduced from 0.99 to avoid emptying servers
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
        ignoreServersLowerThanPurchased: true
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
        useTimedThreadAdjustment: true,
    },
    // New batch-specific configuration
    batch: {
        enabled: true,
        batchSpacing: 200, // Milliseconds between batches
        operationDelay: 50, // Milliseconds between operations in a batch
        maxBatchesPerTarget: 20, // Maximum number of batches to schedule at once
        silentMisfires: true, // Suppress misfire warnings
        debugLogs: false, // Enable detailed batch logging
        prepSecurity: 1, // Extra security buffer during preparation
        prepMoneyThreshold: 0.95, // Money threshold for preparation completion
        targetHackPercentage: 0.1, // Target amount to hack per batch (10%)
    }
};

// Add stock market manipulation configuration
const STOCK_MANIPULATION_CONFIG = {
    enabled: true,
    manipulationThreshold: 0.02,
    maxManipulationServers: 5,
    manipulationCooldown: 60000,
    hackEffect: -0.01,
    growEffect: 0.01,
    minServerMoney: 1e6,
    maxSecurityOffset: 5
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

interface ServerRamInfo {
    host: string;
    freeRam: number;
    maxRam: number;
    hasCapacityFor: (threads: number) => boolean;
}

// RamUsage Class Implementation
class RamUsage {
    private _serverRams: ServerRamInfo[] = [];

    get overallFreeRam(): number {
        return this._serverRams.reduce((sum, server) => sum + server.freeRam, 0);
    }

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
            const totalToReserve = Math.min(amount, this.overallFreeRam);
            let remaining = totalToReserve;

            // Sort servers by free RAM (ascending) to use smaller chunks first
            this._serverRams.sort((a, b) => a.freeRam - b.freeRam);

            for (const server of this._serverRams) {
                if (remaining <= 0) break;

                const amountToReserve = Math.min(remaining, server.freeRam);
                server.freeRam -= amountToReserve;
                remaining -= amountToReserve;
            }
        }
    }

    get serverRams(): ServerRamInfo[] {
        return [...this._serverRams]; // Return a copy to prevent direct modification
    }
}

// Global variables
const profitsMap = new Map<string, number>();
const activeBatches = new Map<string, number>(); // Track active batches per target
const lastManipulationTime = 0;
const manipulatedStocks = new Map<string, number>();
// Map to track server preparation status
const serverPreparationState = new Map<string, 'none' | 'weakening' | 'growing' | 'ready'>();

/**
 * ServerPreparationManager - Handles preparing servers for batch hacking
 */
class ServerPreparationManager {
    private ns: NS;

    constructor(ns: NS) {
        this.ns = ns;
    }

    /**
     * Check if a server is prepared for batch hacking
     * @param {string} target - Target server
     * @returns {boolean} Whether the server is ready for batching
     */
    isServerPrepared(target: string): boolean {
        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);
        const currentMoney = this.ns.getServerMoneyAvailable(target);
        const maxMoney = this.ns.getServerMaxMoney(target);

        // Check if security is at minimum (with small buffer)
        const securityReady = securityLevel <= minSecurityLevel + CONFIG.batch.prepSecurity;

        // Check if money is at maximum (with configured threshold)
        const moneyReady = currentMoney >= maxMoney * CONFIG.batch.prepMoneyThreshold;

        return securityReady && moneyReady;
    }

    /**
     * Get the current preparation state of a server
     * @param {string} target - Target server
     * @returns {string} Current preparation state
     */
    getPreparationState(target: string): 'none' | 'weakening' | 'growing' | 'ready' {
        // Get current state or default to 'none'
        const currentState = serverPreparationState.get(target) || 'none';

        // If already marked as ready, quick return
        if (currentState === 'ready' && this.isServerPrepared(target)) {
            return 'ready';
        }

        // Check actual server state
        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);
        const currentMoney = this.ns.getServerMoneyAvailable(target);
        const maxMoney = this.ns.getServerMaxMoney(target);

        // If both conditions met, server is ready
        if (securityLevel <= minSecurityLevel + CONFIG.batch.prepSecurity &&
            currentMoney >= maxMoney * CONFIG.batch.prepMoneyThreshold) {
            serverPreparationState.set(target, 'ready');
            return 'ready';
        }

        // Check security first - weaken has priority over grow
        if (securityLevel > minSecurityLevel + CONFIG.batch.prepSecurity) {
            serverPreparationState.set(target, 'weakening');
            return 'weakening';
        }

        // If security is good but money is low, we're growing
        if (currentMoney < maxMoney * CONFIG.batch.prepMoneyThreshold) {
            serverPreparationState.set(target, 'growing');
            return 'growing';
        }

        // Default to existing state
        return currentState;
    }

    /**
     * Prepare a server for batch hacking
     * @param {string} target - Target server
     * @param {RamUsage} freeRams - Available RAM
     * @returns {Promise<boolean>} Whether preparation actions were taken
     */
    async prepareServer(target: string, freeRams: RamUsage): Promise<boolean> {
        const state = this.getPreparationState(target);

        if (state === 'ready') {
            return false; // No preparation needed
        }

        if (state === 'weakening') {
            return this.weakenServer(target, freeRams);
        }

        if (state === 'growing') {
            return this.growServer(target, freeRams);
        }

        // If state is 'none', start with weakening
        return this.weakenServer(target, freeRams);
    }

    /**
     * Weaken a server to minimum security
     * @param {string} target - Target server
     * @param {RamUsage} freeRams - Available RAM
     * @returns {boolean} Whether weaken was started
     */
    weakenServer(target: string, freeRams: RamUsage): boolean {
        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);

        // If security is already at minimum, move to growing
        if (securityLevel <= minSecurityLevel + CONFIG.batch.prepSecurity) {
            serverPreparationState.set(target, 'growing');
            return this.growServer(target, freeRams);
        }

        // Calculate security difference and required threads
        const securityDiff = securityLevel - minSecurityLevel;
        const requiredThreads = Math.ceil(securityDiff / CONFIG.security.weakenSecurityDecrease);

        // Check if we have enough RAM
        if (freeRams.overallFreeRam < requiredThreads * SCRIPT_RAM.slaveScript) {
            // Try with half the threads if full amount not available
            const halfThreads = Math.ceil(requiredThreads / 2);
            if (freeRams.overallFreeRam < halfThreads * SCRIPT_RAM.slaveScript) {
                // Try with minimum viable threads (at least make some progress)
                const minThreads = Math.floor(freeRams.overallFreeRam / SCRIPT_RAM.slaveScript);
                if (minThreads > 0) {
                    return this.executePreparationTask(SCRIPT_PATH.weaken, minThreads, target, freeRams);
                }
                return false;
            }
            return this.executePreparationTask(SCRIPT_PATH.weaken, halfThreads, target, freeRams);
        }

        // Execute weaken with full required threads
        return this.executePreparationTask(SCRIPT_PATH.weaken, requiredThreads, target, freeRams);
    }

    /**
     * Grow a server to maximum money
     * @param {string} target - Target server
     * @param {RamUsage} freeRams - Available RAM
     * @returns {boolean} Whether grow was started
     */
    growServer(target: string, freeRams: RamUsage): boolean {
        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);

        // If security is above minimum, go back to weakening
        if (securityLevel > minSecurityLevel + CONFIG.batch.prepSecurity) {
            serverPreparationState.set(target, 'weakening');
            return this.weakenServer(target, freeRams);
        }

        const currentMoney = this.ns.getServerMoneyAvailable(target);
        const maxMoney = this.ns.getServerMaxMoney(target);

        // If money is already at max, mark as ready
        if (currentMoney >= maxMoney * CONFIG.batch.prepMoneyThreshold) {
            serverPreparationState.set(target, 'ready');
            return false;
        }

        // Special case: if money is zero, add $1 before growing
        if (currentMoney <= 1) {
            // Execute a minimal grow to get money on the server
            if (freeRams.overallFreeRam >= SCRIPT_RAM.slaveScript) {
                return this.executePreparationTask(SCRIPT_PATH.grow, 1, target, freeRams);
            }
            return false;
        }

        // Calculate growth factor needed
        const growthFactor = maxMoney / currentMoney;

        // Calculate grow threads needed
        let growThreads;
        if (this.ns.fileExists('Formulas.exe')) {
            const server = this.ns.getServer(target);
            const player = this.ns.getPlayer();
            server.moneyAvailable = currentMoney;
            growThreads = Math.ceil(this.ns.formulas.hacking.growThreads(
                server, player, maxMoney, this.ns.getServer('home').cpuCores
            ));
        } else {
            growThreads = Math.ceil(this.ns.growthAnalyze(target, growthFactor));
        }

        // Calculate security increase from grow
        const growSecurityIncrease = this.ns.growthAnalyzeSecurity(growThreads);

        // Calculate weaken threads needed to counter grow security increase
        const weakenThreads = Math.ceil(growSecurityIncrease / CONFIG.security.weakenSecurityDecrease);

        // Calculate total RAM needed
        const totalRamNeeded = (growThreads + weakenThreads) * SCRIPT_RAM.slaveScript;

        // Check if we have enough RAM for both grow and weaken
        if (freeRams.overallFreeRam < totalRamNeeded) {
            // Try with fewer threads
            const scaleFactor = Math.floor(freeRams.overallFreeRam / totalRamNeeded * 100) / 100;
            if (scaleFactor <= 0) return false;

            const adjustedGrowThreads = Math.max(1, Math.floor(growThreads * scaleFactor));
            const adjustedWeakenThreads = Math.max(1, Math.floor(weakenThreads * scaleFactor));

            // Execute grow and weaken with adjusted threads
            const growSuccess = this.executePreparationTask(SCRIPT_PATH.grow, adjustedGrowThreads, target, freeRams);
            if (!growSuccess) return false;

            return this.executePreparationTask(SCRIPT_PATH.weaken, adjustedWeakenThreads, target, freeRams);
        }

        // Execute grow and weaken with full threads
        const growSuccess = this.executePreparationTask(SCRIPT_PATH.grow, growThreads, target, freeRams);
        if (!growSuccess) return false;

        return this.executePreparationTask(SCRIPT_PATH.weaken, weakenThreads, target, freeRams);
    }

    /**
     * Execute a preparation task with distributed threads
     * @param {string} script - Script to run
     * @param {number} threads - Number of threads
     * @param {string} target - Target server
     * @param {RamUsage} freeRams - Available RAM
     * @returns {boolean} Whether the task was started
     */
    executePreparationTask(script: string, threads: number, target: string, freeRams: RamUsage): boolean {
        if (threads <= 0) return false;

        const scriptRam = this.ns.getScriptRam(script);
        const totalRamNeeded = scriptRam * threads;

        // Check if we have enough RAM
        if (freeRams.overallFreeRam < totalRamNeeded) {
            return false;
        }

        // Get servers with free RAM
        const serverRamsCopy = freeRams.serverRams;

        // Sort by free RAM (descending)
        serverRamsCopy.sort((a, b) => b.freeRam - a.freeRam);

        let remainingThreads = threads;

        for (const serverRamInfo of serverRamsCopy) {
            if (remainingThreads <= 0) break;

            const maxThreads = Math.floor(serverRamInfo.freeRam / scriptRam);
            if (maxThreads <= 0) continue;

            const threadsToRun = Math.min(maxThreads, remainingThreads);

            // Copy script if needed
            if (!this.ns.fileExists(script, serverRamInfo.host)) {
                if (!this.ns.scp(script, serverRamInfo.host, 'home')) {
                    this.ns.write('/tmp/log.txt', `Failed to copy ${script} to ${serverRamInfo.host}\n`, 'a');
                    continue;
                }
            }

            // For preparation tasks, we use a simpler approach without timing
            // The loopingMode flag (last parameter) is set to true to keep the script running
            const args = [
                target,                // Target server
                Date.now(),            // Start time (immediately)
                0,                     // No specific duration
                `prep-${script.split('/').pop()?.split('.')[0]}`, // Description
                false,                 // No stock manipulation
                true,                  // Silent misfires
                true                   // Looping mode
            ];

            const pid = this.ns.exec(script, serverRamInfo.host, threadsToRun, ...args);

            if (pid > 0) {
                remainingThreads -= threadsToRun;
                freeRams.reserveRam(threadsToRun * scriptRam, serverRamInfo.host);
            } else {
                const errorMsg = `Failed to execute ${script} on ${serverRamInfo.host} with ${threadsToRun} threads`;
                this.ns.write('/tmp/log.txt', errorMsg + '\n', 'a');
            }
        }

        return remainingThreads === 0;
    }
}

/**
 * BatchScheduler class - handles scheduling and execution of batched operations
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
     * @param {Date} startTime - When to start the batch
     * @param {string} target - Target server
     * @returns {BatchTimings} Timing schedule for all operations
     */
    calculateBatchTiming(startTime: Date, target: string): BatchTimings {
        // Get operation times
        const hackTime = this.ns.getHackTime(target);
        const growTime = this.ns.getGrowTime(target);
        const weakenTime = this.ns.getWeakenTime(target);

        // Delay between operations to ensure proper execution order
        const delayBetweenOperations = CONFIG.batch.operationDelay;

        // We want operations to complete in this order: 
        // Hack -> Weaken1 -> Grow -> Weaken2
        // with a delay of delayBetweenOperations milliseconds between each completion

        // First determine when each operation should complete
        const weaken2End = new Date(startTime.getTime() + weakenTime);
        const growEnd = new Date(weaken2End.getTime() - delayBetweenOperations);
        const weaken1End = new Date(growEnd.getTime() - delayBetweenOperations);
        const hackEnd = new Date(weaken1End.getTime() - delayBetweenOperations);

        // Then determine when each operation should start
        const hackStart = new Date(hackEnd.getTime() - hackTime);
        const weaken1Start = new Date(weaken1End.getTime() - weakenTime);
        const growStart = new Date(growEnd.getTime() - growTime);
        const weaken2Start = new Date(weaken2End.getTime() - weakenTime);

        // Find first operation to end and last operation to start
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
     * @param {string} target - Target server
     * @param {RamUsage} freeRams - Available RAM
     * @param {number} hackMoneyRatio - Percentage of money to hack
     * @returns {boolean} Whether the batch was successfully scheduled
     */
    scheduleHWGWBatch(target: string, freeRams: RamUsage, hackMoneyRatio: number): boolean {
        // Get current active batch count for this target
        const currentBatches = this.activeBatchCount.get(target) || 0;

        // Don't exceed max concurrent batches per target
        if (currentBatches >= CONFIG.batch.maxBatchesPerTarget) {
            return false;
        }

        // Calculate start time for this batch
        const startTime = new Date(Date.now() + CONFIG.batch.batchSpacing * currentBatches);

        // Get timing schedule
        const timings = this.calculateBatchTiming(startTime, target);

        // Calculate strategy (thread counts)
        const strategy = this.calculateBatchStrategy(target, hackMoneyRatio);

        // We need enough RAM for all operations
        const totalThreads =
            strategy.hackThreads +
            strategy.weakenForHackThreads +
            strategy.growThreads +
            strategy.weakenThreads;

        const totalRamNeeded = totalThreads * SCRIPT_RAM.slaveScript;

        if (freeRams.overallFreeRam < totalRamNeeded) {
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
                target,
                manipulateStock: false
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
                target,
                manipulateStock: false
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

        // Create batch plan
        const batchPlan: BatchPlan = {
            batchNumber: this.batchNumber++,
            operations,
            target,
            startTime,
            endTime: timings.weaken2End
        };

        // Execute the batch
        if (this.executeBatchPlan(batchPlan, freeRams)) {
            // Update active batch count
            this.activeBatchCount.set(target, currentBatches + 1);

            // Schedule a function to decrease the counter after batch completes
            setTimeout(() => {
                const count = this.activeBatchCount.get(target) || 0;
                if (count > 0) {
                    this.activeBatchCount.set(target, count - 1);
                }
            }, timings.weaken2End.getTime() - Date.now() + 100);

            // Track profit for this server
            const profit = strategy.hackThreads * this.ns.getServerMaxMoney(target) * hackMoneyRatio * this.ns.hackAnalyze(target);
            const hackTime = this.ns.getHackTime(target);
            const profitPerMinute = profit / (hackTime / 60000);
            profitsMap.set(target, profitPerMinute);

            return true;
        }

        return false;
    }

    /**
     * Calculate thread counts for a batch
     * @param {string} target - Target server
     * @param {number} hackMoneyRatio - Percentage of money to hack
     * @returns {AttackStrategy} Thread counts for each operation
     */
    calculateBatchStrategy(target: string, hackMoneyRatio: number): AttackStrategy {
        const server = this.ns.getServer(target);
        const player = this.ns.getPlayer();
        const cores = this.ns.getServer('home').cpuCores;

        let hackThreads: number;
        let growThreads: number;
        let weakenThreads: number;
        let weakenForHackThreads: number;

        // Limit hack ratio to the configured target percentage
        const effectiveHackRatio = Math.min(hackMoneyRatio, CONFIG.batch.targetHackPercentage);

        if (this.ns.fileExists('Formulas.exe')) {
            const formulas = this.ns.formulas.hacking;

            // Calculate hack threads using formulas
            const hackPercent = formulas.hackPercent(server, player);
            hackThreads = Math.floor(effectiveHackRatio / hackPercent);
            hackThreads = Math.max(1, hackThreads); // Ensure at least 1 thread

            // Calculate security increase from hack
            const hackSecurityIncrease = this.ns.hackAnalyzeSecurity(hackThreads);
            weakenForHackThreads = Math.ceil(hackSecurityIncrease / CONFIG.security.weakenSecurityDecrease);

            // Calculate growth factor after hack
            const moneyRemaining = (server.moneyMax || 0) * (1 - effectiveHackRatio);
            const growthRequired = (server.moneyMax || 0) / moneyRemaining;

            // Calculate grow threads using formulas
            server.moneyAvailable = moneyRemaining; // Temporarily modify for grow calculation
            growThreads = Math.ceil(formulas.growThreads(server, player, server.moneyMax || 0, cores));
            server.moneyAvailable = server.moneyMax || 0; // Restore original value

            // Calculate security increase from grow
            const growSecurityIncrease = this.ns.growthAnalyzeSecurity(growThreads);
            weakenThreads = Math.ceil(growSecurityIncrease / CONFIG.security.weakenSecurityDecrease);
        } else {
            // Fallback calculations without Formulas.exe
            const hackPercent = this.ns.hackAnalyze(target);
            hackThreads = Math.floor(effectiveHackRatio / hackPercent);
            hackThreads = Math.max(1, hackThreads); // Ensure at least 1 thread

            const hackSecurityIncrease = this.ns.hackAnalyzeSecurity(hackThreads);
            weakenForHackThreads = Math.ceil(hackSecurityIncrease / CONFIG.security.weakenSecurityDecrease);

            const growthRequired = 1 / (1 - effectiveHackRatio);
            growThreads = Math.ceil(this.ns.growthAnalyze(target, growthRequired));

            const growSecurityIncrease = this.ns.growthAnalyzeSecurity(growThreads);
            weakenThreads = Math.ceil(growSecurityIncrease / CONFIG.security.weakenSecurityDecrease);
        }

        // Ensure minimum of 1 thread for each operation
        hackThreads = Math.max(1, hackThreads);
        growThreads = Math.max(1, growThreads);
        weakenThreads = Math.max(1, weakenThreads);
        weakenForHackThreads = Math.max(1, weakenForHackThreads);

        const totalThreads = hackThreads + growThreads + weakenThreads + weakenForHackThreads;
        const totalRAM = totalThreads * SCRIPT_RAM.slaveScript;

        return {
            hackThreads,
            growThreads,
            weakenThreads,
            weakenForHackThreads,
            totalThreads,
            totalRAM,
            serverValue: (server.moneyMax || 0) * (server.serverGrowth || 0) * this.ns.hackAnalyze(target),
            maxStealPercentage: effectiveHackRatio
        };
    }

    /**
     * Execute a batch plan by distributing operations across servers
     * @param {BatchPlan} batchPlan - The batch plan to execute
     * @param {RamUsage} freeRams - Available RAM information
     * @returns {boolean} Whether all operations were successfully scheduled
     */
    executeBatchPlan(batchPlan: BatchPlan, freeRams: RamUsage): boolean {
        // Sort operations by thread count (descending) to execute largest first
        const sortedOperations = [...batchPlan.operations].sort((a, b) => b.threads - a.threads);

        for (const operation of sortedOperations) {
            // Execute the operation
            const success = this.executeOperation(operation, freeRams);

            if (!success) {
                // If any operation fails, the batch fails
                if (CONFIG.batch.debugLogs) {
                    this.ns.print(`Failed to execute operation ${operation.description} for batch ${batchPlan.batchNumber} targeting ${batchPlan.target}`);
                }
                return false;
            }
        }

        if (CONFIG.batch.debugLogs) {
            this.ns.print(`Successfully scheduled batch ${batchPlan.batchNumber} for ${batchPlan.target} with ${batchPlan.operations.length} operations`);
        }

        return true;
    }

    /**
     * Execute a single batch operation
     * @param {BatchOperation} operation - The operation to execute
     * @param {RamUsage} freeRams - Available RAM
     * @returns {boolean} Whether the operation was successfully executed
     */
    executeOperation(operation: BatchOperation, freeRams: RamUsage): boolean {
        if (operation.threads <= 0) return true;

        // Calculate delay time for script execution
        const startTime = operation.startTime.getTime();

        // Split threads across available servers
        let remainingThreads = operation.threads;
        const serverRamsCopy = freeRams.serverRams;

        // Sort servers by free RAM (descending) to use larger chunks first
        serverRamsCopy.sort((a, b) => b.freeRam - a.freeRam);

        for (const serverRamInfo of serverRamsCopy) {
            if (remainingThreads <= 0) break;

            const scriptRam = this.ns.getScriptRam(operation.script);
            const maxThreads = Math.floor(serverRamInfo.freeRam / scriptRam);

            if (maxThreads <= 0) continue;

            const threadsToRun = Math.min(maxThreads, remainingThreads);

            // Copy script if needed
            if (!this.ns.fileExists(operation.script, serverRamInfo.host)) {
                if (!this.ns.scp(operation.script, serverRamInfo.host, 'home')) {
                    this.ns.write('/tmp/log.txt', `Failed to copy ${operation.script} to ${serverRamInfo.host}\n`, 'a');
                    continue;
                }
            }

            // Run script with batch timing parameters
            const args = [
                operation.target,
                startTime,
                operation.endTime.getTime() - startTime,
                `${operation.description}-batch${this.batchNumber}`,
                operation.manipulateStock || false,
                CONFIG.batch.silentMisfires,
            ];

            const pid = this.ns.exec(operation.script, serverRamInfo.host, threadsToRun, ...args);

            if (pid > 0) {
                // Successfully started script
                remainingThreads -= threadsToRun;
                // Update RAM usage
                freeRams.reserveRam(threadsToRun * scriptRam, serverRamInfo.host);
            } else {
                const errorMsg = `Failed to execute ${operation.script} on ${serverRamInfo.host} with ${threadsToRun} threads`;
                this.ns.write('/tmp/log.txt', errorMsg + '\n', 'a');
            }
        }

        return remainingThreads === 0;
    }
}

/**
 * Main function that orchestrates the distributed batch hacking operation
 * @param {NS} ns - The Netscript API
 */
export async function main(ns: NS): Promise<void> {
    ns.ui.openTail();
    ns.disableLog('ALL');
    ns.clearLog();

    const startTime = Date.now();

    // Make sure scripts exist
    ensureSlaveScriptsExist(ns);

    // Initialize managers
    const batchScheduler = new BatchScheduler(ns);
    const prepManager = new ServerPreparationManager(ns);

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
    let shareThreadIndex = 0;

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

            /* CORE ATTACK LOGIC - Now with batching */
            freeRams = getFreeRam(ns, servers);

            // Log when servers are filtered
            const filteredServers = filterServersByRam(ns, servers);
            if (CONFIG.ram.ignoreServersLowerThanPurchased &&
                (lastServerCount !== servers.size || lastFilteredCount !== filteredServers.size)) {
                lastServerCount = servers.size;
                lastFilteredCount = filteredServers.size;
            }

            targets = getHackableServers(ns, Array.from(servers));

            // Launch batch attacks with timeout protection
            const batchesLaunched = await manageBatchAttacks(
                ns,
                batchScheduler,
                prepManager,
                freeRams,
                targets,
                hackMoneyRatio
            );

            if (batchesLaunched > 0) {
                ramUsage = freeRams.utilization;
                hackMoneyRatio = adjustHackMoneyRatio(ns, ramUsage, hackMoneyRatio);
            }

            // Handle additional features in a more modular way
            shareThreadIndex = await runAdditionalFeatures(ns, freeRams, servers, targets, moneyXpShare, hackMoneyRatio, shareThreadIndex);

            // Periodic server purchases
            if (tick % purchaseServerFreq === 0) {
                handleServerPurchases(ns);
            }

            // Check and buy port openers periodically
            if (tick % portOpenerFreq === 0) {
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
                    batchesLaunched,
                    freeRams.overallFreeRam,
                    freeRams.overallMaxRam,
                    incomePerSecond,
                    prepManager
                );
            }

        } catch (error) {
            ns.tprint(`ERROR: ${String(error)}`);
        }
        await ns.sleep(CONFIG.timing.cycleSleep);
    }
}

/**
 * Main batch hacking logic with server preparation
 * @param {NS} ns - Netscript API
 * @param {BatchScheduler} batchScheduler - Batch scheduler
 * @param {ServerPreparationManager} prepManager - Server preparation manager
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string[]} targets - Array of potential hack targets
 * @param {number} hackMoneyRatio - Current hack money ratio
 * @returns {Promise<number>} Number of batches launched
 */
async function manageBatchAttacks(
    ns: NS,
    batchScheduler: BatchScheduler,
    prepManager: ServerPreparationManager,
    freeRams: RamUsage,
    targets: string[],
    hackMoneyRatio: number
): Promise<number> {
    // Add timeout protection for thread calculations
    const startTime = Date.now();
    let batchesLaunched = 0;

    // Process targets in order of priority
    for (const target of targets) {
        // Check for timeout
        if (CONFIG.features.useTimedThreadAdjustment && Date.now() - startTime > CONFIG.timing.maxThreadCalculationTime) {
            ns.tprint(`WARNING: Batch calculation timeout reached after ${CONFIG.timing.maxThreadCalculationTime}ms`);
            break;
        }

        // Skip if we've maxed out parallel attacks
        if (batchesLaunched >= CONFIG.maxParallelAttacks) break;

        // If batch mode is disabled, skip
        if (!CONFIG.batch.enabled) break;

        // First check if the server is prepared
        const isReady = prepManager.isServerPrepared(target);

        if (!isReady) {
            // Prepare the server if not ready
            await prepManager.prepareServer(target, freeRams);
            continue; // Skip to next target
        }

        // Server is prepared, attempt to launch a batch
        if (batchScheduler.scheduleHWGWBatch(target, freeRams, hackMoneyRatio)) {
            batchesLaunched++;
        }
    }

    return batchesLaunched;
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
    if (homeRam >= 65536) { hackMoneyRatio = 0.5; } // Reduced from 0.99 for batch hacking
    else if (homeRam >= 16384) { hackMoneyRatio = 0.4; } // Reduced from 0.9 for batch hacking
    else if (homeRam > 8192) { hackMoneyRatio = 0.3; } // Reduced from 0.5 for batch hacking
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
    // If batch mode is disabled, use more aggressive adjustment
    if (!CONFIG.batch.enabled) {
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

    // For batch mode, use more conservative adjustment
    // Already using lots of RAM at high ratio, decrease
    if (ramUsage > CONFIG.thresholds.ramUsageHigh && currentRatio > CONFIG.thresholds.hackMoneyRatioMin) {
        const newRatio = Math.max(CONFIG.thresholds.hackMoneyRatioMin, currentRatio * 0.98);
        return newRatio;
    }
    // Low RAM usage, increase ratio to use more capacity, but be more conservative
    if (ramUsage < CONFIG.thresholds.ramUsageLow && currentRatio < CONFIG.batch.targetHackPercentage * 2) {
        const newRatio = Math.min(CONFIG.batch.targetHackPercentage * 2, currentRatio * 1.02);
        return newRatio;
    }
    // No adjustment needed
    return currentRatio;
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
    if (moneyXpShare && hackMoneyRatio >= 0.9) {
        updatedShareThreadIndex = shareComputingPower(ns, shareThreadIndex, freeRams);
    }

    // Run XP weaken if we have spare RAM
    const ramUsage = freeRams.utilization;
    if (ramUsage < CONFIG.thresholds.ramUsageLow && hackMoneyRatio >= 0.9) {
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
                    CONFIG.ram.minReserveHomeRam
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

function displayAllStats(
    ns: NS,
    startTime: number,
    targets: string[],
    profitsMap: Map<string, number>,
    hackMoneyRatio: number,
    ramUsage: number,
    servers: Set<string>,
    batchesLaunched: number,
    homeFree: number,
    homeRam: number,
    incomePerSecond: number,
    prepManager: ServerPreparationManager
): void {
    // Get purchased server info for display
    const purchasedServers = ns.getPurchasedServers();
    const filteredServers = filterServersByRam(ns, servers);
    const filteredCount = filteredServers.size;
    const totalCount = servers.size;
    const filteredInfo = CONFIG.ram.ignoreServersLowerThanPurchased && purchasedServers.length > 0
        ? `${filteredCount}/${totalCount}`
        : `${totalCount}`;

    // Count servers by prep state
    let readyCount = 0;
    let weakCount = 0;
    let growCount = 0;
    let noneCount = 0;

    for (const target of targets) {
        const state = prepManager.getPreparationState(target);
        if (state === 'ready') readyCount++;
        else if (state === 'weakening') weakCount++;
        else if (state === 'growing') growCount++;
        else noneCount++;
    }

    const batchModeStatus = CONFIG.batch.enabled ? 'ENABLED' : 'DISABLED';

    const displayLines = [
        '=== BATCH HACKING STATUS ===',
        `Batch Mode: ${batchModeStatus}`,
        `Hack Ratio: ${hackMoneyRatio.toFixed(2)}`,
        `RAM Usage: ${Math.round(ramUsage * 100)}%`,
        `Targets: ${targets.length} (Ready: ${readyCount}, Weak: ${weakCount}, Grow: ${growCount}, None: ${noneCount})`,
        `Servers: ${filteredInfo}${purchasedServers.length > 0 ? ` (${purchasedServers.length} purchased)` : ''}`,
        `Batches: ${batchesLaunched}`,
        `Home RAM: ${formatRam(homeFree)}/${formatRam(homeRam)}`,
        `Hacking Level: ${ns.getHackingLevel()}`,
        '',
        '=== PERFORMANCE ===',
        `Runtime: ${formatTime((Date.now() - startTime) / 1000)}`,
        `Income/sec: ${formatMoney(incomePerSecond)}`,
        '',
        '=== TOP TARGETS ===',
        'Server | Money | Security | State | Profit'
    ];

    // Add top 5 targets
    const topTargets = targets.slice(0, 5);
    for (const target of topTargets) {
        try {
            const money = ns.getServerMoneyAvailable(target);
            const maxMoney = ns.getServerMaxMoney(target);
            const security = ns.getServerSecurityLevel(target);
            const minSecurity = ns.getServerMinSecurityLevel(target);
            const state = prepManager.getPreparationState(target);
            const profit = profitsMap.get(target) || 0;

            const moneyPercent = money / maxMoney * 100;
            const moneyText = `${formatMoney(money)}/${formatMoney(maxMoney)}`;
            const securityText = `${security.toFixed(1)}/${minSecurity.toFixed(1)}`;
            const stateText = state.charAt(0).toUpperCase() + state.slice(1);
            const profitText = formatMoney(profit);

            displayLines.push(`${target} | ${moneyText} (${moneyPercent.toFixed(1)}%) | ${securityText} | ${stateText} | ${profitText}`);
        } catch (error) {
            displayLines.push(`${target} | Error: ${error} | Retrieving data`);
        }
    }
    prettyDisplay(ns, displayLines);
}

/**
 * Distribute a task across servers
 * @param {NS} ns - Netscript API
 * @param {string} script - Script to run
 * @param {number} threads - Number of threads
 * @param {RamUsage} freeRams - RAM usage information
 * @param {string} target - Target server
 * @param {number} sleepTime - Sleep time (ms)
 * @param {boolean|string} manipulateStock - Whether to manipulate stock
 * @returns {boolean} Whether the task was distributed successfully
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

    // Sort servers by free RAM (descending) to use larger chunks first
    serverRamsCopy.sort((a, b) => b.freeRam - a.freeRam);

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
