import type { NS } from '@ns';
import { formatMoney } from '../lib/format';
import { execMulti } from '../engine/exec_multi';
import { FormulaHelper } from '../engine/formulas';
import { HackingConfig } from '../engine/config';
import { RamManager } from '../engine/ram_manager';
import { ServerTargetManager } from '../engine/server_manager';
import { ThreadDistributionManager } from '../engine/thread_manager';
import { BatchHackManager } from '../engine/batch_hack_manager';
import {
    getAvailableServers,
    getTargetServers,
    isServerPrepared,
    formatRamStatusPanel,
    formatBatchInfoPanel,
} from '../engine/batch_util';

// ── Orchestrator-level config (engine/HackingConfig covers the HWGW layer) ──

const PATHS = {
    purchaseServer: '/tools/purchase_server.js',
    upgradeHomeServer: '/tools/upgrade_home.js',
    buyPortOpener: '/tools/port_openers.js',
    scanNuke: '/tools/scan_nuke.js',
    autoGrow: '/deploy/auto_grow.js',
    share: '/deploy/share.js',
} as const;

const INTERVALS = {
    nuke: 60,
    portOpener: 30,
    serverPurchase: 300,
    upgradeHomeServer: 60,
    share: 10,
} as const;

const FEATURES = {
    enableShare: true,
    enableAutoServerPurchase: true,
} as const;

// ── State ──

let lastNukeTime = 0;
let lastPortOpenerTime = 0;
let lastServerPurchaseTime = 0;
let lastUpgradeHomeServerTime = 0;
let lastShareTime = 0;

// ── Maintenance helpers ──

async function nukeAll(ns: NS): Promise<void> {
    try {
        const pid = ns.exec(PATHS.scanNuke, 'home', 1);
        for (let i = 0; i < 1000 && ns.isRunning(pid); i++) await ns.sleep(100);
    } catch (e) { ns.print(`WARN: nukeAll failed: ${String(e)}`); }
}

async function buyPortOpeners(ns: NS): Promise<void> {
    try { ns.exec(PATHS.buyPortOpener, 'home', 1); } catch (e) { ns.print(`WARN: buyPortOpeners: ${String(e)}`); }
}

async function purchaseServers(ns: NS, minRam: number): Promise<void> {
    try {
        const budget = ns.getServerMoneyAvailable('home') * 0.2;
        if (budget > ns.getPurchasedServerCost(minRam)) {
            ns.exec(PATHS.purchaseServer, 'home', 1, budget);
        }
    } catch (e) { ns.print(`WARN: purchaseServers: ${String(e)}`); }
}

async function upgradeHomeServer(ns: NS): Promise<void> {
    try { ns.exec(PATHS.upgradeHomeServer, 'home', 1); } catch (e) { ns.print(`WARN: upgradeHome: ${String(e)}`); }
}

/** Run auto-grow on unprepared targets, blocking until they're ready. */
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
            const threads = Math.floor(freeRam / ns.getScriptRam(PATHS.autoGrow) / 2);
            if (threads > 0) execMulti(ns, host, threads, PATHS.autoGrow, target);
        }
        serverIndex = (serverIndex + 1) % availableServers.length;
    }

    // Wait for preparation with periodic status
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

    // Kill leftover auto-grow scripts
    for (const host of availableServers) {
        if (ns.scriptRunning(PATHS.autoGrow, host)) ns.scriptKill(PATHS.autoGrow, host);
    }
    ns.print('Server preparation complete.');
}

/** Distribute idle RAM across servers for share() to boost faction rep gain. */
function shareRemainingRam(ns: NS, availableServers: string[], homeReserve: number, maxShareFraction: number): void {
    if (!FEATURES.enableShare) return;
    const scriptRam = ns.getScriptRam(PATHS.share);
    let totalThreads = 0;

    for (const host of availableServers) {
        const maxRam = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        const reserve = host === 'home' ? homeReserve : 0;
        const free = Math.max(0, maxRam - usedRam - reserve);
        const ramToUse = host === 'home' ? free * maxShareFraction : free;
        const threads = Math.floor(ramToUse / scriptRam);
        if (threads > 0) {
            execMulti(ns, host, threads, PATHS.share);
            totalThreads += threads;
        }
    }
    if (totalThreads > 0) ns.print(`SHARE: ${totalThreads} threads across ${availableServers.length} servers`);
}

// ── Main ──

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.enableLog('print');

    // Engine wiring
    const config = new HackingConfig(ns);
    const ramManager = new RamManager(ns, config);
    const targetManager = new ServerTargetManager(ns);
    const formulas = new FormulaHelper(ns);

    const scripts = {
        hack: { path: config.scriptPaths.hack, ram: config.scriptRamCost },
        grow: { path: config.scriptPaths.grow, ram: config.scriptRamCost },
        weaken: { path: config.scriptPaths.weaken, ram: config.scriptRamCost },
        share: { path: config.scriptPaths.share, ram: ns.getScriptRam(config.scriptPaths.share) },
    };

    const threadManager = new ThreadDistributionManager(ns, {
        operationDelay: config.batchConfig.stepTime,
        silentMisfires: config.executionConfig.silentMisfires,
        debug: config.executionConfig.debug,
    }, scripts);

    const batchManager = new BatchHackManager(ns, config, threadManager);

    // Seed with initial nuke
    await nukeAll(ns);
    lastNukeTime = Date.now();
    ns.print('Advanced Batch Hacking System started');

    let tick = 0;
    let lastTargetCheck = 0;
    const TARGET_CHECK_INTERVAL = 5;

    while (true) {
        try {
            tick++;
            const now = Date.now();
            const sec = Math.floor(now / 1000);

            // ── Periodic maintenance ──
            if (sec - lastNukeTime >= INTERVALS.nuke) { await nukeAll(ns); lastNukeTime = sec; }
            if (sec - lastPortOpenerTime >= INTERVALS.portOpener) { await buyPortOpeners(ns); lastPortOpenerTime = sec; }
            if (FEATURES.enableAutoServerPurchase && sec - lastServerPurchaseTime >= INTERVALS.serverPurchase) {
                await purchaseServers(ns, config.ramConfig.minServerRam);
                lastServerPurchaseTime = sec;
            }
            if (sec - lastUpgradeHomeServerTime >= INTERVALS.upgradeHomeServer) {
                await upgradeHomeServer(ns);
                lastUpgradeHomeServerTime = sec;
            }

            // ── RAM display ──
            const { servers: availServers, rams, allocs } = getAvailableServers(
                ns, config.ramConfig.minServerRam, config.ramConfig.useHomeRam,
                config.getHomeRamReservation(ns),
            );

            const totalRam = availServers.reduce((s, h) => s + ns.getServerMaxRam(h), 0);
            const usedRam = availServers.reduce((s, h) => s + ns.getServerUsedRam(h), 0);
            const homeFree = ns.getServerMaxRam('home') - ns.getServerUsedRam('home');
            const homeReserved = config.getHomeRamReservation(ns);
            const ramViolated = homeFree < homeReserved;

            if (tick % 10 === 0) {
                ns.print(formatRamStatusPanel(totalRam, totalRam - usedRam, homeFree, homeReserved, ramViolated));
            }

            // ── Share idle RAM ──
            if (FEATURES.enableShare && sec - lastShareTime >= INTERVALS.share) {
                shareRemainingRam(ns, availServers, homeReserved, config.ramConfig.homeRamReservePercent);
                lastShareTime = sec;
            }

            // ── Target scan & batch scheduling ──
            if (sec - lastTargetCheck >= TARGET_CHECK_INTERVAL) {
                lastTargetCheck = sec;
                ramManager.updateRamInfo();
                targetManager.refreshTargets();

                const targets = getTargetServers(ns);
                const unpreparedAll: string[] = [];
                for (const t of targets) {
                    if (!isServerPrepared(ns, t, config.targetingConfig.moneyThreshold, config.targetingConfig.securityThreshold)) {
                        unpreparedAll.push(t);
                    }
                }
                const unprepared = unpreparedAll.slice(0, config.targetingConfig.maxTargets);

                if (unprepared.length > 0) {
                    await prepareServers(ns, unprepared, availServers,
                        config.targetingConfig.moneyThreshold, config.targetingConfig.securityThreshold);
                }

                // Use engine classes for batch calculation + execution
                const launched = await batchManager.scheduleBatches(
                    targetManager, ramManager, config.targetingConfig.maxTargets,
                );

                // Display active batch status
                if (launched > 0 || tick % 5 === 0) {
                    batchManager.printStatus(ramManager, launched);
                }
            }

            await ns.sleep(200);
        } catch (err) {
            ns.print(`ERROR in main loop: ${String(err)}`);
            await ns.sleep(5000);
        }
    }
}
