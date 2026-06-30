import { NS } from '@ns';
import { formatMoney, formatRam as fmtRam } from '../lib/format';
import {
    SCRIPT_PATHS,
    SCRIPT_RAM_COST,
    BATCH_STEP_TIME,
    BATCH_MAX_CONCURRENCY,
    BATCH_MAX_HACK_PER_BATCH,
    HACK_SECURITY_INCREASE,
    GROW_SECURITY_INCREASE,
    WEAKEN_SECURITY_DECREASE,
} from '../lib/config';
import { RamManager } from './ram_manager';
import { TargetSelector } from './target_selector';
import { ThreadDistributionManager } from './scheduler';
import { FormulaHelper } from './formulas';
import { Allocator } from './allocator';
import { execMulti } from './exec_multi';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Result of a HWGW batch calculation for one target. */
interface BatchCalculation {
    dps: number;                    // Dollars per second if this batch runs continuously
    tpb: number;                    // Total threads per batch cycle
    hackServerAlloc: number[][];    // Per-batch, per-server thread allocations
    growServerAlloc: number[][];
    weaken1ServerAlloc: number[][];
    weaken2ServerAlloc: number[][];
    concurrency: number;            // Number of staggered batch instances
    secondPerBatch: number;
    batchGap: number;               // ms between staggered batch instances
    hackPerBatch: number;
    growPerBatch: number;
    weaken1ThreadsRaw: number;
    weaken2ThreadsRaw: number;
    weaken1Time: number;
    weaken2Time: number;
    hackTime: number;
    growTime: number;
}

// ── BatchHackManager ──────────────────────────────────────────────────────────

/**
 * HWGW batch orchestrator — calculates optimal hack-thread counts, allocates
 * botnet RAM across batch instances, and fires the timed script executions.
 * Moved from engine/batch_hack_manager.ts; now uses flat constants from lib/config.
 *
 * TODO(design): Adopt inigo AttackController/TargetFinder pattern:
 *               - Per-target attack objects with self-managed state
 *               - targetFinder per-thread-efficiency ranking for EARLY phase
 * TODO(design): Adopt alainbryden getScheduleTiming / additionalMsec / optimizePerformanceMetrics
 *               for more precise operation-timing math and misfire mitigation.
 * TODO(design): recoveryThreadPadding — add a weaken buffer when security drifts above floor.
 * TODO(design): maxTargets auto-scale — reduce active targets when RAM is tight instead of killing.
 */
export class BatchHackManager {
    private ns: NS;
    private threadManager: ThreadDistributionManager;
    private activeBatches: Map<string, BatchCalculation> = new Map();
    private totalBatchesLaunched: number = 0;
    private formulas: FormulaHelper;
    private batchId: number = 0;

    constructor(ns: NS, threadManager: ThreadDistributionManager) {
        this.ns = ns;
        this.threadManager = threadManager;
        this.formulas = new FormulaHelper(ns);
    }

    resetBatchCount(): void {
        this.totalBatchesLaunched = 0;
    }

    getTotalBatchesLaunched(): number {
        return this.totalBatchesLaunched;
    }

    pruneActiveBatches(): void {
        this.activeBatches.clear();
    }

    /**
     * Calculate the HWGW strategy for `hackThreads` hack threads against `target`.
     * Returns null if there isn't enough botnet RAM to run even one batch instance.
     */
    async calculateBatchStrategy(
        target: string,
        hackThreads: number,
        availableAllocs: number[],
    ): Promise<BatchCalculation | null> {
        const serverOptimal = this.formulas.getOptimalServer(target);
        const player = this.ns.getPlayer();

        const weaken1Time = this.formulas.getWeakenTime(serverOptimal, player);
        const weaken2Time = weaken1Time;
        const hackTime = this.formulas.getHackTime(serverOptimal, player);
        const growTime = this.formulas.getGrowTime(serverOptimal, player);

        const batchGap = BATCH_STEP_TIME * 4;

        const maxBatches = BATCH_MAX_CONCURRENCY > 0
            ? Math.min(BATCH_MAX_CONCURRENCY, Math.floor(hackTime / batchGap + 1))
            : Math.floor(hackTime / batchGap + 1);

        const hackPercent = this.formulas.getHackPercent(serverOptimal, player);
        const moneyMax = serverOptimal.moneyMax || 1;
        const moneyAvailable = serverOptimal.moneyAvailable || moneyMax;
        const dollarPerHack = Math.min(moneyMax, moneyAvailable * hackPercent * hackThreads);

        // Build server state after hack to calculate grow threads
        const serverBeforeGrow = this.formulas.getOptimalServer(target);
        const serverMoneyMax = serverBeforeGrow.moneyMax || 1;
        serverBeforeGrow.moneyAvailable = Math.max(1, serverMoneyMax - dollarPerHack);

        const growThreadsRaw = this.formulas.getGrowThreads(serverBeforeGrow, player, hackThreads);

        const weaken1ThreadsRaw = hackThreads * HACK_SECURITY_INCREASE / WEAKEN_SECURITY_DECREASE;
        const weaken2ThreadsRaw = growThreadsRaw * GROW_SECURITY_INCREASE / WEAKEN_SECURITY_DECREASE;

        const hackServerAlloc: number[][] = [];
        const growServerAlloc: number[][] = [];
        const weaken1ServerAlloc: number[][] = [];
        const weaken2ServerAlloc: number[][] = [];

        const allocator = new Allocator(availableAllocs);
        let batchCount = 0;

        while (batchCount < maxBatches) {
            const hackAllocRes = allocator.alloc(Math.ceil(hackThreads), false);
            if (!hackAllocRes.success) break;
            hackServerAlloc.push(hackAllocRes.allocation);

            const growAllocRes = allocator.alloc(Math.ceil(growThreadsRaw), false);
            if (!growAllocRes.success) {
                allocator.free(hackServerAlloc.pop()!);
                break;
            }
            growServerAlloc.push(growAllocRes.allocation);

            const weaken1AllocRes = allocator.alloc(Math.ceil(weaken1ThreadsRaw), true);
            if (!weaken1AllocRes.success) {
                allocator.free(hackServerAlloc.pop()!);
                allocator.free(growServerAlloc.pop()!);
                break;
            }
            weaken1ServerAlloc.push(weaken1AllocRes.allocation);

            const weaken2AllocRes = allocator.alloc(Math.ceil(weaken2ThreadsRaw), true);
            if (!weaken2AllocRes.success) {
                allocator.free(hackServerAlloc.pop()!);
                allocator.free(growServerAlloc.pop()!);
                allocator.free(weaken1ServerAlloc.pop()!);
                break;
            }
            weaken2ServerAlloc.push(weaken2AllocRes.allocation);

            batchCount++;
        }

        if (batchCount === 0) return null;

        const secondPerBatch = (weaken1Time + batchCount * batchGap) / 1000;
        const dps = dollarPerHack * (1 / secondPerBatch) * batchCount;
        const tpb = Math.ceil(hackThreads) +
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
            growTime,
        };
    }

    /**
     * Search over hack-thread counts [1..maxHackPerBatch] and return the strategy
     * that maximises dollars-per-second for the given available RAM.
     */
    async findBestHackThreads(
        target: string,
        availableAllocs: number[],
    ): Promise<BatchCalculation | null> {
        const maxHackThreads = BATCH_MAX_HACK_PER_BATCH > 0 ? BATCH_MAX_HACK_PER_BATCH : 100;

        let bestDps = 0;
        let bestCalc: BatchCalculation | null = null;
        for (let hpb = 1; hpb <= maxHackThreads; hpb++) {
            const calc = await this.calculateBatchStrategy(target, hpb, availableAllocs.slice());
            if (calc && calc.dps > bestDps) {
                bestDps = calc.dps;
                bestCalc = calc;
            }
        }
        return bestCalc;
    }

    /**
     * For each top target (up to maxTargets), find the best batch plan and execute it.
     * Respects the home RAM reservation; kills cheapest targets first if violated.
     * @returns Number of new targets that started batching this call.
     */
    async scheduleBatches(
        targetManager: TargetSelector,
        ramManager: RamManager,
        maxTargets: number = 1,
    ): Promise<number> {
        if (ramManager.isHomeReservationViolated()) {
            this.ns.print('HOME RAM RESERVATION VIOLATED — reducing batch load');
            const terminated = this.reduceActiveBatchLoad(ramManager);
            if (terminated > 0) {
                this.ns.print(`Terminated ${terminated} batch(es) to free RAM`);
                return 0;
            }
        }

        const targets = targetManager.getBestTargets(maxTargets, true);
        if (targets.length === 0) return 0;

        const availableAllocs = ramManager.getAllocMap();
        let newBatchesLaunched = 0;

        for (const target of targets) {
            if (this.activeBatches.has(target)) continue;
            if (!targetManager.hasMaxHackChance(target)) continue;

            const bestCalc = await this.findBestHackThreads(target, availableAllocs.slice());
            if (bestCalc) {
                this.activeBatches.set(target, bestCalc);
                this.reserveRamForBatch(ramManager, bestCalc);
                this.executeTargetBatches(target, bestCalc, ramManager);
                newBatchesLaunched++;
                this.totalBatchesLaunched += bestCalc.concurrency;
                this.ns.print(`Started batching ${target} with ${bestCalc.concurrency} batches, ${formatMoney(bestCalc.dps)}/sec`);
            }
        }
        return newBatchesLaunched;
    }

    private reserveRamForBatch(ramManager: RamManager, calc: BatchCalculation): void {
        const serverList = ramManager.getAvailableServers();
        for (let serverIndex = 0; serverIndex < serverList.length; serverIndex++) {
            const server = serverList[serverIndex];
            let totalThreads = 0;

            for (let b = 0; b < calc.concurrency; b++) {
                if (calc.hackServerAlloc[b]?.[serverIndex]) totalThreads += calc.hackServerAlloc[b][serverIndex];
                if (calc.growServerAlloc[b]?.[serverIndex]) totalThreads += calc.growServerAlloc[b][serverIndex];
                if (calc.weaken1ServerAlloc[b]?.[serverIndex]) totalThreads += calc.weaken1ServerAlloc[b][serverIndex];
                if (calc.weaken2ServerAlloc[b]?.[serverIndex]) totalThreads += calc.weaken2ServerAlloc[b][serverIndex];
            }

            if (totalThreads > 0) {
                ramManager.reserveRam(totalThreads * SCRIPT_RAM_COST, server);
            }
        }
    }

    private executeTargetBatches(target: string, calc: BatchCalculation, ramManager: RamManager): void {
        const serverList = ramManager.getAvailableServers();
        if (serverList.length === 0) return;

        const now = Date.now();
        const batchFinishTime = now + calc.weaken1Time;

        for (let i = 0; i < calc.concurrency; i++) {
            const batchOffset = i * calc.batchGap;
            const hackFinish = batchFinishTime + batchOffset;
            const weaken1Finish = hackFinish + BATCH_STEP_TIME;
            const growFinish = weaken1Finish + BATCH_STEP_TIME;
            const weaken2Finish = growFinish + BATCH_STEP_TIME;

            const hackStart = hackFinish - calc.hackTime;
            const weaken1Start = weaken1Finish - calc.weaken1Time;
            const growStart = growFinish - calc.growTime;
            const weaken2Start = weaken2Finish - calc.weaken2Time;

            const bid = this.generateBatchId();

            if (calc.hackServerAlloc[i]?.some(t => t > 0)) {
                this.executeOperation(SCRIPT_PATHS.hack, calc.hackServerAlloc[i], serverList, target, calc.hackPerBatch, hackStart, hackFinish, `batch-hack-${bid}`);
            }
            if (calc.weaken1ServerAlloc[i]?.some(t => t > 0)) {
                this.executeOperation(SCRIPT_PATHS.weaken1, calc.weaken1ServerAlloc[i], serverList, target, Math.ceil(calc.weaken1ThreadsRaw), weaken1Start, weaken1Finish, `batch-weaken1-${bid}`);
            }
            if (calc.growServerAlloc[i]?.some(t => t > 0)) {
                this.executeOperation(SCRIPT_PATHS.grow, calc.growServerAlloc[i], serverList, target, calc.growPerBatch, growStart, growFinish, `batch-grow-${bid}`);
            }
            if (calc.weaken2ServerAlloc[i]?.some(t => t > 0)) {
                this.executeOperation(SCRIPT_PATHS.weaken2, calc.weaken2ServerAlloc[i], serverList, target, Math.ceil(calc.weaken2ThreadsRaw), weaken2Start, weaken2Finish, `batch-weaken2-${bid}`);
            }
        }
    }

    private executeOperation(
        script: string,
        allocation: number[],
        serverList: string[],
        target: string,
        threads: number,
        startTime: number,
        endTime: number,
        description: string,
    ): void {
        for (let i = 0; i < allocation.length; i++) {
            if (allocation[i] <= 0) continue;
            const server = serverList[i];
            if (!this.ns.serverExists(server)) continue;
            execMulti(this.ns, server, allocation[i], script, target, startTime, endTime - startTime, description, false, true);
        }
    }

    private generateBatchId(): number {
        return this.batchId++;
    }

    /** Print a compact batch-status panel. */
    printStatus(ramManager: RamManager, batchesLaunched: number): void {
        const totalRam = ramManager.getTotalMaxRam();
        const freeRam = ramManager.getTotalFreeRam();
        const reservedHomeRam = ramManager.getHomeReservedRam();
        const utilizationPercent = totalRam > 0 ? (totalRam - freeRam) / totalRam * 100 : 0;

        this.ns.print([
            '┌─── BATCH HACK STATUS ───┐',
            `│ Total Batches: ${this.totalBatchesLaunched.toString().padEnd(8)} │`,
            `│ New Batches:   ${batchesLaunched.toString().padEnd(8)} │`,
            `│ Free RAM:      ${fmtRam(freeRam).padEnd(8)} │`,
            `│ Reserved RAM:  ${fmtRam(reservedHomeRam).padEnd(8)} │`,
            `│ Utilization:   ${utilizationPercent.toFixed(1).padStart(7)}% │`,
            '└───────────────────────┘',
        ].join('\n'));
    }

    private reduceActiveBatchLoad(ramManager: RamManager): number {
        if (this.activeBatches.size === 0) return 0;

        const targets = Array.from(this.activeBatches.entries())
            .sort((a, b) => a[1].dps - b[1].dps) // kill least profitable first
            .map(entry => entry[0]);

        let terminatedCount = 0;
        for (const target of targets) {
            if (!ramManager.isHomeReservationViolated()) break;

            const batchCalc = this.activeBatches.get(target);
            if (!batchCalc) continue;

            this.activeBatches.delete(target);
            terminatedCount++;
            this.terminateTargetProcesses(target);
            ramManager.updateRamInfo();
            this.ns.print(`Terminated batching for ${target} (${formatMoney(batchCalc.dps)}/sec) to free RAM`);
        }
        return terminatedCount;
    }

    private terminateTargetProcesses(target: string): void {
        const serverList = [...this.ns.cloud.getServerNames(), 'home'];
        const scripts = [SCRIPT_PATHS.hack, SCRIPT_PATHS.grow, SCRIPT_PATHS.weaken1, SCRIPT_PATHS.weaken2];

        for (const server of serverList) {
            if (!this.ns.serverExists(server)) continue;
            for (const proc of this.ns.ps(server)) {
                if (!scripts.includes(proc.filename as typeof scripts[number])) continue;
                if (proc.args[0] === target) this.ns.kill(proc.pid);
            }
        }
    }
}
