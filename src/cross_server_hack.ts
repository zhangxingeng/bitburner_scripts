import { NS } from '@ns';
import { findAllServers, formatMoney, formatTime, scanAndNuke } from './utils';

/**
 * Main function for a simple hacking script that targets the most profitable server
 * and systematically weakens, grows, and hacks it.
 * 
 * @param {NS} ns - Netscript API
 */
export async function main(ns: NS): Promise<void> {
    // Disable logs to reduce spam
    ns.disableLog('ALL');
    ns.enableLog('hack');

    // Open the tail window to display status
    ns.ui.openTail();

    // Track performance metrics
    let totalMoneyHacked = 0;
    let totalSuccessfulHacks = 0;
    const startTime = Date.now();

    // Initialize variables for tick-based approach
    let tick = 1;
    const ROOT_ATTEMPT_INTERVAL = 10; // Every 10 ticks
    const STATUS_UPDATE_INTERVAL = 5; // Every 5 ticks
    const TARGET_SELECT_INTERVAL = 10; // Every 10 ticks
    const CYCLE_INTERVAL = 1000; // 1 second per tick

    // Initialize target to null - we'll select one soon
    let currentTarget: string | null = null;
    let servers = new Set<string>(['home']); // Start with home at minimum

    // Main loop with tick-based management
    while (true) {
        try {
            // Scan and attempt to gain root access periodically
            if (tick % ROOT_ATTEMPT_INTERVAL === 0) {
                ns.print('Scanning network for new targets...');
                servers = scanAndNuke(ns);
            }

            // Select or update target periodically
            if (tick % TARGET_SELECT_INTERVAL === 0 || currentTarget === null) {
                currentTarget = getTargetServer(ns, Array.from(servers));
                if (currentTarget) {
                    ns.print(`Selected target: ${currentTarget}`);
                } else {
                    ns.print('No suitable target found. Will try again soon.');
                    await ns.sleep(CYCLE_INTERVAL);
                    tick++;
                    continue;
                }
            }

            // Main hacking logic - only proceed if we have a target
            if (currentTarget) {
                const hackResult = await executeOptimalAction(ns, currentTarget);

                // Update metrics based on action
                if (hackResult.action === 'hack' && hackResult.success) {
                    totalMoneyHacked += hackResult.amount || 0;
                    totalSuccessfulHacks++;
                }
            }

            // Display status periodically
            if (tick % STATUS_UPDATE_INTERVAL === 0 && currentTarget) {
                displayHackingStatus(ns, currentTarget, totalMoneyHacked, totalSuccessfulHacks, startTime);
            }

        } catch (error) {
            ns.print(`ERROR: ${String(error)}`);
        }

        // Wait for next tick
        await ns.sleep(CYCLE_INTERVAL);
        tick++;
    }
}

/**
 * Execute the most optimal action (weaken/grow/hack) based on current server conditions
 * @param {NS} ns - Netscript API
 * @param {string} target - Target server
 * @returns {Promise<{action: string, success: boolean, amount?: number}>} Action result
 */
async function executeOptimalAction(
    ns: NS,
    target: string
): Promise<{ action: string, success: boolean, amount?: number }> {
    const serverMoney = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const securityLevel = ns.getServerSecurityLevel(target);
    const minSecurityLevel = ns.getServerMinSecurityLevel(target);

    // Decide what action to take based on server conditions
    if (securityLevel > minSecurityLevel + 5) {
        // Security too high - weaken first
        const threads = calculateWeakenThreads(ns, target, securityLevel, minSecurityLevel);
        if (threads > 0) {
            const success = runScript(ns, 'remote/weaken.js', target, threads);
            ns.print(`Weakening ${target} with ${threads} threads`);
            return { action: 'weaken', success };
        }
    }
    else if (serverMoney < maxMoney * 0.8) {
        // Money too low - grow next
        const threads = calculateGrowThreads(ns, target, serverMoney, maxMoney);
        if (threads > 0) {
            const success = runScript(ns, 'remote/grow.js', target, threads);
            ns.print(`Growing ${target} with ${threads} threads`);
            return { action: 'grow', success };
        }
    }
    else {
        // Conditions optimal - hack
        const threads = calculateHackThreads(ns, target);
        if (threads > 0) {
            const success = runScript(ns, 'remote/hack.js', target, threads);
            const hackAmount = serverMoney * ns.hackAnalyze(target) * threads;
            ns.print(`Hacking ${target} with ${threads} threads`);
            return { action: 'hack', success, amount: hackAmount };
        }
    }

    // Default return if no action was taken
    return { action: 'none', success: false };
}

/**
 * Display a dashboard with hacking status and target information
 * 
 * @param {NS} ns - Netscript API
 * @param target - Current target server
 * @param totalMoneyHacked - Total money hacked so far
 * @param totalSuccessfulHacks - Total successful hacks
 * @param startTime - Time when the script started
 */
function displayHackingStatus(
    ns: NS,
    target: string,
    totalMoneyHacked: number,
    totalSuccessfulHacks: number,
    startTime: number
): void {
    ns.clearLog();

    // Calculate runtime
    const runTime = (Date.now() - startTime) / 1000;
    const runtimeFormatted = formatTime(runTime);

    // Get server information
    let maxMoney = 0;
    let currentMoney = 0;
    let moneyPercentage = '0.00';
    let minSecurity = 0;
    let currentSecurity = 0;
    let securityDifference = '0.00';
    let hackChance = 0;
    let hackTime = '0s';
    let growTime = '0s';
    let weakenTime = '0s';

    try {
        // Get server stats if target exists
        if (target) {
            maxMoney = ns.getServerMaxMoney(target);
            currentMoney = ns.getServerMoneyAvailable(target);
            moneyPercentage = (currentMoney / maxMoney * 100).toFixed(2);

            minSecurity = ns.getServerMinSecurityLevel(target);
            currentSecurity = ns.getServerSecurityLevel(target);
            securityDifference = (currentSecurity - minSecurity).toFixed(2);

            hackChance = ns.hackAnalyzeChance(target) * 100;

            hackTime = formatTime(ns.getHackTime(target) / 1000);
            growTime = formatTime(ns.getGrowTime(target) / 1000);
            weakenTime = formatTime(ns.getWeakenTime(target) / 1000);
        }
    } catch { /* ignore errors */ }

    // Calculate profit per second
    const profitPerSecond = runTime > 0 ? totalMoneyHacked / runTime : 0;

    // Display header
    ns.print(`=== HACKING DASHBOARD (Runtime: ${runtimeFormatted}) ===\n`);

    // Target information section
    ns.print(`TARGET: ${target}`);
    ns.print(`Money: ${formatMoney(currentMoney)} / ${formatMoney(maxMoney)} (${moneyPercentage}%)`);
    ns.print(`Security: ${currentSecurity.toFixed(2)} (${securityDifference} above min of ${minSecurity})`);
    ns.print(`Hack Chance: ${hackChance.toFixed(2)}%`);

    // Action times
    ns.print('\nACTION TIMES:');
    ns.print(`Hack: ${hackTime} | Grow: ${growTime} | Weaken: ${weakenTime}`);

    // Performance metrics
    ns.print('\nPERFORMANCE METRICS:');
    ns.print(`Total money hacked: ${formatMoney(totalMoneyHacked)}`);
    ns.print(`Successful hacks: ${totalSuccessfulHacks}`);
    ns.print(`Average profit per hack: ${formatMoney(totalSuccessfulHacks > 0 ? totalMoneyHacked / totalSuccessfulHacks : 0)}`);
    ns.print(`Profit per second: ${formatMoney(profitPerSecond)}/sec`);

    // Player information
    const player = ns.getPlayer();
    ns.print('\nPLAYER STATS:');
    ns.print(`Hacking Level: ${player.skills.hacking}`);
    ns.print(`Money: ${formatMoney(ns.getServerMoneyAvailable('home'))}`);

    // Current action
    ns.print('\nCURRENT ACTION:');
    if (currentSecurity > minSecurity + 5) {
        ns.print(`Weakening ${target} (Security too high: ${currentSecurity.toFixed(2)} > ${minSecurity})`);
    } else if (currentMoney < maxMoney * 0.8) {
        ns.print(`Growing ${target} (Money too low: ${moneyPercentage}% of max)`);
    } else {
        ns.print(`Hacking ${target} (Conditions optimal)`);
    }
}

/**
 * Get the best target server for hacking based on calculated weights
 * 
 * @param {NS} ns - Netscript API
 * @param {string[]} servers - List of accessible servers
 * @returns Name of the best target server
 */
function getTargetServer(ns: NS, servers: string[]): string {
    // Filter for hackable servers with money
    const targets = servers.filter(server =>
        ns.hasRootAccess(server) &&
        ns.getServerMaxMoney(server) > 0 &&
        ns.getPlayer().skills.hacking >= ns.getServerRequiredHackingLevel(server)
    );

    if (targets.length === 0) return '';

    // Sort servers by weight
    return targets.sort((a, b) => {
        const weightA = calculateServerWeight(ns, a);
        const weightB = calculateServerWeight(ns, b);
        return weightB - weightA; // Descending order
    })[0];
}

/**
 * Calculate a weight score for a server to determine its hack value
 * 
 * @param {NS} ns - Netscript API
 * @param server - Server name
 * @returns Numeric weight score (higher is better)
 */
function calculateServerWeight(ns: NS, server: string): number {
    if (!server) return 0;
    if (server.startsWith('hacknet-node')) return 0;

    const player = ns.getPlayer();
    const serverObj = ns.getServer(server);

    // Skip servers we can't hack yet
    if (!serverObj.requiredHackingSkill || serverObj.requiredHackingSkill > player.skills.hacking) return 0;

    // Early game weight calculation - simpler to save RAM
    const serverMoney = ns.getServerMaxMoney(server);
    const hackChance = ns.hackAnalyzeChance(server);

    // Factor in hack success chance, money, and time
    return (serverMoney / ns.getWeakenTime(server)) * hackChance;
}

/**
 * Calculate the number of threads needed to weaken a server to the desired security level
 * 
 * @param {NS} ns - Netscript API
 * @param target - Target server name
 * @param currentSecurity - Current security level
 * @param targetSecurity - Target security level
 * @returns Number of threads needed
 */
function calculateWeakenThreads(ns: NS, target: string, currentSecurity: number, targetSecurity: number): number {
    return Math.ceil((currentSecurity - targetSecurity) / ns.weakenAnalyze(1));
}

/**
 * Calculate the number of threads needed to grow a server to the desired money level
 * 
 * @param {NS} ns - Netscript API
 * @param target - Target server name
 * @param currentMoney - Current money available
 * @param targetMoney - Target money level
 * @returns Number of threads needed
 */
function calculateGrowThreads(ns: NS, target: string, currentMoney: number, targetMoney: number): number {
    // Prevent division by zero
    if (currentMoney <= 0) currentMoney = 1;
    return Math.ceil(ns.growthAnalyze(target, targetMoney / currentMoney));
}

/**
 * Calculate the number of threads needed to hack money from a server
 * 
 * @param {NS} ns - Netscript API
 * @param target - Target server name
 * @returns Number of threads needed
 */
function calculateHackThreads(ns: NS, target: string): number {
    // For early game, we'll hack with a percentage of money instead of all
    const hackFraction = 0.5; // Hack 50% of money
    const hackPerThread = ns.hackAnalyze(target);

    // Calculate threads needed for the desired fraction
    return Math.max(1, Math.floor(hackFraction / hackPerThread));
}

/**
 * Run a script with the specified number of threads across available servers
 * 
 * @param {NS} ns - Netscript API
 * @param scriptName - Name of the script to run
 * @param target - Target server name to pass to the script
 * @param threads - Number of threads to run
 * @returns {boolean} True if script was started successfully
 */
function runScript(ns: NS, scriptName: string, target: string, threads: number): boolean {
    if (threads <= 0) return false;

    // Get all servers with root access that can run scripts
    const allServers = findAllServers(ns)
        .filter((server: string) => ns.hasRootAccess(server) && ns.getServerMaxRam(server) > 0);

    const ramPerThread = ns.getScriptRam(scriptName);
    let threadsRemaining = threads;

    // Distribute script across available servers
    for (const server of allServers) {
        if (threadsRemaining <= 0) break;

        // Use less RAM on home to keep it available for other scripts
        const maxRam = server === 'home'
            ? Math.floor(ns.getServerMaxRam(server) * 0.7) // Use 70% of home RAM
            : ns.getServerMaxRam(server);

        const availableRam = maxRam - ns.getServerUsedRam(server);
        let possibleThreads = Math.floor(availableRam / ramPerThread);

        if (possibleThreads <= 0) continue;

        // Use only as many threads as needed
        possibleThreads = Math.min(possibleThreads, threadsRemaining);

        // Copy script to server if not home
        if (server !== 'home') {
            ns.scp(scriptName, server);
        }

        // Run the script
        const pid = ns.exec(scriptName, server, possibleThreads, target);
        if (pid > 0) {
            threadsRemaining -= possibleThreads;
        }
    }

    // Return true if all threads were allocated
    return threadsRemaining === 0;
}
