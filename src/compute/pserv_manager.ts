import { NS } from '@ns';
import { formatRam, padNum } from '../lib/format';
import { isSingleInstance } from '../lib/net_scan';
import { executeCommand } from '../lib/ns_dodge';

// ── Budget constants ──────────────────────────────────────────────────────────

const MAX_RAM = 1048576; // 2^20 GB — game maximum for purchased servers
const MIN_INITIAL_RAM = 64; // Minimum RAM when buying a fresh server

// Polling intervals (ms)
const PSERV_INTERVAL = 30_000; // Check purchased servers every 30s
const HOME_INTERVAL  = 20_000; // Check home upgrades every 20s

// ── Time-decay budget (alainbryden host-manager pattern) ─────────────────────

/**
 * Compute how much money the coordinator can spend on purchased servers this tick.
 *
 * Integrates the alainbryden host-manager budget model:
 *   budget = max(0, 0.25 * hackIncomeSinceAug - serverSpendSinceAug,
 *                   0.001 * totalIncomeSinceAug - serverSpendSinceAug)
 *
 * This is naturally aggressive early in an aug cycle (hack income accumulates fast)
 * and tapers toward zero late (serverSpend catches up to 25% of hack income).
 *
 * TODO(design): Full time-decay (reserve-by-time) model:
 *   pctReserved = 1 - (1 - initialPct) * (1 - decayFactor)^minutesSinceAug
 *   Requires getTimeSinceLastAug() or a stored aug-start timestamp.
 *   With decayFactor=0.1/min: starts near 5% reserved → ~75% reserved at 6h.
 *   Implement when phase-detector publishes aug-start time to the port bus.
 */
function calcPservBudget(ns: NS): number {
    try {
        // getMoneySources() is present in Bitburner 2.x but not yet in our type declarations
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sources = (ns as any).getMoneySources?.();
        if (sources?.sinceInstall) {
            const hackIncome  = sources.sinceInstall.hacking ?? 0;
            const serverSpend = sources.sinceInstall.servers  ?? 0;
            const totalIncome = sources.sinceInstall.total    ?? 0;
            const budget25pct = Math.max(0, 0.25 * hackIncome - serverSpend);
            const budget01pct = Math.max(0, 0.001 * totalIncome - serverSpend);
            return Math.max(budget25pct, budget01pct);
        }
    } catch { /* getMoneySources not available in this BN/version */ }
    // Fallback: 20% of available money
    return ns.getServerMoneyAvailable('home') * 0.2;
}

// ── Purchased-server helpers (from tools/purchase_server.ts) ─────────────────

function getCostByRam(ns: NS, targetRam: number): number {
    return ns.cloud.getServerCost(targetRam);
}

function isAllMaxed(ns: NS, maxRam: number): boolean {
    const ownServers = ns.cloud.getServerNames();
    const serverRams = ownServers.map(s => ns.getServerMaxRam(s));
    const maxCount = ns.cloud.getServerLimit();
    return ownServers.length >= maxCount && serverRams.every(ram => ram >= maxRam);
}

function getRamPower(ram: number): number {
    return Math.floor(Math.log2(ram));
}

function getRequiredPowerDifference(currentRam: number): number {
    const p = getRamPower(currentRam);
    if (p >= 20) return 0;
    if (p >= 19) return 1;
    if (p >= 18) return 2;
    return 3;
}

function planNextTarget(ns: NS, minInitialRam: number): { targetServer: string, currentRam: number, isNew: boolean } {
    const ownServers = ns.cloud.getServerNames();
    const maxCount = ns.cloud.getServerLimit();

    if (ownServers.length < maxCount) {
        return { targetServer: `pserv-${padNum(ownServers.length, 2)}`, currentRam: 0, isNew: true };
    }

    const withRam = ownServers.map(s => ({ name: s, ram: ns.getServerMaxRam(s) }));
    const minServer = withRam.reduce(
        (min, curr) => curr.ram < min.ram ? curr : min,
        { name: '', ram: Infinity }
    );
    return { targetServer: minServer.name, currentRam: minServer.ram, isNew: false };
}

/**
 * Given a server, a min ram, a max ram, and a budget, return the highest affordable RAM tier.
 * Returns {ram: currentRam, cost: 0} if nothing is affordable.
 */
function estimateCost(
    ns: NS,
    currentRam: number,
    minRam: number,
    maxRam: number,
    budget: number
): { ram: number, cost: number } {
    const nextRam = Math.max(minRam, currentRam > 0 ? currentRam * 2 : minRam);
    if (nextRam > maxRam || getCostByRam(ns, nextRam) > budget) {
        return { ram: currentRam, cost: 0 };
    }

    let bestRam = nextRam;
    let bestCost = getCostByRam(ns, nextRam);
    while (true) {
        const potentialRam = bestRam * 2;
        if (potentialRam > maxRam) break;
        const potentialCost = getCostByRam(ns, potentialRam);
        if (potentialCost > budget) break;
        bestRam = potentialRam;
        bestCost = potentialCost;
    }
    return { ram: bestRam, cost: bestCost };
}

function buyServer(ns: NS, serverName: string, ram: number): boolean {
    const purchasedName = ns.cloud.purchaseServer(serverName, ram);
    if (purchasedName) {
        ns.print(`Purchased new server ${purchasedName} with ${formatRam(ram)} RAM`);
        return true;
    }
    ns.print(`Failed to purchase server ${serverName} with ${formatRam(ram)} RAM`);
    return false;
}

function deleteServer(ns: NS, server: string): boolean {
    ns.killall(server);
    return ns.cloud.deleteServer(server);
}

function upgradeServer(ns: NS, server: string, currentRam: number, newRam: number): boolean {
    if (currentRam >= newRam) {
        ns.print(`Cannot upgrade from ${formatRam(currentRam)} to ${formatRam(newRam)}`);
        return false;
    }
    if (currentRam === 0) return buyServer(ns, server, newRam);

    ns.print(`Upgrading server ${server} from ${formatRam(currentRam)} to ${formatRam(newRam)} RAM`);
    if (!deleteServer(ns, server)) {
        ns.print(`Failed to delete server ${server}`);
        return false;
    }
    return buyServer(ns, server, newRam);
}

/**
 * Attempt one pserv buy/upgrade cycle using the time-decay budget.
 * Finds the weakest purchased server (or buys a new slot) and upgrades to the
 * highest power-of-2 RAM tier affordable within the budget.
 */
function tryUpgradePserv(ns: NS, budget: number): void {
    if (isAllMaxed(ns, MAX_RAM)) {
        ns.print('All purchased servers are at max RAM.');
        return;
    }
    const minCost = ns.cloud.getServerCost(MIN_INITIAL_RAM);
    if (budget < minCost) {
        ns.print(`Budget ${formatRam(budget)} too low for min-tier server (${formatRam(minCost)})`);
        return;
    }

    const { targetServer, currentRam, isNew } = planNextTarget(ns, MIN_INITIAL_RAM);
    const minRam = isNew ? MIN_INITIAL_RAM : (currentRam * 2);
    const { ram: newRam, cost } = estimateCost(ns, currentRam, minRam, MAX_RAM, budget);

    if (cost === 0) {
        ns.print(`Budget insufficient to upgrade ${targetServer} from ${formatRam(currentRam)} RAM`);
        return;
    }
    upgradeServer(ns, targetServer, currentRam, newRam);
}

// ── Home RAM/core upgrader (from tools/upgrade_home.ts, Singularity RAM-dodge) ─

async function tryUpgradeHome(ns: NS): Promise<void> {
    const ramCost   = await executeCommand<number>(ns, 'ns.singularity.getUpgradeHomeRamCost()');
    const coreCost  = await executeCommand<number>(ns, 'ns.singularity.getUpgradeHomeCoresCost()');
    const funcStr   = ramCost <= coreCost
        ? 'ns.singularity.upgradeHomeRam()'
        : 'ns.singularity.upgradeHomeCores()';
    try {
        await executeCommand<boolean>(ns, funcStr);
    } catch { /* singularity not available or too expensive */ }
}

// ── Main daemon entry point ───────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.enableLog('print');

    if (!isSingleInstance(ns)) { return; }

    ns.print('pserv_manager started (buy/upgrade purchased servers + home RAM)');

    let lastPservTime = 0;
    let lastHomeTime  = 0;

    while (true) {
        const now = Date.now();

        // ── Purchased server upgrades ────────────────────────────────────
        if (now - lastPservTime >= PSERV_INTERVAL) {
            const budget = calcPservBudget(ns);
            tryUpgradePserv(ns, budget);
            lastPservTime = now;
        }

        // ── Home RAM / core upgrades (Singularity, RAM-dodged) ───────────
        if (now - lastHomeTime >= HOME_INTERVAL) {
            await tryUpgradeHome(ns);
            lastHomeTime = now;
        }

        await ns.sleep(1000);
    }
}
