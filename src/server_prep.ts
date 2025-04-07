import { NS } from '@ns';
import { AutoGrowManager } from './hack_lib/auto_grow';
import { RamManager } from './hack_lib/ram_manager';
import { HackingConfig } from './hack_lib/hack_config';

/**
 * Script to prepare servers for hacking
 * This is a simple wrapper around the AutoGrowManager class
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    // Parse flags
    const flags = ns.flags([
        ['debug', false],
        ['status', false],
        ['help', false]
    ]);

    // Show help
    if (flags.help) {
        ns.tprint('Usage: run server_prep.ts [options]');
        ns.tprint('Options:');
        ns.tprint('  --debug      Enable debug logging');
        ns.tprint('  --status     Show current server preparation status and exit');
        ns.tprint('  --help       Show this help message');
        return;
    }

    // Create configuration
    const config = new HackingConfig(ns);
    if (flags.debug) {
        config.executionConfig.debug = true;
    }

    // Create the manager and RAM tracker
    const manager = new AutoGrowManager(ns, config);
    const ramManager = new RamManager(ns, config);

    // Refresh RAM information
    ramManager.updateRamInfo();

    // Just show status if --status flag is provided
    if (flags.status) {
        ns.tprint('Prepared servers: ' + manager.getPreparedServers().join(', '));
        return;
    }

    ns.tprint('Starting server preparation daemon...');

    // Get all potential targets
    const allServers = Array.from(new Set(ns.scan()));
    const targetServers = allServers.filter(server =>
        server !== 'home' &&
        !ns.getPurchasedServers().includes(server) &&
        ns.hasRootAccess(server) &&
        ns.getServerMaxMoney(server) > 0
    );

    // Main loop
    while (true) {
        try {
            // Update RAM availability
            ramManager.updateRamInfo();

            // Prepare servers
            await manager.prepareServers(targetServers, ramManager);

            // Optional status updates
            if (flags.debug) {
                ns.tprint('Prepared servers: ' + manager.getPreparedServers().join(', '));
            }

            // Wait before next cycle
            await ns.sleep(10000);
        } catch (error) {
            ns.tprint(`ERROR: ${error}`);
            await ns.sleep(5000);
        }
    }
} 