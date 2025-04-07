import { NS } from '@ns';
import { HackingConfig } from './hack_lib/hack_config';
import { RamManager } from './hack_lib/ram_manager';
import { ServerTargetManager } from './hack_lib/server_target_manager';
import { AutoGrowManager } from './hack_lib/auto_grow';
import { BatchHackManager } from './hack_lib/batch_hack_manager';
import { ThreadDistributionManager } from './hack_lib/thread_distribution_manager';
import { scanAndNuke } from './lib/utils';

/**
 * High-income batch hacking script
 * Implements a coordinated batch attack strategy to maximize income
 */
export async function main(ns: NS): Promise<void> {
    // Disable logs and enable only print statements
    ns.disableLog('ALL');
    ns.enableLog('print');

    try {
        // Initialize configuration
        const config = new HackingConfig(ns);

        // Create RAM and target managers
        const ramManager = new RamManager(ns, config);
        const targetManager = new ServerTargetManager(ns);

        // Create auto-grow manager for preparing servers
        const growManager = new AutoGrowManager(ns, config);

        // Create thread distribution manager
        const threadManager = new ThreadDistributionManager(
            ns,
            {
                operationDelay: config.batchConfig.stepTime,
                silentMisfires: true,
                debug: false
            },
            {
                hack: { path: config.scriptPaths.hack, ram: config.scriptRamCost },
                grow: { path: config.scriptPaths.grow, ram: config.scriptRamCost },
                weaken: { path: config.scriptPaths.weaken, ram: config.scriptRamCost },
                share: { path: config.scriptPaths.share, ram: config.scriptRamCost }
            }
        );

        // Create batch hack manager for coordinating attacks
        const batchManager = new BatchHackManager(ns, config, threadManager);

        // Nuke all possible servers to maximize available resources
        const nukedServers = scanAndNuke(ns);
        ns.print(`Gained root access to ${nukedServers.size} servers`);

        // Update RAM information
        ramManager.updateRamInfo();

        // Update target information
        targetManager.refreshTargets();

        ns.print('Distributed Hack started');
        ns.print(`Available RAM: ${Math.floor(ramManager.getTotalFreeRam())}GB across ${ramManager.getAvailableServers().length} servers`);

        // Maximum targets to hack simultaneously
        const MAX_TARGETS = 4;

        // Main loop
        let tick = 0;

        while (true) {
            try {
                // Update resource information periodically
                if (tick % 10 === 0) {
                    ramManager.updateRamInfo();
                    targetManager.refreshTargets();
                }

                // Get targets that need preparation
                const unpreparedTargets = targetManager.getBestTargets(MAX_TARGETS, false)
                    .filter(target => !growManager.isServerPrepared(target));

                // Prepare servers
                if (unpreparedTargets.length > 0) {
                    await growManager.prepareServers(unpreparedTargets, ramManager);
                    ramManager.updateRamInfo(); // Update RAM after preparation
                }

                // Schedule batch operations
                const batchesStarted = await batchManager.scheduleBatches(
                    targetManager,
                    ramManager,
                    MAX_TARGETS
                );

                // Periodically print status and clean up
                if (tick % 30 === 0) {
                    // Reset and update batch tracking
                    batchManager.pruneActiveBatches();
                    ns.print(`Status: ${batchManager.getTotalBatchesLaunched()} batches scheduled, ${batchesStarted} new batches started`);
                    batchManager.resetBatchCount();

                    // Print prepared server status
                    const prepared = targetManager.getBestTargets(10, true);
                    if (prepared.length > 0) {
                        ns.print(`Prepared servers: ${prepared.join(', ')}`);
                    }
                }

                // Sleep before next tick
                await ns.sleep(config.executionConfig.baseSleepTime);
                tick++;

            } catch (innerError) {
                // Log errors but keep running
                ns.print(`ERROR in main loop: ${innerError}`);
                await ns.sleep(5000); // Longer sleep on error
            }
        }
    } catch (error) {
        // Log fatal errors
        ns.tprint(`FATAL ERROR in distributed_hack: ${error}`);
    }
}

