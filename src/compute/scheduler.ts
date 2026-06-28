import { NS } from '@ns';
import { RamManager } from './ram_manager';
import { distributeThreads } from '../lib/script';

// ── Interfaces ────────────────────────────────────────────────────────────────

/** Configuration for the ThreadDistributionManager. */
export interface ThreadDistributionConfig {
    /** Default spacing between operations in milliseconds. */
    operationDelay: number;
    /** Suppress toast messages for misfired operations. */
    silentMisfires: boolean;
    /** Verbose operation logging. */
    debug: boolean;
}

/** RAM cost and script path for a single operation type. */
export interface ScriptInfo {
    path: string;
    ram: number;
}

/** Script info for all four HWGW operation types. */
export interface HackingScripts {
    hack: ScriptInfo;
    grow: ScriptInfo;
    weaken: ScriptInfo;
    share: ScriptInfo;
}

/** A pending operation waiting to be dispatched to a worker. */
export interface ScheduledOperation {
    id: string;
    script: string;
    description: string;
    target: string;
    threads: number;
    startTime: number;
    endTime: number;
    additionalArgs?: (string | number | boolean)[];
    manipulateStock?: boolean;
    silent?: boolean;
    batchId?: string;
}

/** Result of executing a single operation. */
export interface OperationResult {
    success: boolean;
    pids: number[];
    ramUsed: number;
    operation: ScheduledOperation;
}

// ── ThreadDistributionManager ─────────────────────────────────────────────────

/**
 * Tick-based operation scheduler — holds a queue of pending HWGW ops and dispatches
 * them to the botnet via RamManager once their start-time arrives.
 * Moved from engine/thread_manager.ts.
 *
 * TODO(design): Integrate with port-bus task-event protocol (PORT_BUS_TASK) to replace
 *               poll-based RAM accounting with START/DONE event accounting.
 * TODO(design): Adopt alainbryden arbitraryExecution bin-packing once scheduler is
 *               wired to the bus and we can afford the refactor risk.
 */
export class ThreadDistributionManager {
    private ns: NS;
    private config: ThreadDistributionConfig;
    private scripts: HackingScripts;
    private scheduledOperations: Map<string, ScheduledOperation> = new Map();
    private activeOperations: Map<string, OperationResult> = new Map();
    private operationCounter: number = 0;

    constructor(ns: NS, config: ThreadDistributionConfig, scripts: HackingScripts) {
        this.ns = ns;
        this.config = config;
        this.scripts = scripts;
    }

    /**
     * Execute all operations whose start-time has arrived.
     * @returns Number of operations dispatched this tick.
     */
    tick(ramManager: RamManager): number {
        this.clearCompletedOperations();

        const now = Date.now();
        const readyOperations = Array.from(this.scheduledOperations.values())
            .filter(op => op.startTime <= now)
            .sort((a, b) => a.startTime - b.startTime);

        let executedCount = 0;
        for (const operation of readyOperations) {
            if (this.activeOperations.has(operation.id)) {
                this.scheduledOperations.delete(operation.id);
                continue;
            }
            const result = this.executeOperation(operation, ramManager);
            if (result.success) {
                executedCount++;
                this.activeOperations.set(operation.id, result);
                this.scheduledOperations.delete(operation.id);
                if (this.config.debug) {
                    this.ns.print(`Executed ${operation.id}: ${operation.description} → ${operation.target} ×${operation.threads}`);
                }
            }
        }
        return executedCount;
    }

    /** Schedule a hack operation; returns the operation ID. */
    scheduleHack(
        target: string,
        threads: number,
        startTime: number,
        endTime: number = 0,
        description: string = 'hack',
        batchId?: string,
    ): string {
        return this.scheduleOperation({
            id: `hack-${this.getNextId()}`,
            script: this.scripts.hack.path,
            description,
            target,
            threads,
            startTime,
            endTime,
            silent: this.config.silentMisfires,
            batchId,
        });
    }

    /** Schedule a grow operation; returns the operation ID. */
    scheduleGrow(
        target: string,
        threads: number,
        startTime: number,
        endTime: number = 0,
        description: string = 'grow',
        batchId?: string,
    ): string {
        return this.scheduleOperation({
            id: `grow-${this.getNextId()}`,
            script: this.scripts.grow.path,
            description,
            target,
            threads,
            startTime,
            endTime,
            silent: this.config.silentMisfires,
            batchId,
        });
    }

    /** Schedule a weaken operation; returns the operation ID. */
    scheduleWeaken(
        target: string,
        threads: number,
        startTime: number,
        endTime: number = 0,
        description: string = 'weaken',
        batchId?: string,
    ): string {
        return this.scheduleOperation({
            id: `weaken-${this.getNextId()}`,
            script: this.scripts.weaken.path,
            description,
            target,
            threads,
            startTime,
            endTime,
            silent: this.config.silentMisfires,
            batchId,
        });
    }

    /** Schedule a share operation; returns the operation ID. */
    scheduleShare(
        threads: number,
        startTime: number,
        endTime: number = 0,
        description: string = 'share',
    ): string {
        return this.scheduleOperation({
            id: `share-${this.getNextId()}`,
            script: this.scripts.share.path,
            description,
            target: 'n/a',
            threads,
            startTime,
            endTime,
            silent: true,
        });
    }

    /**
     * Schedule a complete HWGW batch timed so operations complete in order:
     * hack → weaken1 → grow → weaken2 with `spacing` ms between completions.
     */
    scheduleBatch(
        target: string,
        hackThreads: number,
        weakenForHackThreads: number,
        growThreads: number,
        weakenForGrowThreads: number,
        startTime: number,
        spacing: number = this.config.operationDelay,
    ): string {
        const batchId = `batch-${this.getNextId()}`;

        const hackTime = this.ns.getHackTime(target);
        const growTime = this.ns.getGrowTime(target);
        const weakenTime = this.ns.getWeakenTime(target);

        // Completion sequence: hack → weaken1 → grow → weaken2
        const endTime = startTime + weakenTime + (spacing * 3);
        const weaken2End = endTime;
        const growEnd = weaken2End - spacing;
        const weaken1End = growEnd - spacing;
        const hackEnd = weaken1End - spacing;

        const hackStart = hackEnd - hackTime;
        const weaken1Start = weaken1End - weakenTime;
        const growStart = growEnd - growTime;
        const weaken2Start = weaken2End - weakenTime;

        if (hackThreads > 0) this.scheduleHack(target, hackThreads, hackStart, hackEnd, 'batch-hack', batchId);
        if (weakenForHackThreads > 0) this.scheduleWeaken(target, weakenForHackThreads, weaken1Start, weaken1End, 'batch-weaken1', batchId);
        if (growThreads > 0) this.scheduleGrow(target, growThreads, growStart, growEnd, 'batch-grow', batchId);
        if (weakenForGrowThreads > 0) this.scheduleWeaken(target, weakenForGrowThreads, weaken2Start, weaken2End, 'batch-weaken2', batchId);

        return batchId;
    }

    /** Add any operation to the pending queue; returns its ID. */
    scheduleOperation(operation: ScheduledOperation): string {
        this.scheduledOperations.set(operation.id, operation);
        return operation.id;
    }

    private executeOperation(operation: ScheduledOperation, ramManager: RamManager): OperationResult {
        if (operation.threads <= 0) {
            return { success: true, pids: [], ramUsed: 0, operation };
        }

        let ramPerThread: number;
        switch (operation.script) {
            case this.scripts.hack.path:   ramPerThread = this.scripts.hack.ram; break;
            case this.scripts.grow.path:   ramPerThread = this.scripts.grow.ram; break;
            case this.scripts.weaken.path: ramPerThread = this.scripts.weaken.ram; break;
            case this.scripts.share.path:  ramPerThread = this.scripts.share.ram; break;
            default:                       ramPerThread = this.ns.getScriptRam(operation.script);
        }

        const totalRamNeeded = operation.threads * ramPerThread;
        if (ramManager.getTotalFreeRam() < totalRamNeeded) {
            if (this.config.debug) {
                this.ns.print(`Not enough RAM for ${operation.id} (need ${totalRamNeeded}GB, have ${ramManager.getTotalFreeRam()}GB)`);
            }
            return { success: false, pids: [], ramUsed: 0, operation };
        }

        const servers = ramManager.getServersByFreeRam().map(server => ({
            host: server,
            freeRam: ramManager.getFreeRam(server),
        })).filter(s => s.freeRam > 0);

        if (servers.length === 0) {
            return { success: false, pids: [], ramUsed: 0, operation };
        }

        const args: (string | number | boolean)[] = [
            operation.target,
            operation.startTime,
            operation.endTime,
            operation.description,
            operation.manipulateStock || false,
            operation.silent || this.config.silentMisfires,
            ...(operation.additionalArgs || []),
        ];

        const success = distributeThreads(this.ns, operation.script, operation.threads, servers, ...args);

        if (success) {
            let ramUsed = 0;
            for (const server of servers) {
                const ramUsedOnServer = ramManager.getFreeRam(server.host) - server.freeRam;
                if (ramUsedOnServer > 0) {
                    ramManager.reserveRam(ramUsedOnServer, server.host);
                    ramUsed += ramUsedOnServer;
                }
            }
            return { success: true, pids: [], ramUsed, operation };
        }

        return { success: false, pids: [], ramUsed: 0, operation };
    }

    private clearCompletedOperations(): void {
        const now = Date.now();
        for (const [id, result] of this.activeOperations.entries()) {
            if (result.operation.endTime > 0 && now > result.operation.endTime) {
                this.activeOperations.delete(id);
            }
        }
    }

    private getNextId(): number {
        return this.operationCounter++;
    }

    getScheduledOperations(): ScheduledOperation[] {
        return Array.from(this.scheduledOperations.values());
    }

    getActiveOperations(): OperationResult[] {
        return Array.from(this.activeOperations.values());
    }

    getBatchOperations(batchId: string): ScheduledOperation[] {
        return Array.from(this.scheduledOperations.values()).filter(op => op.batchId === batchId);
    }

    isBatchExecuted(batchId: string): boolean {
        return this.getBatchOperations(batchId).length === 0;
    }

    cancelBatch(batchId: string): number {
        const ops = this.getBatchOperations(batchId);
        for (const op of ops) this.scheduledOperations.delete(op.id);
        return ops.length;
    }

    cancelOperation(operationId: string): boolean {
        return this.scheduledOperations.delete(operationId);
    }

    printStatus(): void {
        const scheduled = this.getScheduledOperations();
        const active = this.getActiveOperations();
        const hackOps = scheduled.filter(op => op.script === this.scripts.hack.path);
        const growOps = scheduled.filter(op => op.script === this.scripts.grow.path);
        const weakenOps = scheduled.filter(op => op.script === this.scripts.weaken.path);
        const shareOps = scheduled.filter(op => op.script === this.scripts.share.path);
        const batchOps = scheduled.filter(op => op.batchId !== undefined);
        const uniqueBatches = new Set(batchOps.map(op => op.batchId));

        this.ns.print([
            '┌─── THREAD DISTRIBUTION ───┐',
            `│ Scheduled Ops: ${scheduled.length.toString().padEnd(10)} │`,
            `│ Active Ops:    ${active.length.toString().padEnd(10)} │`,
            `│ Hack Ops:      ${hackOps.length.toString().padEnd(10)} │`,
            `│ Grow Ops:      ${growOps.length.toString().padEnd(10)} │`,
            `│ Weaken Ops:    ${weakenOps.length.toString().padEnd(10)} │`,
            `│ Share Ops:     ${shareOps.length.toString().padEnd(10)} │`,
            `│ Batch Ops:     ${batchOps.length}/${uniqueBatches.size.toString().padEnd(6)} │`,
            '└──────────────────────────┘',
        ].join('\n'));
    }
}
