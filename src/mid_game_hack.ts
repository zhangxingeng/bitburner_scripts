import { NS } from '@ns';
import { formatMoney, formatRam, findAllServers, padNum } from './lib/util_normal_ram';
import { execMulti } from './hack_lib/exec_multi';
import { FormulaHelper } from './hack_lib/formulas';
import { ensureScriptExists } from './lib/utils_extra';

// Configuration for the mid-game hacking script
interface MidGameConfig {
    // RAM management
    reservedHomeRam: number;
    minServerRam: number;
    useHomeRam: boolean;

    // Hacking settings
    moneyThreshold: number;
    securityThreshold: number;

    // Intervals for various tasks (in milliseconds)
    serverPurchaseInterval: number;
    portOpenerPurchaseInterval: number;
    shareInterval: number;
    nukeInterval: number;
    upgradeHomeServerInterval: number;

    // Feature flags
    enableShareRam: boolean;
    maxShareRamPercent: number;

    // Threshold to switch to batch_hack.ts
    batchHackRamThreshold: number;
}

// Server information
interface ServerInfo {
    hostname: string;
    hasRoot: boolean;
    maxMoney: number;
    minSecurity: number;
    requiredHackingLevel: number;
    growthFactor: number;
    maxRam: number;
    moneyAvailable: number;
    securityLevel: number;
    serverValue: number;
    isPrepping: boolean;
    isHacking: boolean;
}

// Default configuration
const DEFAULT_CONFIG: MidGameConfig = {
    reservedHomeRam: 128,
    minServerRam: 64,
    useHomeRam: true,
    moneyThreshold: 0.75,
    securityThreshold: 5,
    serverPurchaseInterval: 300,
    portOpenerPurchaseInterval: 30000,
    shareInterval: 10000,
    nukeInterval: 60000,
    upgradeHomeServerInterval: 60000,
    enableShareRam: true,
    maxShareRamPercent: 1.0,
    batchHackRamThreshold: 16384
};

// Paths to scripts
const SCRIPTS = {
    hack: 'remote/hack.js',
    grow: 'remote/grow.js',
    weaken: 'remote/weaken.js',
    share: 'remote/share.js',
    purchaseServer: 'purchase_server.js',
    upgradeHomeServer: 'basic/upgrade_home_server.js',
    buyPortOpener: 'basic/buy_port_opener.js',
    batchHack: 'batch_hack.ts',
    scanNuke: 'lib/scan_nuke.js'
};

// Script RAM costs
const RAM_COSTS: { [key: string]: number } = {
    hack: 1.7,
    grow: 1.75,
    weaken: 1.75,
    share: 4.0
};

export async function main(ns: NS): Promise<void> {
    // Disable logs to reduce clutter
    ns.disableLog('ALL');
    ns.enableLog('print');

    // Parse command line arguments
    const args = ns.flags([
        ['reserved-ram', DEFAULT_CONFIG.reservedHomeRam],
        ['min-server-ram', DEFAULT_CONFIG.minServerRam],
        ['use-home-ram', DEFAULT_CONFIG.useHomeRam],
        ['money-threshold', DEFAULT_CONFIG.moneyThreshold],
        ['security-threshold', DEFAULT_CONFIG.securityThreshold],
        ['share', DEFAULT_CONFIG.enableShareRam],
        ['max-share-percent', DEFAULT_CONFIG.maxShareRamPercent],
        ['batch-hack-threshold', DEFAULT_CONFIG.batchHackRamThreshold]
    ]);

    // Setup configuration
    const config: MidGameConfig = {
        ...DEFAULT_CONFIG,
        reservedHomeRam: args['reserved-ram'] as number,
        minServerRam: args['min-server-ram'] as number,
        useHomeRam: args['use-home-ram'] as boolean,
        moneyThreshold: args['money-threshold'] as number,
        securityThreshold: args['security-threshold'] as number,
        enableShareRam: args['share'] as boolean,
        maxShareRamPercent: args['max-share-percent'] as number,
        batchHackRamThreshold: args['batch-hack-threshold'] as number
    };

    // Initialize variables
    const formulas = new FormulaHelper(ns);
    let servers: ServerInfo[] = [];
    let lastServerPurchaseTime = 0;
    let lastPortOpenerPurchaseTime = 0;
    let lastUpgradeHomeServerTime = 0;
    let lastShareTime = 0;
    let lastScanNukeTime = 0;

    // Main loop
    ns.print('Starting Mid-Game Hacking Script');
    while (true) {
        try {
            const currentTime = Date.now();

            // Check if we should switch to batch_hack.ts
            if (ns.getServerMaxRam('home') >= config.batchHackRamThreshold) {
                ns.print(`INFO: Home RAM has reached ${formatRam(ns.getServerMaxRam('home'))}. Switching to ${SCRIPTS.batchHack}.`);
                ns.spawn(SCRIPTS.batchHack, 1);
                return;
            }

            // Refresh server list and update server information
            servers = await updateServerInfo(ns, formulas);

            // Run scan-nuke periodically to get root access on new servers
            if (currentTime - lastScanNukeTime > config.nukeInterval) {
                await runScanNuke(ns);
                lastScanNukeTime = currentTime;
            }

            // Auto purchase port openers
            if (currentTime - lastPortOpenerPurchaseTime > config.portOpenerPurchaseInterval) {
                await purchasePortOpeners(ns);
                lastPortOpenerPurchaseTime = currentTime;
            }

            // Auto purchase servers
            if (currentTime - lastServerPurchaseTime > config.serverPurchaseInterval) {
                await purchaseServers(ns, config);
                lastServerPurchaseTime = currentTime;
            }

            // Auto upgrade home server
            if (currentTime - lastUpgradeHomeServerTime > config.upgradeHomeServerInterval) {
                await upgradeHomeServer(ns);
                lastUpgradeHomeServerTime = currentTime;
            }

            // Manage hacking operations
            await manageHackingOperations(ns, servers, config, formulas);

            // Use remaining RAM for share if enabled
            if (config.enableShareRam && currentTime - lastShareTime > config.shareInterval) {
                await shareRemainingRam(ns, config);
                lastShareTime = currentTime;
            }

            // Display status
            ns.clearLog();
            displayStatus(ns, servers);

            await ns.sleep(300);
        } catch (error) {
            ns.print(`ERROR: ${String(error)}`);
            await ns.sleep(5000);
        }
    }
}

// Scan for new servers and nuke them if possible
async function runScanNuke(ns: NS): Promise<void> {
    const pid = ns.exec(SCRIPTS.scanNuke, 'home', 1);
    if (pid > 0) {
        ns.print(`INFO: Running ${SCRIPTS.scanNuke} to gain root access to new servers.`);
    }
}

// Purchase port openers
async function purchasePortOpeners(ns: NS): Promise<void> {
    ns.exec(SCRIPTS.buyPortOpener, 'home', 1);
}

// Purchase and upgrade servers
async function purchaseServers(ns: NS, config: MidGameConfig): Promise<void> {
    // Calculate budget - use 20% of current money
    const budget = ns.getServerMoneyAvailable('home') * 0.2;

    if (budget > ns.getPurchasedServerCost(config.minServerRam)) {
        ns.exec(SCRIPTS.purchaseServer, 'home', 1, budget);
    }
}

async function upgradeHomeServer(ns: NS): Promise<void> {
    const pid = ns.exec(SCRIPTS.upgradeHomeServer, 'home', 1);
    if (pid > 0) {
        ns.print(`INFO: Running ${SCRIPTS.upgradeHomeServer} to upgrade home server.`);
    }
}

// Get all servers and their information
async function updateServerInfo(ns: NS, formulas: FormulaHelper): Promise<ServerInfo[]> {
    const serverInfoList: ServerInfo[] = [];
    const serverNames = findAllServers(ns);
    const player = ns.getPlayer();

    for (const hostname of serverNames) {
        // Skip purchased servers with < 8GB RAM, they're not worth targeting
        if (hostname.startsWith('daemon') && ns.getServerMaxRam(hostname) < 8) continue;

        const server = ns.getServer(hostname);
        const maxMoney = server.moneyMax || 0;

        // Skip servers with no money
        if (maxMoney <= 0 && !hostname.startsWith('daemon') && hostname !== 'home') continue;

        // Calculate server value for targeting priority
        const minSecurity = server.minDifficulty || 1;
        const hackChance = ns.hackAnalyzeChance(hostname);
        const serverValue = calculateServerValue(maxMoney, minSecurity, server.requiredHackingSkill || 1, hackChance);

        // Check if server is currently being prepped or hacked
        const processes = ns.ps('home').filter(p =>
            p.args.length > 0 && p.args[0] === hostname);
        const isPrepping = processes.some(p => p.filename.includes('/weaken.js') || p.filename.includes('/grow.js'));
        const isHacking = processes.some(p => p.filename.includes('/hack.js'));

        serverInfoList.push({
            hostname,
            hasRoot: server.hasAdminRights,
            maxMoney,
            minSecurity,
            requiredHackingLevel: server.requiredHackingSkill || 1,
            growthFactor: server.serverGrowth || 1,
            maxRam: server.maxRam,
            moneyAvailable: server.moneyAvailable || 0,
            securityLevel: server.hackDifficulty || 1,
            serverValue,
            isPrepping,
            isHacking
        });
    }

    // Sort servers by value for targeting priority
    return serverInfoList.sort((a, b) => b.serverValue - a.serverValue);
}

// Calculate the value of a server for targeting purposes
function calculateServerValue(maxMoney: number, minSecurity: number, requiredLevel: number, hackChance: number): number {
    // Skip servers we don't have the skill to hack yet
    if (requiredLevel > 0) {
        // Prioritize money/security ratio, adjusted by required level and hack chance
        return (maxMoney / minSecurity) * hackChance;
    }
    return 0;
}

// Manage hacking operations for all servers
async function manageHackingOperations(ns: NS, servers: ServerInfo[], config: MidGameConfig, formulas: FormulaHelper): Promise<void> {
    const hackableServers = servers.filter(server =>
        server.hasRoot &&
        server.maxMoney > 0 &&
        server.requiredHackingLevel <= ns.getHackingLevel()
    );

    // Get available servers for running scripts
    const availableServers = servers.filter(server =>
        server.hasRoot &&
        server.maxRam >= config.minServerRam
    );

    // Add home if configured to use it
    if (config.useHomeRam) {
        availableServers.push({
            hostname: 'home',
            hasRoot: true,
            maxMoney: 0,
            minSecurity: 1,
            requiredHackingLevel: 1,
            growthFactor: 1,
            maxRam: Math.max(0, ns.getServerMaxRam('home') - config.reservedHomeRam),
            moneyAvailable: 0,
            securityLevel: 1,
            serverValue: 0,
            isPrepping: false,
            isHacking: false
        });
    }

    // Sort hackable servers by value
    hackableServers.sort((a, b) => b.serverValue - a.serverValue);

    // Process each hackable server in order of value
    for (const target of hackableServers) {
        // Skip if we're already working on this server
        if (target.isPrepping || target.isHacking) continue;

        // Check if the server is prepped (at min security and near max money)
        const isPrepped = isServerPrepped(ns, target, config);

        if (!isPrepped) {
            // Need to prep the server first
            await prepServer(ns, target, availableServers, config, formulas);
        } else {
            // Server is prepped, start hacking
            await hackServer(ns, target, availableServers);
        }
    }
}

// Check if a server is prepped (at min security and near max money)
function isServerPrepped(ns: NS, server: ServerInfo, config: MidGameConfig): boolean {
    // If security is more than threshold above minimum, not prepped
    if (server.securityLevel > server.minSecurity + config.securityThreshold) {
        return false;
    }

    // If money is less than threshold of maximum, not prepped
    if (server.moneyAvailable < server.maxMoney * config.moneyThreshold) {
        return false;
    }

    return true;
}

// Prepare a server by weakening to min security and growing to max money
async function prepServer(ns: NS, target: ServerInfo, availableServers: ServerInfo[], config: MidGameConfig, formulas: FormulaHelper): Promise<void> {
    // Calculate threads needed
    const weakenThreadsNeeded = Math.ceil((target.securityLevel - target.minSecurity) / 0.05);
    const growThreadsNeeded = calculateGrowThreads(ns, target, formulas);

    // Prioritize weakening first to reduce security and make other operations faster
    if (weakenThreadsNeeded > 0) {
        const threadsExecuted = await distributeThreads(ns, SCRIPTS.weaken, weakenThreadsNeeded, availableServers, target.hostname);
        if (threadsExecuted > 0) {
            ns.print(`PREP: Started weakening ${target.hostname} with ${threadsExecuted} threads.`);
            return; // Wait for weaken to complete before growing
        }
    }

    // Then focus on growing if security is acceptable
    if (growThreadsNeeded > 0 && target.securityLevel <= target.minSecurity + config.securityThreshold * 2) {
        const threadsExecuted = await distributeThreads(ns, SCRIPTS.grow, growThreadsNeeded, availableServers, target.hostname);
        if (threadsExecuted > 0) {
            ns.print(`PREP: Started growing ${target.hostname} with ${threadsExecuted} threads.`);
        }
    }
}

// Hack a server for money
async function hackServer(ns: NS, target: ServerInfo, availableServers: ServerInfo[]): Promise<void> {
    // Calculate optimal number of threads to use
    // Aim to steal around 50% of available money for optimal balance
    const moneyToSteal = target.moneyAvailable * 0.5;
    const hackThreadsNeeded = Math.floor(moneyToSteal / (target.moneyAvailable * ns.hackAnalyze(target.hostname)));

    if (hackThreadsNeeded <= 0) return;

    const threadsExecuted = await distributeThreads(ns, SCRIPTS.hack, hackThreadsNeeded, availableServers, target.hostname);
    if (threadsExecuted > 0) {
        ns.print(`HACK: Started hacking ${target.hostname} with ${threadsExecuted} threads to steal ~${formatMoney(moneyToSteal)}.`);
    }
}

// Calculate grow threads needed to reach max money
function calculateGrowThreads(ns: NS, server: ServerInfo, formulas: FormulaHelper): number {
    // If server has no money, we need to add at least $1 before we can grow it
    if (server.moneyAvailable <= 0) {
        return Math.ceil(ns.growthAnalyze(server.hostname, server.maxMoney / 1));
    }

    // Otherwise calculate threads to grow from current money to max money
    const growthNeeded = server.maxMoney / server.moneyAvailable;
    return Math.ceil(ns.growthAnalyze(server.hostname, growthNeeded));
}

// Distribute threads across available servers
async function distributeThreads(
    ns: NS,
    script: string,
    threads: number,
    availableServers: ServerInfo[],
    target: string
): Promise<number> {
    if (threads <= 0) return 0;

    const scriptRam = RAM_COSTS[script.split('/').pop()?.replace('.js', '') || ''] || 1.75;
    let remainingThreads = threads;
    let totalExecutedThreads = 0;

    // Sort servers by available RAM (descending)
    availableServers.sort((a, b) => {
        const aFreeRam = ns.getServerMaxRam(a.hostname) - ns.getServerUsedRam(a.hostname);
        const bFreeRam = ns.getServerMaxRam(b.hostname) - ns.getServerUsedRam(b.hostname);

        // For home, respect the reserved RAM
        if (a.hostname === 'home') {
            return bFreeRam - (aFreeRam - DEFAULT_CONFIG.reservedHomeRam);
        } else if (b.hostname === 'home') {
            return (bFreeRam - DEFAULT_CONFIG.reservedHomeRam) - aFreeRam;
        }

        return bFreeRam - aFreeRam;
    });

    // Try to distribute threads across servers
    for (const server of availableServers) {
        if (remainingThreads <= 0) break;

        const freeRam = ns.getServerMaxRam(server.hostname) - ns.getServerUsedRam(server.hostname);
        const reservedRam = server.hostname === 'home' ? DEFAULT_CONFIG.reservedHomeRam : 0;
        const availableRam = Math.max(0, freeRam - reservedRam);

        const maxThreads = Math.floor(availableRam / scriptRam);
        const threadsToUse = Math.min(remainingThreads, maxThreads);

        if (threadsToUse <= 0) continue;

        // Ensure the script exists on the target server
        if (server.hostname !== 'home') {
            ensureScriptExists(ns, script, server.hostname);
        }

        // Run the script with the calculated threads
        const pid = execMulti(ns, server.hostname, threadsToUse, script, target, 0, 0, '', false);

        if (pid > 0) {
            remainingThreads -= threadsToUse;
            totalExecutedThreads += threadsToUse;
        }
    }

    return totalExecutedThreads;
}

// Use remaining RAM for share to increase faction reputation gain
async function shareRemainingRam(ns: NS, config: MidGameConfig): Promise<void> {
    if (!config.enableShareRam) return;

    const availableServers = findAllServers(ns).filter(hostname =>
        ns.hasRootAccess(hostname) &&
        ns.getServerMaxRam(hostname) >= config.minServerRam
    );

    let totalThreads = 0;
    let totalRam = 0;

    for (const hostname of availableServers) {
        // Skip home if we're not using it
        if (hostname === 'home' && !config.useHomeRam) continue;

        const maxRam = ns.getServerMaxRam(hostname);
        const usedRam = ns.getServerUsedRam(hostname);
        const reservedRam = hostname === 'home' ? config.reservedHomeRam : 0;

        const availableRam = Math.max(0, maxRam - usedRam - reservedRam);
        const maxShareRam = maxRam * config.maxShareRamPercent;
        const ramToUse = Math.min(availableRam, maxShareRam);

        const shareThreads = Math.floor(ramToUse / RAM_COSTS.share);

        if (shareThreads > 0) {
            // Ensure the script exists on the target server
            if (hostname !== 'home') {
                ensureScriptExists(ns, SCRIPTS.share, hostname);
            }

            const pid = execMulti(ns, hostname, shareThreads, SCRIPTS.share);

            if (pid > 0) {
                totalThreads += shareThreads;
                totalRam += shareThreads * RAM_COSTS.share;
            }
        }
    }

    if (totalThreads > 0) {
        ns.print(`SHARE: Running ${totalThreads} share threads using ${formatRam(totalRam)} RAM to boost faction reputation gain.`);
    }
}

// Display status information
function displayStatus(ns: NS, servers: ServerInfo[]): void {
    const hackableServers = servers.filter(server =>
        server.hasRoot &&
        server.maxMoney > 0 &&
        server.requiredHackingLevel <= ns.getHackingLevel()
    ).sort((a, b) => b.serverValue - a.serverValue);

    // Display top 5 most valuable target servers
    if (hackableServers.length > 0) {
        const topServers = hackableServers.slice(0, 5);

        ns.print('\n===== TOP TARGET SERVERS =====');
        for (const server of topServers) {
            const prepStatus = isServerPrepped(ns, server, DEFAULT_CONFIG) ? 'PREPPED' : 'PREPPING';
            const moneyPercent = (server.moneyAvailable / server.maxMoney * 100).toFixed(1);
            const securityDiff = (server.securityLevel - server.minSecurity).toFixed(1);

            ns.print(`${server.hostname.padEnd(20)} | ${prepStatus.padEnd(8)} | $${formatMoney(server.moneyAvailable)} / $${formatMoney(server.maxMoney)} (${moneyPercent}%) | Security +${securityDiff}`);
        }
    }

    // Display RAM utilization
    const totalMaxRam = servers.reduce((sum, server) => sum + (server.hasRoot ? server.maxRam : 0), 0);
    const totalUsedRam = servers.reduce((sum, server) => sum + (server.hasRoot ? ns.getServerUsedRam(server.hostname) : 0), 0);
    const utilization = (totalUsedRam / totalMaxRam * 100).toFixed(1);

    ns.print('\n===== SYSTEM STATUS =====');
    ns.print(`RAM Utilization: ${formatRam(totalUsedRam)} / ${formatRam(totalMaxRam)} (${utilization}%)`);
    ns.print(`Hacking Level: ${ns.getHackingLevel()}`);
    ns.print(`Money: ${formatMoney(ns.getServerMoneyAvailable('home'))}`);
    ns.print(`Share Enabled: ${DEFAULT_CONFIG.enableShareRam ? 'Yes' : 'No'}`);
}
