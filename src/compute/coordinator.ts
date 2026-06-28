import type { NS } from '@ns';
import { formatMoney, formatRam } from '../lib/format';
import { getAvailableServers } from '../lib/servers';
import {
    SCRIPT_PATHS,
    SCRIPT_RAM_COST,
    MIN_SERVER_RAM,
    HOME_RAM_RESERVE_FRACTION,
    HOME_RAM_RESERVE_MAX,
    HOME_RAM_RESERVE_MIN,
    TARGET_MONEY_THRESHOLD,
    TARGET_SECURITY_THRESHOLD,
    MAX_TARGETS,
    BATCH_STEP_TIME,
    EXEC_DEBUG,
    EXEC_SILENT_MISFIRES,
    INTERVAL_NUKE_S,
    INTERVAL_PORT_OPENER_S,
    INTERVAL_SHARE_S,
} from '../lib/config';
import { RamManager } from './ram_manager';
import { TargetSelector, isServerPrepared, getTargetServers } from './target_selector';
import { BatchHackManager } from './hwgw_batcher';
import { ThreadDistributionManager } from './scheduler';
import { execMulti } from './exec_multi';

// ── Orchestrator-level paths for maintenance daemons ─────────────────────────
// Phase 2b: pservManager, hacknetManager, spreader moved from tools/ to compute/.
// Port openers remain in tools/ (Phase 5 owns that move).

const DAEMON_PATHS = {
    pservManager:   '/compute/pserv_manager.js',   // buy/upgrade pservs + home RAM
    hacknetManager: '/compute/hacknet_manager.js',  // ROI-based hacknet upgrades
    spreader:       '/compute/spreader.js',         // BFS root + propagate
    buyPortOpener:  '/tools/port_openers.js',       // Phase 5 — not yet moved
    gameAgent:      '/monitor/game_agent.js',       // MCP file-based command relay
    bootAgent:      '/monitor/boot_agent.js',       // Port-based IPC relay
} as const;

const FEATURES = {
    enableShare:               true,
    enableAutoServerPurchase:  true,
} as const;

// ── Status panel helpers (dissolved from engine/batch_util.ts) ────────────────

/** Build a fixed-width box panel with a title and content rows. */
function createStatusPanel(title: string, rows: string[]): string {
    const width = Math.max(title.length + 6, ...rows.map(row => row.length + 2));
    const titleLine = `│ ${title.padEnd(width - 4)} │`;
    const divider   = `├${'─'.repeat(width - 2)}┤`;
    const rowLines  = rows.map(row => `│ ${row.padEnd(width - 4)} │`);
    return [
        `┌${'─'.repeat(width - 2)}┐`,
        titleLine,
        rows.length > 0 ? divider : '',
        ...rowLines,
        `└${'─'.repeat(width - 2)}┘`,
    ].filter(line => line !== '').join('\n');
}

/** Format a RAM-status panel for periodic display. */
export function formatRamStatusPanel(
    totalRam: number,
    freeRam: number,
    homeFreeRam: number,
    homeReserved: number,
    ramViolated: boolean,
): string {
    return createStatusPanel('RAM STATUS', [
        `Total RAM:   ${formatRam(totalRam)}`,
        `Free RAM:    ${formatRam(freeRam)}`,
        `Home Free:   ${formatRam(homeFreeRam)}`,
        `Home Resvd:  ${formatRam(homeReserved)}`,
        `Status:      ${ramViolated ? 'VIOLATED' : 'HEALTHY'}`,
    ]);
}

/** Format a batch-income summary panel. */
export function formatBatchInfoPanel(
    targetMap: Map<string, number>,
    totalThreads: number,
    totalDps: number,
): string {
    const rows = Array.from(targetMap.entries()).map(
        ([target, dps]) => `${target.padEnd(15)} ${formatMoney(dps)}/s`
    );
    rows.push(`Total Income: ${formatMoney(totalDps)}/s`);
    rows.push(`Total Threads: ${totalThreads}`);
    return createStatusPanel('BATCH INFO', rows);
}

// ── Compute the effective home RAM reservation ────────────────────────────────

function calcHomeRamReservation(ns: NS, minOverride?: number): number {
    const homeMaxRam = ns.getServerMaxRam('home');
    const minReserve = minOverride ?? HOME_RAM_RESERVE_MIN;
    return Math.max(
        Math.min(homeMaxRam * HOME_RAM_RESERVE_FRACTION, HOME_RAM_RESERVE_MAX),
        minReserve,
    );
}

// ── Maintenance helpers ───────────────────────────────────────────────────────

async function nukeAll(ns: NS): Promise<void> {
    try {
        const pid = ns.exec(DAEMON_PATHS.spreader, 'home', 1);
        for (let i = 0; i < 1000 && ns.isRunning(pid); i++) await ns.sleep(100);
    } catch (e) { ns.print(`WARN: nukeAll failed: ${String(e)}`); }
}

async function buyPortOpeners(ns: NS): Promise<void> {
    try { ns.exec(DAEMON_PATHS.buyPortOpener, 'home', 1); }
    catch (e) { ns.print(`WARN: buyPortOpeners: ${String(e)}`); }
}

/**
 * Launch auto-grow workers on unprepared targets and wait for them to finish.
 * Blocking — exits when all targets are prepared or after a timeout.
 */
async function prepareServers(
    ns: NS,
    targets: string[],
    availableServers: string[],
    moneyThreshold: number,
    securityThreshold: number,
): Promise<void> {
    const unprepared = targets.filter(t => !isServerPrepared(ns, t, moneyThreshold, securityThreshold));
    if (unprepared.length === 0) return;

    ns.print(`Preparing ${unprepared.length} server(s) for hacking…`);
    let serverIndex = 0;
    for (const target of unprepared) {
        for (let i = 0; i < Math.min(3, availableServers.length); i++) {
            const host = availableServers[(serverIndex + i) % availableServers.length];
            const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
            const autoGrowRam = ns.getScriptRam(SCRIPT_PATHS.autoGrow);
            const threads = Math.floor(freeRam / autoGrowRam / 2);
            if (threads > 0) execMulti(ns, host, threads, SCRIPT_PATHS.autoGrow, target);
        }
        serverIndex = (serverIndex + 1) % availableServers.length;
    }

    for (let iter = 0; iter < 300; iter++) {
        await ns.sleep(1000);
        const done = unprepared.filter(t => isServerPrepared(ns, t, moneyThreshold, securityThreshold)).length;
        if (done === unprepared.length) break;
        if (iter % 15 === 0) {
            ns.print(`┌─── SERVER PREPARATION ───┐
│ Total:  ${unprepared.length.toString().padEnd(5)} │
│ Ready:  ${done.toString().padEnd(5)} │
│ Wait:   ${(unprepared.length - done).toString().padEnd(5)} │
└────────────────────────┘`);
        }
    }

    for (const host of availableServers) {
        if (ns.scriptRunning(SCRIPT_PATHS.autoGrow, host)) ns.scriptKill(SCRIPT_PATHS.autoGrow, host);
    }
    ns.print('Server preparation complete.');
}

/** Fill idle botnet RAM with share() threads to boost faction rep. */
function shareRemainingRam(
    ns: NS,
    availableServers: string[],
    homeReserve: number,
    maxHomeFraction: number,
): void {
    const scriptRam = ns.getScriptRam(SCRIPT_PATHS.share);
    let totalThreads = 0;

    for (const host of availableServers) {
        const maxRam = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        const reserve = host === 'home' ? homeReserve : 0;
        const free = Math.max(0, maxRam - usedRam - reserve);
        const ramToUse = host === 'home' ? free * maxHomeFraction : free;
        const threads = Math.floor(ramToUse / scriptRam);
        if (threads > 0) {
            execMulti(ns, host, threads, SCRIPT_PATHS.share);
            totalThreads += threads;
        }
    }
    if (totalThreads > 0) {
        ns.print(`SHARE: ${totalThreads} threads across ${availableServers.length} servers`);
    }
}

// ── Main daemon entry point ───────────────────────────────────────────────────

// TODO(design): Publish phase/target decisions to PORT_PHASE / PORT_BUS_TASK so cross/
//               modules can react without polling. Add self-registration on PORT_BUS_REGISTER.
// TODO(design): homeReservedRam doubling — when violation is frequent, double the minimum
//               reserve (alainbryden pattern) to shed load gracefully.

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.enableLog('print');

    // Optional --homeRam override: strategy_agent (or user) can pass a higher reservation
    const args = ns.flags([['homeRam', 0]]);
    const homeRamOverride = Number(args.homeRam);

    // Wire up engine components
    const ramManager  = new RamManager(ns, homeRamOverride > 0 ? homeRamOverride : undefined);
    const targetManager = new TargetSelector(ns);

    const scripts = {
        hack:   { path: SCRIPT_PATHS.hack,   ram: SCRIPT_RAM_COST },
        grow:   { path: SCRIPT_PATHS.grow,   ram: SCRIPT_RAM_COST },
        weaken: { path: SCRIPT_PATHS.weaken, ram: SCRIPT_RAM_COST },
        share:  { path: SCRIPT_PATHS.share,  ram: ns.getScriptRam(SCRIPT_PATHS.share) },
    };

    const threadManager = new ThreadDistributionManager(ns, {
        operationDelay: BATCH_STEP_TIME,
        silentMisfires: EXEC_SILENT_MISFIRES,
        debug:          EXEC_DEBUG,
    }, scripts);

    const batchManager = new BatchHackManager(ns, threadManager);

    // Initial nuke pass + launch persistent daemons
    await nukeAll(ns);
    if (!ns.isRunning(DAEMON_PATHS.gameAgent, 'home'))      ns.exec(DAEMON_PATHS.gameAgent, 'home', 1);
    if (!ns.isRunning(DAEMON_PATHS.bootAgent, 'home'))       ns.exec(DAEMON_PATHS.bootAgent, 'home', 1);
    if (FEATURES.enableAutoServerPurchase &&
        !ns.isRunning(DAEMON_PATHS.pservManager, 'home'))    ns.exec(DAEMON_PATHS.pservManager, 'home', 1);
    if (!ns.isRunning(DAEMON_PATHS.hacknetManager, 'home')) ns.exec(DAEMON_PATHS.hacknetManager, 'home', 1);

    ns.print('Coordinator started');

    let tick = 0;
    let lastNukeTime = 0;
    let lastPortOpenerTime = 0;
    let lastShareTime = 0;
    let lastTargetCheck = 0;
    const TARGET_CHECK_INTERVAL_S = 5;

    while (true) {
        try {
            tick++;
            const now = Date.now();
            const sec = Math.floor(now / 1000);

            // ── Periodic maintenance ──────────────────────────────────────────
            if (sec - lastNukeTime >= INTERVAL_NUKE_S) {
                await nukeAll(ns);
                lastNukeTime = sec;
            }
            if (sec - lastPortOpenerTime >= INTERVAL_PORT_OPENER_S) {
                await buyPortOpeners(ns);
                lastPortOpenerTime = sec;
            }
            // Ensure persistent infrastructure daemons are alive (respawn if killed)
            if (FEATURES.enableAutoServerPurchase &&
                !ns.isRunning(DAEMON_PATHS.pservManager, 'home'))   ns.exec(DAEMON_PATHS.pservManager, 'home', 1);
            if (!ns.isRunning(DAEMON_PATHS.hacknetManager, 'home')) ns.exec(DAEMON_PATHS.hacknetManager, 'home', 1);

            // ── RAM snapshot ─────────────────────────────────────────────────
            const homeReserved = calcHomeRamReservation(ns, homeRamOverride > 0 ? homeRamOverride : undefined);
            const { servers: availServers } = getAvailableServers(ns, MIN_SERVER_RAM, true, homeReserved);

            const totalRam  = availServers.reduce((s, h) => s + ns.getServerMaxRam(h), 0);
            const usedRam   = availServers.reduce((s, h) => s + ns.getServerUsedRam(h), 0);
            const homeFree  = ns.getServerMaxRam('home') - ns.getServerUsedRam('home');
            const ramViolated = homeFree < homeReserved;

            if (tick % 10 === 0) {
                ns.print(formatRamStatusPanel(totalRam, totalRam - usedRam, homeFree, homeReserved, ramViolated));
            }

            // ── Share idle RAM ────────────────────────────────────────────────
            if (FEATURES.enableShare && sec - lastShareTime >= INTERVAL_SHARE_S) {
                shareRemainingRam(ns, availServers, homeReserved, HOME_RAM_RESERVE_FRACTION);
                lastShareTime = sec;
            }

            // ── Target scan + batch scheduling ───────────────────────────────
            if (sec - lastTargetCheck >= TARGET_CHECK_INTERVAL_S) {
                lastTargetCheck = sec;
                ramManager.updateRamInfo();
                targetManager.refreshTargets();

                // Prepare any unprepared top targets before batching
                const allTargets = getTargetServers(ns);
                const unprepared = allTargets
                    .filter(t => !isServerPrepared(ns, t, TARGET_MONEY_THRESHOLD, TARGET_SECURITY_THRESHOLD))
                    .slice(0, MAX_TARGETS);

                if (unprepared.length > 0) {
                    await prepareServers(
                        ns, unprepared, availServers,
                        TARGET_MONEY_THRESHOLD, TARGET_SECURITY_THRESHOLD,
                    );
                }

                const launched = await batchManager.scheduleBatches(targetManager, ramManager, MAX_TARGETS);

                if (launched > 0 || tick % 5 === 0) {
                    batchManager.printStatus(ramManager, launched);
                }
            }

            await ns.sleep(200);
        } catch (err) {
            ns.print(`ERROR in coordinator loop: ${String(err)}`);
            await ns.sleep(5000);
        }
    }
}
