import { NS } from '@ns';
import { findAllPaths, traverse, gainRootAccess } from './lib/utils';

// Important servers that should be backdoored for story progression
const STORY_SERVERS = new Set([
    'CSEC',           // Required for CyberSec faction
    'I.I.I.I',       // Required for BitRunners faction
    'avmnite-02h',   // Required for NiteSec faction
    'run4theh111z',  // Required for The Black Hand faction
    'w0r1d_d43m0n'   // End-game server
]);

// Corporate servers that should be backdoored for faction access
const CORP_SERVERS = new Set([
    'clarkinc',
    'nwo',
    'omnitek',
    'fulcrumtech',
    'fulcrumassets'
]);

/**
 * Collect all servers that are eligible for backdooring
 * Prioritizes story servers, then corporate servers, then other servers
 */
function collectEligibleServers(ns: NS): string[] {
    const boughtServers = new Set(ns.getPurchasedServers());
    const serverPaths = findAllPaths(ns);
    const storyServers: string[] = [];
    const corpServers: string[] = [];
    const otherServers: string[] = [];

    for (const [target, _] of serverPaths) {
        // Skip home server and purchased servers
        if (target === 'home' || boughtServers.has(target)) continue;

        // Skip already backdoored
        const server = ns.getServer(target);
        if (server.backdoorInstalled) continue;

        // Categorize servers by priority
        if (STORY_SERVERS.has(target)) {
            storyServers.push(target);
        } else if (CORP_SERVERS.has(target)) {
            corpServers.push(target);
        } else {
            otherServers.push(target);
        }
    }

    // Return concatenated list with priority order
    return [...storyServers, ...corpServers, ...otherServers];
}

/**
 * Filter servers by whether they can be hacked (root access and sufficient hacking level)
 */
function filterCanHackServers(ns: NS, servers: string[]): string[] {
    const playerLevel = ns.getHackingLevel();
    return servers.filter(target => {
        const server = ns.getServer(target);
        const requiredSkill = server.requiredHackingSkill || 0;

        // Need admin rights and sufficient hacking skill
        return server.hasAdminRights && requiredSkill <= playerLevel;
    });
}

/**
 * Install backdoor on a target server
 */
async function installBackdoor(ns: NS, target: string, serverPaths: Map<string, string[]>): Promise<boolean> {
    try {
        const serverPath = serverPaths.get(target);
        if (!serverPath) {
            ns.print(`ERROR: No path found to ${target}`);
            return false;
        }

        // traverse to target server
        traverse(ns, serverPath);

        // Special handling for w0r1d_d43m0n
        if (target === 'w0r1d_d43m0n') {
            ns.tprint('WARNING: Ready to hack w0r1d_d43m0n!');
            const proceed = await ns.prompt('Are you sure you want to proceed with backdooring w0r1d_d43m0n?');
            if (!proceed) {
                ns.singularity.connect('home');
                return false;
            }
        }

        // Install backdoor
        await ns.singularity.installBackdoor();
        const backdoorInstalled = ns.getServer(target).backdoorInstalled;
        ns.print(`Backdoor ${target}: ${backdoorInstalled}`);

        // Print success messages for important servers
        if (STORY_SERVERS.has(target)) {
            ns.tprint(`SUCCESS: Installed backdoor on story server: ${target}`);
        } else if (CORP_SERVERS.has(target)) {
            ns.tprint(`SUCCESS: Installed backdoor on corporate server: ${target}`);
        }

        // Return to home
        ns.singularity.connect('home');
        return backdoorInstalled ?? false;

    } catch (error) {
        ns.print(`ERROR on ${target}: ${String(error)}`);
        ns.singularity.connect('home');
        return false;
    }
}

/**
 * Main service function that runs continuously
 */
async function backdoorService(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    while (true) {
        try {
            // Get all server paths
            const serverPaths = findAllPaths(ns);

            // Step 1: Collect eligible servers
            const eligibleServers = collectEligibleServers(ns);
            ns.print(`Found ${eligibleServers.length} eligible servers for backdooring`);

            // Step 2: Root servers first
            for (const server of eligibleServers) {
                gainRootAccess(ns, server);
            }

            // Step 3: Filter servers that can be hacked now
            const canHackServers = filterCanHackServers(ns, eligibleServers);
            ns.print(`${canHackServers.length} servers can be backdoored now`);

            // Step 4: Install backdoors on all hackable servers
            let backdooredCount = 0;
            for (const target of canHackServers) {
                const success = await installBackdoor(ns, target, serverPaths);
                if (success) backdooredCount++;
            }

            // Report results
            if (backdooredCount > 0) {
                ns.tprint(`Backdoor service: Installed ${backdooredCount} new backdoors this cycle`);
            } else if (canHackServers.length > 0) {
                ns.print(`No new backdoors installed this cycle, despite ${canHackServers.length} eligible servers`);
            } else {
                ns.print('No servers eligible for backdooring at this time');
            }

            // Check if all servers are backdoored
            const remainingServers = collectEligibleServers(ns);
            if (remainingServers.length === 0) {
                ns.tprint('SUCCESS: All possible servers have been backdoored!');
                // Still continue the service to catch new servers that become available
            }

            // Sleep before next cycle
            await ns.sleep(60000); // 60 seconds
        } catch (error) {
            ns.tprint(`FATAL ERROR in backdoor service: ${String(error)}`);
            ns.singularity.connect('home');
            await ns.sleep(10000); // Shorter sleep after error
        }
    }
}

export async function main(ns: NS): Promise<void> {
    ns.ui.openTail();
    ns.print('Starting backdoor service...');
    await backdoorService(ns);
}


