import { NS } from '@ns';
import { execMulti } from './exec_multi';
import { HackingConfig } from './hack_config';
import { RamManager } from './ram_manager';

/**
 * Auto-grows servers to prepare them for hacking
 */
export class AutoGrowManager {
    private ns: NS;
    private config: HackingConfig;
    private preparedServers: Set<string> = new Set();

    /**
     * Create a new AutoGrowManager
     * @param ns NetScript API
     * @param config Hacking configuration
     */
    constructor(ns: NS, config: HackingConfig) {
        this.ns = ns;
        this.config = config;
    }

    /**
     * Check if a server is prepared for hacking
     * @param target Target server hostname
     * @returns Whether the server is prepared
     */
    isServerPrepared(target: string): boolean {
        if (!this.ns.serverExists(target)) return false;

        const autoGrowConfig = this.config.getAutoGrowConfig();

        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);
        const currentMoney = this.ns.getServerMoneyAvailable(target);
        const maxMoney = this.ns.getServerMaxMoney(target);

        const securityThreshold = autoGrowConfig.security.threshold;
        const moneyThreshold = autoGrowConfig.money.threshold;

        // Check if security and money are within thresholds
        const securityOk = securityLevel <= minSecurityLevel + securityThreshold;
        const moneyOk = currentMoney >= maxMoney * moneyThreshold;

        return securityOk && moneyOk;
    }

    /**
     * Prepare a list of target servers
     * @param targets List of target servers to prepare
     * @param ramManager RAM manager to use
     * @returns Promise that resolves when all servers are prepared or preparation fails
     */
    async prepareServers(targets: string[], ramManager: RamManager): Promise<void> {
        this.ns.print(`Preparing ${targets.length} servers for hacking...`);

        // Get the auto-grow script
        const autoGrowScript = this.config.scriptPaths.autoGrow;

        // Execute auto-grow on each target
        for (const target of targets) {
            // Skip if already prepared
            if (this.isServerPrepared(target)) {
                this.preparedServers.add(target);
                continue;
            }

            // Get servers in order of free RAM
            const availableServers = ramManager.getServersByFreeRam();

            // Try to use the server with the most RAM
            if (availableServers.length > 0) {
                const bestServer = availableServers[0];
                const scriptRam = this.ns.getScriptRam(autoGrowScript);
                const maxThreads = Math.floor(ramManager.getFreeRam(bestServer) / scriptRam);

                if (maxThreads > 0) {
                    this.ns.print(`Growing ${target} on ${bestServer} with ${maxThreads} threads`);
                    const pid = execMulti(this.ns, bestServer, maxThreads, autoGrowScript, target);

                    if (pid > 0) {
                        // Reserve the RAM in the manager
                        ramManager.reserveRam(maxThreads * scriptRam, bestServer);
                    }
                }
            }
        }

        // Wait for auto-grow scripts to finish
        await this.waitForPreparation(targets);
    }

    /**
     * Wait for servers to be prepared
     * @param targets List of target servers
     * @returns Promise that resolves when all servers are prepared
     */
    private async waitForPreparation(targets: string[]): Promise<void> {
        const autoGrowScript = this.config.scriptPaths.autoGrow;
        let iterations = 0;
        const maxIterations = 300; // Prevent infinite waiting

        while (iterations < maxIterations) {
            // Check if all auto-grow scripts have finished
            let allPrepared = true;
            let preparing = 0;

            for (const target of targets) {
                // Skip if already marked prepared
                if (this.preparedServers.has(target)) continue;

                // Check if prepared now
                if (this.isServerPrepared(target)) {
                    this.preparedServers.add(target);
                    this.ns.print(`Server ${target} prepared successfully`);
                    continue;
                }

                // Check if any auto-grow scripts are still running
                const allProcesses = this.ns.ps();
                const targetProcesses = allProcesses.filter(process =>
                    process.filename === autoGrowScript &&
                    process.args.includes(target)
                );

                // If auto-grow is still running, wait
                if (targetProcesses.length > 0) {
                    allPrepared = false;
                    preparing++;
                }
            }

            // Print status every 10 iterations
            if (iterations % 10 === 0) {
                this.printPreparationStatus(targets, preparing);
            }

            if (allPrepared) { return; }

            // Wait before checking again
            await this.ns.sleep(1000);
            iterations++;
        }

        this.ns.print('Preparation timed out');
    }

    /**
     * Print preparation status in a compact format
     * @param targets List of target servers
     * @param preparing Number of targets still being prepared
     */
    private printPreparationStatus(targets: string[], preparing: number): void {
        const totalTargets = targets.length;
        const prepared = this.preparedServers.size;
        const remaining = totalTargets - prepared;

        // Build compact stats panel
        const statsPanel = [
            '┌─── SERVER PREPARATION ───┐',
            `│ Total Servers:  ${totalTargets.toString().padEnd(5)} │`,
            `│ Prepared:       ${prepared.toString().padEnd(5)} │`,
            `│ In Progress:    ${preparing.toString().padEnd(5)} │`,
            `│ Remaining:      ${remaining.toString().padEnd(5)} │`,
            '└────────────────────────┘'
        ].join('\n');

        this.ns.print(statsPanel);
    }

    /**
     * Reset the prepared servers list
     */
    resetPreparedServers(): void {
        this.preparedServers.clear();
    }

    /**
     * Get all prepared servers
     */
    getPreparedServers(): string[] {
        return Array.from(this.preparedServers);
    }
}
