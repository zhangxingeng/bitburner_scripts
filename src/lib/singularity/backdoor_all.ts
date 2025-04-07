import { NS } from '@ns';
import { findAllPaths, traverse } from '../utils';

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

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();

    const boughtServers = new Set(ns.getPurchasedServers());
    try {
        const serverPaths = findAllPaths(ns);
        const totalServers = serverPaths.size;
        let backdooredCount = 0;
        for (const [target, serverPath] of serverPaths) {
            try {
                // Skip home server
                if (target === 'home' || boughtServers.has(target)) continue;
                const server = ns.getServer(target);
                const playerLevel = ns.getHackingLevel();
                const requiredSkill = server.requiredHackingSkill || 0;
                const skipCond = requiredSkill > playerLevel || !server.hasAdminRights || server.backdoorInstalled;
                if (skipCond) { continue; }
                // traverse and backdoor then come back home
                traverse(ns, serverPath);
                if (target === 'w0r1d_d43m0n') {
                    ns.tprint('WARNING: Ready to hack w0r1d_d43m0n!');
                    const proceed = await ns.prompt('Are you sure you want to proceed with backdooring w0r1d_d43m0n?');
                    if (!proceed) { ns.singularity.connect('home'); continue; }
                }
                await ns.singularity.installBackdoor();
                const backdoorInstalled = ns.getServer(target).backdoorInstalled;
                ns.print(`Backdoor ${target}: ${backdoorInstalled}`);
                backdooredCount += backdoorInstalled ? 1 : 0;
                if (STORY_SERVERS.has(target)) {
                    ns.tprint(`SUCCESS: Installed backdoor on story server: ${target}`);
                } else if (CORP_SERVERS.has(target)) {
                    ns.tprint(`SUCCESS: Installed backdoor on corporate server: ${target}`);
                }
                ns.singularity.connect('home');
            } catch (error) {
                ns.print(`ERROR on ${target}: ${String(error)}`);
                ns.singularity.connect('home');
            }
        }

        // Final status report
        const message = 'Backdoor installation complete!\n' +
            `Total servers processed: ${totalServers}\n` +
            `Successfully backdoored: ${backdooredCount}`;
        ns.tprint(message);

    } catch (error) {
        ns.tprint(`FATAL ERROR: ${String(error)}`);
        // Final attempt to return home
        ns.singularity.connect('home');
    }
}


