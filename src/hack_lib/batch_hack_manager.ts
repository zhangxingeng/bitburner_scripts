import { NS } from '@ns';
import { formatPercent, formatMoney } from '../lib/util_low_ram';
import { RamManager } from './ram_manager';
import { ServerTargetManager } from './server_target_manager';
import { ThreadDistributionManager } from './thread_distribution_manager';
import { HackingConfig } from './hack_config';
import { FormulaHelper } from './formulas';
import { Allocator } from './allocator';
import { execMulti } from './exec_multi';

/**
 * Format RAM to human-readable string
 * @param ram RAM in GB
 * @returns Formatted RAM string
 */
function formatRam(ram: number): string {
    if (ram < 1024) {
        return `${ram.toFixed(2)}GB`;
    } else if (ram < 1024 * 1024) {
        return `${(ram / 1024).toFixed(2)}TB`;
    } else {
        return `${(ram / (1024 * 1024)).toFixed(2)}PB`;
    }
}

/**
 * Represents batch calculation result
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
    weaken1Time: number;
    weaken2Time: number;
    hackTime: number;
    growTime: number;
}

/**
 * Manages batch hack operations across multiple servers
 */
export class BatchHackManager {
    private ns: NS;
    private config: HackingConfig;
    private threadManager: ThreadDistributionManager;
    private activeBatches: Map<string, BatchCalculation>;
    private totalBatchesLaunched: number;
    private formulas: FormulaHelper;
    private batchId: number = 0;

    /**
     * Create a new BatchHackManager
     */
    constructor(
        ns: NS,
        config: HackingConfig,
        threadManager: ThreadDistributionManager
    ) {
        this.ns = ns;
        this.config = config;
        this.threadManager = threadManager;
        this.activeBatches = new Map<string, BatchCalculation>();
        this.totalBatchesLaunched = 0;
        this.formulas = new FormulaHelper(ns);
    }

    /**
     * Reset batch count for reporting purposes
     */
    resetBatchCount(): void {
        this.totalBatchesLaunched = 0;
    }

    /**
     * Get the total number of batches launched since last reset
     */
    getTotalBatchesLaunched(): number {
        return this.totalBatchesLaunched;
    }

    /**
     * Prune completed batches from active tracking
     */
    pruneActiveBatches(): void {
        // In a tick-based system, we don't have a way to know when batches complete
        // So we just reset the tracking map periodically
        this.activeBatches.clear();
    }

    /**
     * Calculate the optimal batch strategy for a target
     * @param target Target server hostname
     * @param hackThreads Number of hack threads to use
     * @param availableAllocs Available thread allocations per server
     * @returns Batch calculation result or null if not possible
     */
    async calculateBatchStrategy(
        target: string,
        hackThreads: number,
        availableAllocs: number[]
    ): Promise<BatchCalculation | null> {
        // Get server and player info
        const serverOptimal = this.formulas.getOptimalServer(target);
        const player = this.ns.getPlayer();

        // Calculate operation times
        const weaken1Time = this.formulas.getWeakenTime(serverOptimal, player);
        const weaken2Time = this.formulas.getWeakenTime(serverOptimal, player);
        const hackTime = this.formulas.getHackTime(serverOptimal, player);
        const growTime = this.formulas.getGrowTime(serverOptimal, player);

        // Calculate batch gap based on step time
        const batchGap = this.config.batchConfig.stepTime * 4;

        // Calculate maximum possible batches based on hack time
        const maxBatches = this.config.batchConfig.maxConcurrency > 0
            ? Math.min(this.config.batchConfig.maxConcurrency, Math.floor(hackTime / batchGap + 1))
            : Math.floor(hackTime / batchGap + 1);

        // Calculate money stolen per hack
        const hackPercent = this.formulas.getHackPercent(serverOptimal, player);
        const moneyMax = serverOptimal.moneyMax || 1;
        const moneyAvailable = serverOptimal.moneyAvailable || moneyMax;
        const dollarPerHack = Math.min(moneyMax, moneyAvailable * hackPercent * hackThreads);

        // Calculate thread requirements
        const hackThreadsRaw = hackThreads;

        // Create server copy for grow calculation
        const serverBeforeGrow = this.formulas.getOptimalServer(target);
        const serverMoneyMax = serverBeforeGrow.moneyMax || 1;
        serverBeforeGrow.moneyAvailable = Math.max(1, (serverMoneyMax - dollarPerHack));

        // Calculate grow threads needed
        const growThreadsRaw = this.formulas.getGrowThreads(serverBeforeGrow, player, hackThreads);

        // Calculate weaken threads needed
        const weaken1ThreadsRaw = hackThreadsRaw * this.config.securityConstants.hackSecurityIncrease /
            this.config.securityConstants.weakenSecurityDecrease;
        const weaken2ThreadsRaw = growThreadsRaw * this.config.securityConstants.growSecurityIncrease /
            this.config.securityConstants.weakenSecurityDecrease;

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
                await this.ns.sleep(1);
            }
        }

        // If no batches could be allocated, return null
        if (batchCount === 0) return null;

        // Calculate batch duration and DPS
        const secondPerBatch = (weaken1Time + batchCount * batchGap) / 1000;
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
            weaken1Time,
            weaken2Time,
            hackTime,
            growTime
        };
    }

    /**
     * Find the best hack threads value for a target
     * @param target Target server hostname
     * @param availableAllocs Available thread allocations per server
     * @returns Best batch calculation or null if not possible
     */
    async findBestHackThreads(
        target: string,
        availableAllocs: number[]
    ): Promise<BatchCalculation | null> {
        let bestHackThreads = 1;
        let bestDps = 0;
        let bestCalc: BatchCalculation | null = null;

        // Try different hack thread values to find the optimal
        const maxHackThreads = this.config.batchConfig.maxHackPerBatch > 0
            ? this.config.batchConfig.maxHackPerBatch
            : 100;  // Reasonable upper limit

        for (let hpb = 1; hpb <= maxHackThreads; hpb++) {
            const calc = await this.calculateBatchStrategy(target, hpb, availableAllocs);
            if (calc && calc.dps > bestDps) {
                bestDps = calc.dps;
                bestHackThreads = hpb;
                bestCalc = calc;
            }

            // Small wait to prevent excessive CPU usage
            if (hpb % 5 === 0) {
                await this.ns.sleep(1);
            }
        }

        return bestCalc;
    }

    /**
     * Select and execute batches on a set of targets
     * @param targetManager Server target manager to use
     * @param ramManager RAM manager to use 
     * @param maxTargets Maximum number of targets to hack
     * @returns Number of new batches scheduled
     */
    async scheduleBatches(
        targetManager: ServerTargetManager,
        ramManager: RamManager,
        maxTargets: number = 1
    ): Promise<number> {
        // Get best prepared targets
        const targets = targetManager.getBestTargets(maxTargets, true);

        // Skip if no suitable targets
        if (targets.length === 0) {
            return 0;
        }

        // Get available allocations
        const availableAllocs = ramManager.getAllocMap();

        let newBatchesLaunched = 0;

        for (const target of targets) {
            // Skip if we're already batching this target
            if (this.activeBatches.has(target)) {
                continue;
            }

            // Skip if target doesn't have 100% hack chance
            if (!targetManager.hasMaxHackChance(target)) {
                continue;
            }

            // Find the best hack threads value
            const bestCalc = await this.findBestHackThreads(target, availableAllocs.slice());

            if (bestCalc) {
                // Store the active batch
                this.activeBatches.set(target, bestCalc);

                // Update the RAM manager with the allocated RAM
                this.reserveRamForBatch(ramManager, bestCalc);

                // Schedule batch execution
                this.executeTargetBatches(target, bestCalc, ramManager);

                // Increment counters
                newBatchesLaunched++;
                this.totalBatchesLaunched += bestCalc.concurrency;

                this.ns.print(`Started batching ${target} with ${bestCalc.concurrency} batches, ${formatMoney(bestCalc.dps)}/sec`);
            }
        }

        return newBatchesLaunched;
    }

    /**
     * Reserve RAM in the manager for a batch
     * @param ramManager RAM manager to use
     * @param calc Batch calculation to reserve RAM for
     */
    private reserveRamForBatch(ramManager: RamManager, calc: BatchCalculation): void {
        const serverList = ramManager.getAvailableServers();

        // Get total thread allocation for each server
        for (let serverIndex = 0; serverIndex < serverList.length; serverIndex++) {
            const server = serverList[serverIndex];

            // Add up all threads allocated on this server
            let totalThreads = 0;

            for (let batchIndex = 0; batchIndex < calc.concurrency; batchIndex++) {
                if (calc.hackServerAlloc[batchIndex] && serverIndex < calc.hackServerAlloc[batchIndex].length) {
                    totalThreads += calc.hackServerAlloc[batchIndex][serverIndex];
                }
                if (calc.growServerAlloc[batchIndex] && serverIndex < calc.growServerAlloc[batchIndex].length) {
                    totalThreads += calc.growServerAlloc[batchIndex][serverIndex];
                }
                if (calc.weaken1ServerAlloc[batchIndex] && serverIndex < calc.weaken1ServerAlloc[batchIndex].length) {
                    totalThreads += calc.weaken1ServerAlloc[batchIndex][serverIndex];
                }
                if (calc.weaken2ServerAlloc[batchIndex] && serverIndex < calc.weaken2ServerAlloc[batchIndex].length) {
                    totalThreads += calc.weaken2ServerAlloc[batchIndex][serverIndex];
                }
            }

            // Reserve the RAM
            if (totalThreads > 0) {
                const ramNeeded = totalThreads * this.config.scriptRamCost;
                ramManager.reserveRam(ramNeeded, server);
            }
        }
    }

    /**
     * Execute batches for a target
     * @param target Target server hostname
     * @param calc Batch calculation to execute
     * @param ramManager RAM manager to use
     */
    private executeTargetBatches(target: string, calc: BatchCalculation, ramManager: RamManager): void {
        const serverList = ramManager.getAvailableServers();

        if (serverList.length === 0) return;

        const now = Date.now();
        const stepTime = this.config.batchConfig.stepTime;

        // Calculate finish times for each operation
        const batchFinishTime = now + calc.weaken1Time;

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
            const weaken1Start = weaken1Finish - calc.weaken1Time;
            const growStart = growFinish - calc.growTime;
            const weaken2Start = weaken2Finish - calc.weaken2Time;

            // Generate batch ID
            const batchId = this.generateBatchId();

            // Execute hack
            if (calc.hackServerAlloc[i] && calc.hackServerAlloc[i].some(t => t > 0)) {
                this.executeOperation(
                    this.config.scriptPaths.hack,
                    calc.hackServerAlloc[i],
                    serverList,
                    target,
                    calc.hackPerBatch,
                    hackStart,
                    hackFinish,
                    `batch-hack-${batchId}`
                );
            }

            // Execute weaken1 (after hack)
            if (calc.weaken1ServerAlloc[i] && calc.weaken1ServerAlloc[i].some(t => t > 0)) {
                this.executeOperation(
                    this.config.scriptPaths.weaken1,
                    calc.weaken1ServerAlloc[i],
                    serverList,
                    target,
                    Math.ceil(calc.weaken1ThreadsRaw),
                    weaken1Start,
                    weaken1Finish,
                    `batch-weaken1-${batchId}`
                );
            }

            // Execute grow
            if (calc.growServerAlloc[i] && calc.growServerAlloc[i].some(t => t > 0)) {
                this.executeOperation(
                    this.config.scriptPaths.grow,
                    calc.growServerAlloc[i],
                    serverList,
                    target,
                    calc.growPerBatch,
                    growStart,
                    growFinish,
                    `batch-grow-${batchId}`
                );
            }

            // Execute weaken2 (after grow)
            if (calc.weaken2ServerAlloc[i] && calc.weaken2ServerAlloc[i].some(t => t > 0)) {
                this.executeOperation(
                    this.config.scriptPaths.weaken2,
                    calc.weaken2ServerAlloc[i],
                    serverList,
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
    private executeOperation(
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
            if (!this.ns.serverExists(server)) continue;

            // Execute script
            execMulti(
                this.ns,
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
     * Generate a unique batch ID
     */
    private generateBatchId(): number {
        return this.batchId++;
    }

    /**
     * Print status message
     */
    printStatus(ramManager: RamManager, batchesLaunched: number): void {
        // Calculate RAM utilization percentage
        const totalRam = ramManager.getTotalMaxRam();
        const freeRam = ramManager.getTotalFreeRam();
        const utilizationPercent = totalRam > 0 ? (totalRam - freeRam) / totalRam * 100 : 0;

        this.ns.print(`Status: ${this.totalBatchesLaunched} total batches launched, ${batchesLaunched} new, ` +
            `${formatRam(ramManager.getTotalFreeRam())} RAM free, ` +
            `${formatPercent(utilizationPercent)}% utilized`);
    }
}
