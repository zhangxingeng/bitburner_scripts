import { NS } from '@ns';
import { AutoGrowManager, RamManager, AutoGrowConfig } from './lib/auto_grow';

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
    const config: Partial<AutoGrowConfig> = {
        debug: flags.debug as boolean
    };

    // Create the manager and RAM tracker
    const manager = new AutoGrowManager(ns, config);
    const ramManager = new RamManager(ns);

    // Initialize
    await manager.init();

    // Just show status if --status flag is provided
    if (flags.status) {
        manager.printStatus();
        return;
    }

    ns.tprint('Starting server preparation daemon...');

    // Main loop
    while (true) {
        // Update RAM availability
        ramManager.updateRamInfo();

        // Process one tick
        await manager.tick(ramManager);

        // Optional status updates
        if (flags.debug && Math.random() < 0.05) {
            manager.printStatus();
        }

        // Wait before next tick
        await ns.sleep(1000);
    }
} 