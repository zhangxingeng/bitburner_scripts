import { NS } from '@ns';
import { executeCommand } from '../lib/ns_dodge';
import { isSingleInstance, findAllPaths } from '../lib/net_scan';
import { traverse, checkOwnSF } from '../lib/connect';

// ── Program buying constants ──────────────────────────────────────────────────

const PORT_OPENER_NAMES: string[] = [
    'tor',
    'BruteSSH.exe',
    'FTPCrack.exe',
    'relaySMTP.exe',
    'HTTPWorm.exe',
    'SQLInject.exe',
    'Formulas.exe',
];

const PORT_OPENER_COSTS: number[] = [
    200_000,
    500_000,
    1_500_000,
    5_000_000,
    30_000_000,
    250_000_000,
    5_000_000_000,
];

// ── Backdoor constants ────────────────────────────────────────────────────────

// Story servers: required backdoor for faction/story progression
const STORY_SERVERS = new Set([
    'CSEC',           // CyberSec faction invite
    'I.I.I.I',       // BitRunners faction invite
    'avmnite-02h',   // NiteSec faction invite
    'run4theh111z',  // The Black Hand faction invite
    'w0r1d_d43m0n',  // End-game server — prompts before proceeding
]);

// Corporate servers: backdoor for megacorp faction access
const CORP_SERVERS = new Set([
    'clarkinc',
    'nwo',
    'omnitek',
    'fulcrumtech',
    'fulcrumassets',
]);

const BACKDOOR_CYCLE_INTERVAL_MS = 60_000; // 60 s between backdoor sweeps

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Program Acquirer — buy TOR router + darkweb port openers; install backdoors.
 *
 * Flags:
 *   --backdoor   Run the continuous backdoor service instead of program buying.
 *
 * Default (no flags): buy all programs once and exit.
 */
export async function main(ns: NS): Promise<void> {
    const flags = ns.flags([['backdoor', false]]) as unknown as { backdoor: boolean };

    if (flags.backdoor) {
        ns.ui.openTail();
        ns.ui.setTailTitle('Backdoor Service');
        await backdoorService(ns);
    } else {
        // One-shot program purchase; guard against duplicate instances
        if (!isSingleInstance(ns)) return;
        ns.ui.openTail();
        ns.ui.setTailTitle('Program Acquirer');
        await buyProgramsLoop(ns);
    }
}

// ── Program buying ────────────────────────────────────────────────────────────

/**
 * Buy all port openers and TOR router, polling until all are acquired.
 * Exits once all programs are owned.
 */
async function buyProgramsLoop(ns: NS): Promise<void> {
    let remaining = [...PORT_OPENER_NAMES];

    while (remaining.length > 0) {
        remaining = await buyPortOpeners(ns, remaining);

        if (remaining.length === 0) {
            ns.tprint('All programs purchased successfully!');
            break;
        }

        ns.print(`Still need to buy: ${remaining.join(', ')}`);
        await ns.sleep(10_000);
    }
}

/**
 * Attempt to purchase each item in openersToBuy.
 * Returns items that were NOT successfully purchased.
 */
export async function buyPortOpeners(ns: NS, openersToBuy: string[]): Promise<string[]> {
    const remaining: string[] = [];

    for (const opener of openersToBuy) {
        // Already have it
        if (opener === 'tor' && ns.hasTorRouter()) continue;
        if (opener !== 'tor' && ns.fileExists(opener, 'home')) continue;

        const index = PORT_OPENER_NAMES.indexOf(opener);
        const cost  = PORT_OPENER_COSTS[index];

        if (ns.getPlayer().money >= cost) {
            if (opener === 'tor') {
                await executeCommand<boolean>(ns, 'ns.singularity.purchaseTor()');
            } else {
                await executeCommand<boolean>(ns, `ns.singularity.purchaseProgram("${opener}")`);
            }

            // Re-check after purchase attempt
            const owned = opener === 'tor' ? ns.hasTorRouter() : ns.fileExists(opener, 'home');
            if (owned) {
                ns.print(`Purchased: ${opener}`);
                continue;
            }
        }

        remaining.push(opener);
    }

    return remaining;
}

// ── Backdoor service ──────────────────────────────────────────────────────────

/**
 * Continuous backdoor service: installs backdoors on all eligible servers.
 * Prioritises story servers → corporate servers → other servers.
 * NOTE: Run compute/spreader.js first to maximise rooted server coverage.
 */
async function backdoorService(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    if (!checkOwnSF(ns, 4)) {
        ns.tprint('ERROR: Backdoor service requires SF4 (ns.singularity.connect/installBackdoor) — exiting');
        return;
    }

    while (true) {
        try {
            const serverPaths     = await findAllPaths(ns);
            const eligibleServers = collectEligibleServers(ns, serverPaths);
            ns.print(`Found ${eligibleServers.length} servers eligible for backdooring`);

            const hackableNow = filterBackdoorReady(ns, eligibleServers);
            ns.print(`${hackableNow.length} servers ready to backdoor now`);

            let backdoored = 0;
            for (const target of hackableNow) {
                if (await runBackdoorInstall(ns, target, serverPaths)) backdoored++;
            }

            if (backdoored > 0) {
                ns.tprint(`Backdoor service: installed ${backdoored} new backdoor(s) this cycle`);
            }

            const remaining = collectEligibleServers(ns, await findAllPaths(ns));
            if (remaining.length === 0) {
                ns.tprint('SUCCESS: All possible servers have been backdoored!');
            }

            await ns.sleep(BACKDOOR_CYCLE_INTERVAL_MS);
        } catch (err) {
            ns.tprint(`ERROR in backdoor service: ${String(err)}`);
            ns.singularity.connect('home');
            await ns.sleep(10_000);
        }
    }
}

/** Collect servers that need a backdoor, in priority order. */
function collectEligibleServers(ns: NS, serverPaths: Map<string, string[]>): string[] {
    const boughtServers = new Set(ns.cloud.getServerNames());
    const story:  string[] = [];
    const corp:   string[] = [];
    const other:  string[] = [];

    for (const [target] of serverPaths) {
        if (target === 'home' || boughtServers.has(target)) continue;
        const sv = ns.getServer(target);
        if (sv.backdoorInstalled) continue;

        if (STORY_SERVERS.has(target))   story.push(target);
        else if (CORP_SERVERS.has(target)) corp.push(target);
        else                             other.push(target);
    }

    return [...story, ...corp, ...other];
}

/** Filter to servers we can backdoor right now (admin rights + hacking level). */
function filterBackdoorReady(ns: NS, servers: string[]): string[] {
    const playerLevel = ns.getHackingLevel();
    return servers.filter(t => {
        const sv = ns.getServer(t);
        return sv.hasAdminRights && (sv.requiredHackingSkill ?? 0) <= playerLevel;
    });
}

/** Connect to and install a backdoor on the target server, then return home.
 *  Named runBackdoorInstall, NOT installBackdoor — that name collides with
 *  ns.singularity.installBackdoor and the RAM analyzer charges its cost to
 *  any script defining a same-named local function (see lib/dom.ts header). */
async function runBackdoorInstall(ns: NS, target: string, serverPaths: Map<string, string[]>): Promise<boolean> {
    try {
        const path = serverPaths.get(target);
        if (!path) {
            ns.print(`ERROR: No path found to ${target}`);
            return false;
        }

        traverse(ns, path);

        // Prompt before touching the end-game server
        if (target === 'w0r1d_d43m0n') {
            ns.tprint('WARNING: Ready to backdoor w0r1d_d43m0n!');
            const proceed = await ns.prompt('Proceed with backdooring w0r1d_d43m0n?');
            if (!proceed) {
                ns.singularity.connect('home');
                return false;
            }
        }

        await ns.singularity.installBackdoor();
        const installed = ns.getServer(target).backdoorInstalled ?? false;
        ns.print(`Backdoor ${target}: ${installed}`);

        if (STORY_SERVERS.has(target)) {
            ns.tprint(`SUCCESS: Backdoored story server: ${target}`);
        } else if (CORP_SERVERS.has(target)) {
            ns.tprint(`SUCCESS: Backdoored corporate server: ${target}`);
        }

        ns.singularity.connect('home');
        return installed;
    } catch (err) {
        ns.print(`ERROR on ${target}: ${String(err)}`);
        ns.singularity.connect('home');
        return false;
    }
}
