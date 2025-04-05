import { NS } from '@ns';
import { IRamManager } from './auto_grow';
import { distributeThreads } from '../utils';

/**
 * Configuration for the ThreadDistributionManager
 */
export interface ThreadDistributionConfig {
    /** Default spacing between operations in milliseconds */
    operationDelay: number;
    /** Whether to avoid printing toast messages for misfires */
    silentMisfires: boolean;
    /** Enable debug logging */
    debug: boolean;
}

/**
 * Script information
 */
export interface ScriptInfo {
    /** Script path */
    path: string;
    /** RAM usage per thread */
    ram: number;
}

/**
 * Available scripts for hacking operations
 */
export interface HackingScripts {
    /** Hack script */
    hack: ScriptInfo;
    /** Grow script */
    grow: ScriptInfo;
    /** Weaken script */
    weaken: ScriptInfo;
    /** Share script */
    share: ScriptInfo;
}

/**
 * Scheduled operation details
 */
export interface ScheduledOperation {
    /** Unique ID for the operation */
    id: string;
    /** Script to run */
    script: string;
    /** Description for the operation */
    description: string;
    /** Target server */
    target: string;
    /** Number of threads */
    threads: number;
    /** Start time (timestamp) */
    startTime: number;
    /** End time (timestamp, 0 for dynamic end) */
    endTime: number;
    /** Additional args for the script */
    additionalArgs?: any[];
    /** Whether the operation manipulates stock */
    manipulateStock?: boolean;
    /** Whether to run in silent mode */
    silent?: boolean;
    /** Whether operation is part of a batch */
    batchId?: string;
}

/**
 * Result of an operation execution
 */
export interface OperationResult {
    /** Whether the operation was executed successfully */
    success: boolean;
    /** Process IDs of the executed scripts */
    pids: number[];
    /** RAM used for the operation */
    ramUsed: number;
    /** Operation details */
    operation: ScheduledOperation;
}

/**
 * Manages thread distribution across multiple servers in a tick-based manner
 * 
 * This class is responsible for:
 * - Scheduling hack/grow/weaken operations
 * - Distributing threads across available servers
 * - Managing execution timing
 * - Tracking operations execution
 */
export class ThreadDistributionManager {
    private ns: NS;
    private config: ThreadDistributionConfig;
    private scripts: HackingScripts;
    private scheduledOperations: Map<string, ScheduledOperation> = new Map();
    private activeOperations: Map<string, OperationResult> = new Map();
    private operationCounter: number = 0;

    /**
     * Creates a new instance of the ThreadDistributionManager
     * 
     * @param ns - NetScript API
     * @param config - Configuration options
     * @param scripts - Script paths and RAM usage
     */
    constructor(
        ns: NS,
        config: ThreadDistributionConfig,
        scripts: HackingScripts
    ) {
        this.ns = ns;
        this.config = {
            operationDelay: 50,
            silentMisfires: true,
            debug: false,
            ...config
        };
        this.scripts = scripts;
    }

    /**
     * Process a single tick, executing scheduled operations
     * 
     * @param ramManager - RAM manager to use for distribution
     * @returns Number of operations executed this tick
     */
    tick(ramManager: IRamManager): number {
        // Clear expired operations
        this.clearCompletedOperations();

        // Get operations ready to run
        const now = Date.now();
        const readyOperations = Array.from(this.scheduledOperations.values())
            .filter(op => op.startTime <= now)
            .sort((a, b) => a.startTime - b.startTime);

        let executedCount = 0;

        // Execute ready operations
        for (const operation of readyOperations) {
            // Skip if already running
            if (this.activeOperations.has(operation.id)) {
                this.scheduledOperations.delete(operation.id);
                continue;
            }

            // Execute the operation
            const result = this.executeOperation(operation, ramManager);

            if (result.success) {
                executedCount++;
                this.activeOperations.set(operation.id, result);
                this.scheduledOperations.delete(operation.id);

                if (this.config.debug) {
                    this.ns.print(`Executed operation ${operation.id}: ${operation.description} on ${operation.target} with ${operation.threads} threads`);
                }
            }
        }

        return executedCount;
    }

    /**
     * Schedule a hack operation
     * 
     * @param target - Target server
     * @param threads - Number of threads
     * @param startTime - Start time (timestamp)
     * @param endTime - End time (timestamp, 0 for dynamic)
     * @param description - Operation description
     * @param batchId - Optional batch ID
     * @returns Operation ID
     */
    scheduleHack(
        target: string,
        threads: number,
        startTime: number,
        endTime: number = 0,
        description: string = 'hack',
        batchId?: string
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
            batchId
        });
    }

    /**
     * Schedule a grow operation
     * 
     * @param target - Target server
     * @param threads - Number of threads
     * @param startTime - Start time (timestamp)
     * @param endTime - End time (timestamp, 0 for dynamic)
     * @param description - Operation description
     * @param batchId - Optional batch ID
     * @returns Operation ID
     */
    scheduleGrow(
        target: string,
        threads: number,
        startTime: number,
        endTime: number = 0,
        description: string = 'grow',
        batchId?: string
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
            batchId
        });
    }

    /**
     * Schedule a weaken operation
     * 
     * @param target - Target server
     * @param threads - Number of threads
     * @param startTime - Start time (timestamp)
     * @param endTime - End time (timestamp, 0 for dynamic)
     * @param description - Operation description
     * @param batchId - Optional batch ID
     * @returns Operation ID
     */
    scheduleWeaken(
        target: string,
        threads: number,
        startTime: number,
        endTime: number = 0,
        description: string = 'weaken',
        batchId?: string
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
            batchId
        });
    }

    /**
     * Schedule a share operation
     * 
     * @param threads - Number of threads
     * @param startTime - Start time (timestamp)
     * @param endTime - End time (timestamp, 0 for dynamic)
     * @param description - Operation description
     * @returns Operation ID
     */
    scheduleShare(
        threads: number,
        startTime: number,
        endTime: number = 0,
        description: string = 'share'
    ): string {
        return this.scheduleOperation({
            id: `share-${this.getNextId()}`,
            script: this.scripts.share.path,
            description,
            target: 'n/a',  // Share doesn't need a target
            threads,
            startTime,
            endTime,
            silent: true
        });
    }

    /**
     * Schedule a batch of operations (HWGW)
     * 
     * @param target - Target server
     * @param hackThreads - Hack threads
     * @param weakenForHackThreads - Weaken threads for hack security
     * @param growThreads - Grow threads
     * @param weakenForGrowThreads - Weaken threads for grow security
     * @param startTime - Batch start time
     * @param spacing - Time between operations (ms)
     * @returns Batch ID
     */
    scheduleBatch(
        target: string,
        hackThreads: number,
        weakenForHackThreads: number,
        growThreads: number,
        weakenForGrowThreads: number,
        startTime: number,
        spacing: number = this.config.operationDelay
    ): string {
        // Generate batch ID
        const batchId = `batch-${this.getNextId()}`;

        // Calculate operation times based on their execution duration
        const hackTime = this.ns.getHackTime(target);
        const growTime = this.ns.getGrowTime(target);
        const weakenTime = this.ns.getWeakenTime(target);

        // We schedule operations to finish in sequence with spacing between them
        // The sequence is: hack -> weaken1 -> grow -> weaken2

        // Calculate completion times
        const endTime = startTime + weakenTime + (spacing * 3);
        const weaken2End = endTime;
        const growEnd = weaken2End - spacing;
        const weaken1End = growEnd - spacing;
        const hackEnd = weaken1End - spacing;

        // Calculate start times based on completion times
        const hackStart = hackEnd - hackTime;
        const weaken1Start = weaken1End - weakenTime;
        const growStart = growEnd - growTime;
        const weaken2Start = weaken2End - weakenTime;

        // Schedule each operation
        if (hackThreads > 0) {
            this.scheduleHack(target, hackThreads, hackStart, hackEnd, 'batch-hack', batchId);
        }

        if (weakenForHackThreads > 0) {
            this.scheduleWeaken(target, weakenForHackThreads, weaken1Start, weaken1End, 'batch-weaken1', batchId);
        }

        if (growThreads > 0) {
            this.scheduleGrow(target, growThreads, growStart, growEnd, 'batch-grow', batchId);
        }

        if (weakenForGrowThreads > 0) {
            this.scheduleWeaken(target, weakenForGrowThreads, weaken2Start, weaken2End, 'batch-weaken2', batchId);
        }

        return batchId;
    }

    /**
     * Generic method to schedule any operation
     * 
     * @param operation - Operation details
     * @returns Operation ID
     */
    scheduleOperation(operation: ScheduledOperation): string {
        // Store the operation
        this.scheduledOperations.set(operation.id, operation);
        return operation.id;
    }

    /**
     * Execute a single operation
     * 
     * @param operation - Operation to execute
     * @param ramManager - RAM manager to use
     * @returns Result of the operation
     */
    private executeOperation(operation: ScheduledOperation, ramManager: IRamManager): OperationResult {
        // Skip if invalid threads
        if (operation.threads <= 0) {
            return {
                success: true,  // Consider it a success to avoid retries
                pids: [],
                ramUsed: 0,
                operation
            };
        }

        // Get RAM per thread for this script
        let ramPerThread: number;
        switch (operation.script) {
            case this.scripts.hack.path:
                ramPerThread = this.scripts.hack.ram;
                break;
            case this.scripts.grow.path:
                ramPerThread = this.scripts.grow.ram;
                break;
            case this.scripts.weaken.path:
                ramPerThread = this.scripts.weaken.ram;
                break;
            case this.scripts.share.path:
                ramPerThread = this.scripts.share.ram;
                break;
            default:
                ramPerThread = this.ns.getScriptRam(operation.script);
        }

        // Check if we have enough RAM
        const totalRamNeeded = operation.threads * ramPerThread;
        if (ramManager.getTotalFreeRam() < totalRamNeeded) {
            if (this.config.debug) {
                this.ns.print(`Not enough RAM for operation ${operation.id}: ${operation.description} (needed ${totalRamNeeded}GB, available ${ramManager.getTotalFreeRam()}GB)`);
            }
            return {
                success: false,
                pids: [],
                ramUsed: 0,
                operation
            };
        }

        // Get servers sorted by free RAM
        const servers = ramManager.getServersByFreeRam().map(server => ({
            host: server,
            freeRam: ramManager.getFreeRam(server)
        }));

        // Prepare arguments for the script
        const args = [
            operation.target,
            operation.startTime,
            operation.endTime,
            operation.description,
            operation.manipulateStock || false,
            operation.silent || this.config.silentMisfires,
            ...(operation.additionalArgs || [])
        ];

        // Distribute threads across servers
        const success = distributeThreads(
            this.ns,
            operation.script,
            operation.threads,
            servers,
            ...args
        );

        // If distribution was successful, update RAM manager
        if (success) {
            const pids: number[] = [];
            let ramUsed = 0;

            // The distributeThreads function already used the RAM from the servers array
            // Calculate how much RAM was used on each server
            for (const server of servers) {
                const originalFreeRam = ramManager.getFreeRam(server.host);
                const ramUsedOnServer = originalFreeRam - server.freeRam;

                if (ramUsedOnServer > 0) {
                    ramManager.reserveRam(ramUsedOnServer, server.host);
                    ramUsed += ramUsedOnServer;
                }
            }

            return {
                success: true,
                pids,
                ramUsed,
                operation
            };
        }

        return {
            success: false,
            pids: [],
            ramUsed: 0,
            operation
        };
    }

    /**
     * Clean up completed operations
     */
    private clearCompletedOperations(): void {
        const now = Date.now();

        // Remove operations that have completed
        for (const [id, result] of this.activeOperations.entries()) {
            const operation = result.operation;

            // If the operation has an end time, check if it's completed
            if (operation.endTime > 0 && now > operation.endTime) {
                this.activeOperations.delete(id);

                if (this.config.debug) {
                    this.ns.print(`Operation ${id} completed: ${operation.description}`);
                }
            }
        }
    }

    /**
     * Get next unique ID
     */
    private getNextId(): number {
        return this.operationCounter++;
    }

    /**
     * Get all scheduled operations
     */
    getScheduledOperations(): ScheduledOperation[] {
        return Array.from(this.scheduledOperations.values());
    }

    /**
     * Get all active operations
     */
    getActiveOperations(): OperationResult[] {
        return Array.from(this.activeOperations.values());
    }

    /**
     * Get operations for a specific batch
     * 
     * @param batchId - Batch ID
     * @returns Operations in the batch
     */
    getBatchOperations(batchId: string): ScheduledOperation[] {
        return Array.from(this.scheduledOperations.values())
            .filter(op => op.batchId === batchId);
    }

    /**
     * Check if all operations for a batch have been executed
     * 
     * @param batchId - Batch ID
     * @returns Whether all operations in the batch have been executed
     */
    isBatchExecuted(batchId: string): boolean {
        // Check if any scheduled operations remain for this batch
        const scheduledOps = this.getBatchOperations(batchId);
        return scheduledOps.length === 0;
    }

    /**
     * Cancel all operations for a batch
     * 
     * @param batchId - Batch ID
     * @returns Number of operations canceled
     */
    cancelBatch(batchId: string): number {
        const operations = this.getBatchOperations(batchId);

        for (const op of operations) {
            this.scheduledOperations.delete(op.id);
        }

        return operations.length;
    }

    /**
     * Cancel a specific operation
     * 
     * @param operationId - Operation ID
     * @returns Whether the operation was canceled
     */
    cancelOperation(operationId: string): boolean {
        return this.scheduledOperations.delete(operationId);
    }

    /**
     * Print status of thread distribution
     */
    printStatus(): void {
        const scheduled = this.getScheduledOperations();
        const active = this.getActiveOperations();

        this.ns.tprint('===== THREAD DISTRIBUTION STATUS =====');
        this.ns.tprint(`Scheduled operations: ${scheduled.length}`);
        this.ns.tprint(`Active operations: ${active.length}`);

        // Group operations by type
        const hackOps = scheduled.filter(op => op.script === this.scripts.hack.path);
        const growOps = scheduled.filter(op => op.script === this.scripts.grow.path);
        const weakenOps = scheduled.filter(op => op.script === this.scripts.weaken.path);
        const shareOps = scheduled.filter(op => op.script === this.scripts.share.path);

        this.ns.tprint(`Scheduled hacks: ${hackOps.length}`);
        this.ns.tprint(`Scheduled grows: ${growOps.length}`);
        this.ns.tprint(`Scheduled weakens: ${weakenOps.length}`);
        this.ns.tprint(`Scheduled shares: ${shareOps.length}`);

        // Count batch operations
        const batchOps = scheduled.filter(op => op.batchId !== undefined);
        const uniqueBatches = new Set(batchOps.map(op => op.batchId));

        this.ns.tprint(`Batch operations: ${batchOps.length} in ${uniqueBatches.size} batches`);
    }
}
