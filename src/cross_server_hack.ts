import { NS } from '@ns';
import { executeCommand } from './basic/simple_through_file';
import { formatMoney, formatTime } from './lib/util_low_ram';

/**
 * Main function for a simple hacking script that targets the most profitable server
 * and systematically weakens, grows, and hacks it.
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
    const ROOT_ATTEMPT_INTERVAL = 20;
    const STATUS_UPDATE_INTERVAL = 10;
    const TARGET_SELECT_INTERVAL = 10;
    const CYCLE_INTERVAL = 200;

    // Initialize target to null - we'll select one soon
    let currentTarget: string | null = null;
    let noTargetFoundCount = 0;

    // Simple mode for very early game
    const earlygameMode = ns.getPlayer().skills.hacking < 50;
    let lastActionTime = 0;
    const MIN_ACTION_INTERVAL = 5000; // Minimum 5 seconds between actions in early game

    // Main loop with tick-based management
    while (true) {
        try {
            // Scan and attempt to gain root access periodically
            if (tick % ROOT_ATTEMPT_INTERVAL === 0) {
                try {
                    ns.exec('/lib/scan_nuke.js', 'home');
                } catch (error) {
                    ns.print(`Error scanning: ${String(error)}`);
                }
            }

            // Select or update target periodically
            if (tick % TARGET_SELECT_INTERVAL === 0 || currentTarget === null) {
                currentTarget = await getTargetServer(ns);
                if (currentTarget) {
                    ns.print(`Selected target: ${currentTarget}`);
                    noTargetFoundCount = 0;
                } else {
                    noTargetFoundCount++;
                    await ns.sleep(CYCLE_INTERVAL);
                    tick++;
                    continue;
                }
            }

            // Main hacking logic - only proceed if we have a target
            if (currentTarget) {
                // Check if we should wait between operations
                const now = Date.now();
                const timeSinceLastAction = now - lastActionTime;

                if (earlygameMode && timeSinceLastAction < MIN_ACTION_INTERVAL) {
                    // Wait for the minimum interval between actions in early game
                    await ns.sleep(MIN_ACTION_INTERVAL - timeSinceLastAction);
                    tick++;
                    continue;
                }

                const hackResult = await executeOptimalAction(ns, currentTarget);

                // Update the last action time
                lastActionTime = Date.now();

                // Update metrics based on action
                if (hackResult.action === 'hack' && hackResult.success) {
                    totalMoneyHacked += hackResult.amount || 0;
                    totalSuccessfulHacks++;
                }

                // In early game, wait longer after each action to allow time for operations to complete
                if (earlygameMode && hackResult.success) {
                    if (hackResult.action === 'weaken') {
                        await ns.sleep(MIN_ACTION_INTERVAL * 2);
                    } else if (hackResult.action === 'grow') {
                        await ns.sleep(MIN_ACTION_INTERVAL);
                    } else {
                        await ns.sleep(MIN_ACTION_INTERVAL / 2);
                    }
                }
            }

            // Display status periodically
            if (tick % STATUS_UPDATE_INTERVAL === 0) {
                if (currentTarget) {
                    displayHackingStatus(ns, currentTarget, totalMoneyHacked, totalSuccessfulHacks, startTime);
                } else {
                    // Display minimal status when no target is available
                    ns.clearLog();
                    ns.print(`=== HACKING DASHBOARD (Runtime: ${formatTime((Date.now() - startTime) / 1000)}) ===\n`);
                    ns.print('STATUS: Searching for viable targets...');
                    ns.print(`Hacking Level: ${ns.getPlayer().skills.hacking}`);
                }
            }
        } catch (error) {
            ns.print(`Error in main loop: ${String(error)}`);
        }

        // Wait for next tick
        await ns.sleep(CYCLE_INTERVAL);
        tick++;
    }
}

/**
 * Execute the most optimal action (weaken/grow/hack) based on current server conditions
 */
async function executeOptimalAction(
    ns: NS,
    target: string
): Promise<{ action: string, success: boolean, amount?: number }> {
    try {
        const serverMoney = await executeCommand<number>(ns, `ns.getServerMoneyAvailable("${target}")`);
        const maxMoney = await executeCommand<number>(ns, `ns.getServerMaxMoney("${target}")`);
        const securityLevel = await executeCommand<number>(ns, `ns.getServerSecurityLevel("${target}")`);
        const minSecurityLevel = await executeCommand<number>(ns, `ns.getServerMinSecurityLevel("${target}")`);

        // Decide what action to take based on server conditions
        if (securityLevel > minSecurityLevel + 5) {
            // Security too high - weaken first
            const threads = await calculateWeakenThreads(ns, target);

            if (threads > 0) {
                const success = await runScript(ns, 'remote/weaken.js', target, threads);
                ns.print(`Weakening ${target} with ${threads} threads`);
                return { action: 'weaken', success };
            }
        }
        else if (serverMoney < maxMoney * 0.8) {
            // Money too low - grow next
            const threads = await calculateGrowThreads(ns, target);

            if (threads > 0) {
                const success = await runScript(ns, 'remote/grow.js', target, threads);
                ns.print(`Growing ${target} with ${threads} threads`);
                return { action: 'grow', success };
            }
        }
        else {
            // Conditions optimal - hack
            const threads = await calculateHackThreads(ns, target, 0.5);

            if (threads > 0) {
                const success = await runScript(ns, 'remote/hack.js', target, threads);
                const hackAmount = serverMoney * await executeCommand<number>(ns, `ns.hackAnalyze("${target}")`);
                ns.print(`Hacking ${target} with ${threads} threads`);
                return { action: 'hack', success, amount: hackAmount * threads };
            }
        }
    } catch (error) {
        ns.print(`Error in executeOptimalAction: ${String(error)}`);
    }

    // Default return if no action was taken
    return { action: 'none', success: false };
}

/**
 * Calculate threads needed for a weaken operation to reach min security
 */
async function calculateWeakenThreads(ns: NS, target: string): Promise<number> {
    const currentSecurity = await executeCommand<number>(ns, `ns.getServerSecurityLevel("${target}")`);
    const minSecurity = await executeCommand<number>(ns, `ns.getServerMinSecurityLevel("${target}")`);
    const securityDiff = Math.max(0, currentSecurity - minSecurity);
    const weakenAmount = await executeCommand<number>(ns, 'ns.weakenAnalyze(1)');
    return Math.ceil(securityDiff / weakenAmount);
}

/**
 * Calculate threads needed for a grow operation to reach max money
 */
async function calculateGrowThreads(ns: NS, target: string): Promise<number> {
    const currentMoney = Math.max(1, await executeCommand<number>(ns, `ns.getServerMoneyAvailable("${target}")`));
    const maxMoney = await executeCommand<number>(ns, `ns.getServerMaxMoney("${target}")`);
    const growthFactor = maxMoney / currentMoney;
    return Math.ceil(await executeCommand<number>(ns, `ns.growthAnalyze("${target}", ${growthFactor})`));
}

/**
 * Calculate threads needed for a hack operation
 */
async function calculateHackThreads(ns: NS, target: string, hackFraction: number = 0.5): Promise<number> {
    const hackPerThread = await executeCommand<number>(ns, `ns.hackAnalyze("${target}")`);
    return Math.max(1, Math.floor(hackFraction / hackPerThread));
}

/**
 * Display a dashboard with hacking status and target information
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
    ns.print('\nPLAYER STATS:');
    ns.print(`Hacking Level: ${ns.getPlayer().skills.hacking}`);
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
 */
async function getTargetServer(ns: NS): Promise<string> {
    try {
        // Get all servers
        const servers = await getAllServers(ns);

        // Filter for hackable servers with money
        const targets: string[] = [];
        const hackingLevel = ns.getPlayer().skills.hacking;

        // Early game mode - if hacking level is very low, just return 'n00dles' if we have access
        if (hackingLevel < 10) {
            for (const server of servers) {
                if (server === 'n00dles') {
                    const hasRoot = await executeCommand<boolean>(ns, `ns.hasRootAccess("${server}")`);
                    if (hasRoot) {
                        return 'n00dles';
                    }
                    break;
                }
            }
        }

        // Regular target selection
        for (const server of servers) {
            try {
                const hasRoot = await executeCommand<boolean>(ns, `ns.hasRootAccess("${server}")`);
                if (!hasRoot) continue;

                const maxMoney = await executeCommand<number>(ns, `ns.getServerMaxMoney("${server}")`);
                if (maxMoney <= 0) continue;

                const reqHackLevel = await executeCommand<number>(ns, `ns.getServerRequiredHackingLevel("${server}")`);
                if (hackingLevel >= reqHackLevel) {
                    targets.push(server);
                }
            } catch (error) {
                ns.print(`Error checking server ${server}: ${String(error)}`);
            }
        }

        if (targets.length === 0) {
            // If no valid targets, try to find any server we can hack even with no money
            for (const server of servers) {
                try {
                    if (server === 'home') continue;

                    const hasRoot = await executeCommand<boolean>(ns, `ns.hasRootAccess("${server}")`);
                    const reqHackLevel = await executeCommand<number>(ns, `ns.getServerRequiredHackingLevel("${server}")`);

                    if (hasRoot && hackingLevel >= reqHackLevel) {
                        return server;
                    }
                } catch (error) {
                    ns.print(`Error checking fallback server ${server}: ${String(error)}`);
                }
            }
            return '';
        }

        // Sort servers by weight
        const targetWeights = [];
        for (const server of targets) {
            try {
                const weight = await calculateServerWeight(ns, server);
                targetWeights.push({ server, weight });
            } catch (error) {
                ns.print(`Error calculating weight for ${server}: ${String(error)}`);
            }
        }

        if (targetWeights.length === 0) {
            return '';
        }

        targetWeights.sort((a, b) => b.weight - a.weight); // Descending order
        return targetWeights[0].server;
    } catch (error) {
        ns.print(`Critical error in getTargetServer: ${String(error)}`);

        // Last resort - try to return any server that might work
        try {
            if (await executeCommand<boolean>(ns, 'ns.hasRootAccess("n00dles")')) {
                return 'n00dles';
            }

            if (await executeCommand<boolean>(ns, 'ns.hasRootAccess("foodnstuff")')) {
                return 'foodnstuff';
            }

            // Try to find any rooted server
            const servers = await getAllServers(ns);
            for (const server of servers) {
                if (server !== 'home' && await executeCommand<boolean>(ns, `ns.hasRootAccess("${server}")`)) {
                    return server;
                }
            }
        } catch (innerError) {
            ns.print(`Failed to find fallback server: ${String(innerError)}`);
        }

        return '';
    }
}

/**
 * Get all servers in the network
 */
async function getAllServers(ns: NS): Promise<string[]> {
    try {
        // This function uses a simple queue-based BFS to find all servers
        const visited = new Set<string>(['home']);
        const queue = ['home'];
        const servers: string[] = ['home'];

        while (queue.length > 0) {
            const current = queue.shift()!;

            try {
                // Get connected servers
                const scanResult = await executeCommand<string>(ns, `JSON.stringify(ns.scan("${current}"))`);
                const connected = JSON.parse(scanResult) as string[];

                for (const server of connected) {
                    if (!visited.has(server)) {
                        visited.add(server);
                        queue.push(server);
                        servers.push(server);
                    }
                }
            } catch (error) {
                ns.print(`Error scanning server ${current}: ${String(error)}`);
            }
        }

        return servers;
    } catch (error) {
        ns.print(`Error in getAllServers: ${String(error)}`);
        return ['home']; // Return at least home if there's an error
    }
}

/**
 * Calculate a weight score for a server to determine its hack value
 */
async function calculateServerWeight(ns: NS, server: string): Promise<number> {
    try {
        if (!server) return 0;
        if (server === 'home') return 0;
        if (server.startsWith('hacknet-node')) return 0;

        // Get server stats using low RAM approach
        const maxMoney = await executeCommand<number>(ns, `ns.getServerMaxMoney("${server}")`);
        if (maxMoney <= 0) return 0;

        const hackChance = await executeCommand<number>(ns, `ns.hackAnalyzeChance("${server}")`);
        if (hackChance <= 0) return 0;

        const weakenTime = await executeCommand<number>(ns, `ns.getWeakenTime("${server}")`);
        if (weakenTime === 0) return 0;

        // Early game modifier: boost weight for servers with higher money and lower security
        const minSecurity = await executeCommand<number>(ns, `ns.getServerMinSecurityLevel("${server}")`);
        const currentSecurity = await executeCommand<number>(ns, `ns.getServerSecurityLevel("${server}")`);
        const securityRatio = minSecurity / Math.max(1, currentSecurity);

        // Calculate basic weight
        let weight = (maxMoney / weakenTime) * hackChance;

        // Very early game (hacking level under 100): prioritize servers with lowest security
        const hackingLevel = ns.getPlayer().skills.hacking;
        if (hackingLevel < 100) {
            // More heavily weight security level in early game
            weight = weight * (securityRatio * 2);

            // Boost beginner servers
            if (server === 'n00dles' || server === 'foodnstuff' || server === 'sigma-cosmetics' || server === 'joesguns') {
                weight *= 10;
            }
        }

        return weight;
    } catch (error) {
        ns.print(`Error calculating weight for ${server}: ${String(error)}`);
        return 0;
    }
}

/**
 * Run a script with the specified number of threads across available servers
 */
async function runScript(ns: NS, scriptName: string, target: string, threads: number): Promise<boolean> {
    try {
        if (threads <= 0) {
            return false;
        }

        // Get all servers with root access that can run scripts
        const allServers = await getAllServers(ns);
        const servers: string[] = [];

        for (const server of allServers) {
            try {
                const hasRoot = await executeCommand<boolean>(ns, `ns.hasRootAccess("${server}")`);
                const maxRam = await executeCommand<number>(ns, `ns.getServerMaxRam("${server}")`);

                if (hasRoot && maxRam > 0) {
                    servers.push(server);
                }
            } catch (error) {
                // Silently continue
            }
        }

        if (servers.length === 0) {
            return false;
        }

        // Check if script exists and get RAM requirement
        if (!ns.fileExists(scriptName, 'home')) {
            return false;
        }

        const ramPerThread = ns.getScriptRam(scriptName);
        let threadsRemaining = threads;
        let anyThreadsAllocated = false;

        // Distribute script across available servers
        for (const server of servers) {
            if (threadsRemaining <= 0) {
                break;
            }

            try {
                // Use less RAM on home to keep it available for other scripts
                const maxRam = server === 'home'
                    ? Math.floor(await executeCommand<number>(ns, `ns.getServerMaxRam("${server}")`) * 0.7) // Use 70% of home RAM
                    : await executeCommand<number>(ns, `ns.getServerMaxRam("${server}")`);

                const usedRam = await executeCommand<number>(ns, `ns.getServerUsedRam("${server}")`);
                const availableRam = maxRam - usedRam;
                let possibleThreads = Math.floor(availableRam / ramPerThread);

                if (possibleThreads <= 0) {
                    continue;
                }

                // Use only as many threads as needed
                possibleThreads = Math.min(possibleThreads, threadsRemaining);

                // Copy script to server if not home
                if (server !== 'home') {
                    try {
                        await ns.scp(scriptName, server);
                    } catch (error) {
                        continue;
                    }
                }

                // Run the script with target as argument
                try {
                    const pid = ns.exec(scriptName, server, possibleThreads, target);

                    if (pid > 0) {
                        threadsRemaining -= possibleThreads;
                        anyThreadsAllocated = true;
                    }
                } catch (error) {
                    // Silently continue
                }
            } catch (error) {
                // Silently continue
            }
        }

        // Return true if ANY threads were allocated (partial success)
        return anyThreadsAllocated;
    } catch (error) {
        ns.print(`Error in runScript: ${String(error)}`);
        return false;
    }
}
