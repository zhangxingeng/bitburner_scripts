import { NS, Server, Player } from '@ns';
import { formatRam, formatMoney, formatPercent } from '../lib/util_low_ram';
import { findAllServers } from '../lib/util_normal_ram';

/**
 * Format RAM to human-readable string
 * @param ram RAM in GB
 * @returns Formatted RAM string
 */
export function formatRamGb(ram: number): string {
    if (ram < 1024) {
        return `${ram.toFixed(2)}GB`;
    } else if (ram < 1024 * 1024) {
        return `${(ram / 1024).toFixed(2)}TB`;
    } else {
        return `${(ram / (1024 * 1024)).toFixed(2)}PB`;
    }
}

/**
 * Calculate the value of a server for targeting purposes
 * @param ns - The Netscript API
 * @param target - Target server
 * @returns Server value score
 */
export function calculateServerValue(ns: NS, target: string): number {
    const maxMoney = ns.getServerMaxMoney(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const hackChance = ns.hackAnalyzeChance(target);
    const hackTime = ns.getHackTime(target);
    const growthFactor = ns.getServerGrowth(target);

    // Calculate a balanced score based on multiple factors
    const moneyScore = maxMoney;
    const securityScore = 1 / (minSecurity + 1); // Lower security is better
    const timeScore = 1 / (hackTime / 1000 + 1); // Faster hack time is better
    const chanceScore = hackChance;
    const growthScore = growthFactor / 100;

    // Combined score with weights
    const score = moneyScore * securityScore * timeScore * chanceScore * growthScore;
    return score;
}

/**
 * Get optimal server state for calculation (max money, min security)
 * @param ns - NetScript API
 * @param hostname - Server hostname
 * @returns Server object with optimal settings
 */
export function getOptimalServer(ns: NS, hostname: string): Server {
    const server = ns.getServer(hostname);
    server.moneyAvailable = server.moneyMax || 0;
    server.hackDifficulty = server.minDifficulty || 1;
    return server;
}

/**
 * Check if server is prepared (min security, max money)
 * @param ns - NetScript API
 * @param target - Target server hostname
 * @param moneyThreshold - Money threshold (0-1, default 0.9)
 * @param securityThreshold - Security threshold (default 3)
 * @returns Whether the server is prepared
 */
export function isServerPrepared(
    ns: NS,
    target: string,
    moneyThreshold: number = 0.9,
    securityThreshold: number = 3
): boolean {
    const server = ns.getServer(target);
    const currentMoney = server.moneyAvailable || 0;
    const maxMoney = server.moneyMax || 1;
    const currentSecurity = server.hackDifficulty || 100;
    const minSecurity = server.minDifficulty || 1;

    return (
        currentMoney >= maxMoney * moneyThreshold &&
        currentSecurity <= minSecurity + securityThreshold
    );
}

/**
 * Get available servers that can run scripts
 * @param ns - NetScript API
 * @param minServerRam - Minimum server RAM to use
 * @param useHomeRam - Whether to use home RAM
 * @param homeRamReserve - GB to reserve on home
 * @returns Available servers, RAM, and allocation info
 */
export function getAvailableServers(
    ns: NS,
    minServerRam: number = 2,
    useHomeRam: boolean = true,
    homeRamReserve: number = 100
): { servers: string[], rams: number[], allocs: number[] } {
    const allServers = findAllServers(ns);
    const availableServers = allServers.filter(server => {
        // Skip non-rooted servers
        if (!ns.hasRootAccess(server)) return false;

        // Skip servers with too little RAM
        if (ns.getServerMaxRam(server) < minServerRam) return false;

        // Handle home server separately
        if (server === 'home') {
            // Only use home if enabled
            if (!useHomeRam) return false;

            // Check if home has enough free RAM after reservation
            const maxRam = ns.getServerMaxRam(server);
            const usedRam = ns.getServerUsedRam(server);
            return (maxRam - usedRam - homeRamReserve) > minServerRam;
        }

        return true;
    });

    const availableRams = availableServers.map(server => {
        if (server === 'home') {
            // Reserve RAM for home
            return Math.max(0, ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - homeRamReserve);
        } else {
            return ns.getServerMaxRam(server) - ns.getServerUsedRam(server);
        }
    });

    const scriptBaseCost = 1.75; // Base RAM cost for scripts
    const availableAllocs = availableRams.map(ram => Math.floor(ram / scriptBaseCost));

    return { servers: availableServers, rams: availableRams, allocs: availableAllocs };
}

/**
 * Get potential target servers for hacking
 * @param ns - NetScript API
 * @returns Array of target server hostnames sorted by value
 */
export function getTargetServers(ns: NS): string[] {
    const allServers = findAllServers(ns);
    const hackLevel = ns.getHackingLevel();

    // Filter servers to those that can be hacked
    const targetServers = allServers.filter(server => {
        // Skip purchased servers and home
        if (server === 'home' || ns.getPurchasedServers().includes(server)) {
            return false;
        }

        // Only include rooted servers with money
        if (!ns.hasRootAccess(server) || ns.getServerMaxMoney(server) <= 0) {
            return false;
        }

        // Only include servers we can hack
        const requiredLevel = ns.getServerRequiredHackingLevel(server);
        return requiredLevel <= hackLevel;
    });

    // Sort by value
    return targetServers.sort((a, b) => {
        const aValue = calculateServerValue(ns, a);
        const bValue = calculateServerValue(ns, b);
        return bValue - aValue;
    });
}

/**
 * Helper function to add arrays element-wise
 * @param a First array
 * @param b Second array
 * @returns New array with element-wise sum
 */
export function arrAdd(a: number[], b: number[]): number[] {
    return a.map((val, idx) => val + b[idx]);
}

/**
 * Helper function to subtract arrays element-wise
 * @param a First array
 * @param b Second array
 * @returns New array with element-wise difference
 */
export function arrSubtract(a: number[], b: number[]): number[] {
    return a.map((val, idx) => val - b[idx]);
}

/**
 * Create a status panel with a box border
 * @param title Panel title
 * @param rows Panel content rows
 * @returns Formatted panel string
 */
export function createStatusPanel(title: string, rows: string[]): string {
    const width = Math.max(
        title.length + 6,
        ...rows.map(row => row.length + 2)
    );

    const titlePadded = `│ ${title.padEnd(width - 4)} │`;
    const divider = `├${'─'.repeat(width - 2)}┤`;

    const formattedRows = rows.map(row => `│ ${row.padEnd(width - 4)} │`);

    return [
        `┌${'─'.repeat(width - 2)}┐`,
        titlePadded,
        rows.length > 0 ? divider : '',
        ...formattedRows,
        `└${'─'.repeat(width - 2)}┘`
    ].filter(line => line !== '').join('\n');
}

/**
 * Format a simple info panel for batch operations
 * @param targetMap Map of targets to their DPS values
 * @param totalThreads Total threads used
 * @param totalDps Total dollars per second
 * @returns Formatted panel string
 */
export function formatBatchInfoPanel(
    targetMap: Map<string, number>,
    totalThreads: number,
    totalDps: number
): string {
    const rows = Array.from(targetMap.entries()).map(
        ([target, dps]) => `${target.padEnd(15)} ${formatMoney(dps)}/s`
    );

    rows.push(`Total Income: ${formatMoney(totalDps)}/s`);
    rows.push(`Total Threads: ${totalThreads}`);

    return createStatusPanel('BATCH INFO', rows);
}

/**
 * Format a RAM status panel
 * @param totalRam Total RAM in GB
 * @param freeRam Free RAM in GB
 * @param homeFreeRam Home free RAM in GB
 * @param homeReserved Home reserved RAM in GB 
 * @param ramViolated Whether RAM reservation is violated
 * @returns Formatted panel string
 */
export function formatRamStatusPanel(
    totalRam: number,
    freeRam: number,
    homeFreeRam: number,
    homeReserved: number,
    ramViolated: boolean
): string {
    const rows = [
        `Total RAM:   ${formatRamGb(totalRam)}`,
        `Free RAM:    ${formatRamGb(freeRam)}`,
        `Home Free:   ${formatRamGb(homeFreeRam)}`,
        `Home Resvd:  ${formatRamGb(homeReserved)}`,
        `Status:      ${ramViolated ? 'VIOLATED ⚠️' : 'HEALTHY ✓'}`
    ];

    return createStatusPanel('RAM STATUS', rows);
} 