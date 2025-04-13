import { NS } from '@ns';

/**
 * Start batch hacking with different configurations
 * 
 * @param ns - NetScript API
 */
export async function main(ns: NS): Promise<void> {
    const args = {
        mode: 'batch',
        homeRam: 100,
        targets: 4,
        help: false
    };

    // Make sure all required scripts exist
    // Kill any running instances
    if (ns.scriptRunning('/batch_hack.js', 'home')) {
        ns.scriptKill('/batch_hack.js', 'home');
        ns.tprint('Killed running batch hack instance');
    }

    // Check if we should generate remote scripts
    const remoteScripts = [
        'hack.js',
        'grow.js',
        'weaken.js',
        'auto_grow.js',
        'share.js'
    ];

    let anyMissing = false;
    for (const script of remoteScripts) {
        if (!ns.fileExists(`/remote/${script}`)) {
            anyMissing = true;
            break;
        }
    }

    if (anyMissing) {
        ns.tprint('Some remote scripts are missing. Run with --generate first');
        return;
    }

    // Start the appropriate script based on mode
    switch (args.mode) {
        case 'batch':
            // Start batch hacking
            ns.tprint(`Starting batch hacking with ${args.targets} targets and ${args.homeRam}GB home reservation`);
            ns.run('/batch_hack.js', 1, '--homeRam', args.homeRam, '--targets', args.targets);
            break;

        case 'single':
            // Start simple hacking
            ns.tprint(`Starting simple hacking with ${args.targets} targets and ${args.homeRam}GB home reservation`);
            ns.run('/cross_server_hack.js', 1, '--homeRam', args.homeRam, '--targets', args.targets);
            break;

        case 'share':
            // Start sharing
            ns.tprint('Starting share mode');
            ns.run('/share_farm.js', 1, '--homeRam', args.homeRam);
            break;

        default:
            ns.tprint(`Unknown mode: ${args.mode}`);
            ns.tprint('Run with --help for usage information');
    }
} 