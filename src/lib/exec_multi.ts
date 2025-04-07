import { NS } from '@ns';

/**
 * Execute a script with multiple threads on a target server
 * @param ns NS object 
 * @param host Host to run script on
 * @param threads Number of threads to run
 * @param scriptPath Path to the script
 * @param args Script arguments
 * @returns Process ID of the executed script
 */
export function execMulti(
    ns: NS,
    host: string,
    threads: number,
    scriptPath: string,
    ...args: (string | number | boolean)[]
): number {
    // Validate inputs
    if (!ns.serverExists(host)) {
        ns.print(`Host does not exist: ${host}`);
        return 0;
    }

    if (!ns.fileExists(scriptPath)) {
        ns.print(`Script does not exist: ${scriptPath}`);
        return 0;
    }

    // Make sure we have enough RAM
    const scriptRam = ns.getScriptRam(scriptPath);
    const availableRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    const maxThreads = Math.floor(availableRam / scriptRam);

    if (maxThreads < 1) {
        ns.print(`Not enough RAM on ${host} to run ${scriptPath}`);
        return 0;
    }

    // Adjust threads if needed
    const actualThreads = Math.min(threads, maxThreads);
    if (actualThreads < 1) {
        return 0;
    }

    // Copy script to target host if needed
    if (host !== 'home' && !ns.fileExists(scriptPath, host)) {
        const copied = ns.scp(scriptPath, host, 'home');
        if (!copied) {
            ns.print(`Failed to copy ${scriptPath} to ${host}`);
            return 0;
        }
    }

    // Execute script
    return ns.exec(scriptPath, host, actualThreads, ...args);
}

/**
 * Distribute script execution across multiple servers
 * @param ns NS object
 * @param scriptPath Path to the script
 * @param totalThreads Total threads needed
 * @param serverAllocation Thread allocation map (server index -> thread count)
 * @param serverList List of servers (index corresponds to allocation map)
 * @param args Script arguments
 * @returns Total number of threads successfully executed
 */
export function distributeExecution(
    ns: NS,
    scriptPath: string,
    totalThreads: number,
    serverAllocation: number[],
    serverList: string[],
    ...args: (string | number | boolean)[]
): number {
    let executedThreads = 0;

    // Execute on each server according to allocation
    for (let i = 0; i < serverAllocation.length; i++) {
        const threads = serverAllocation[i];
        if (threads <= 0) continue;

        const server = serverList[i];
        const pid = execMulti(ns, server, threads, scriptPath, ...args);

        if (pid > 0) {
            executedThreads += threads;
        }
    }

    return executedThreads;
}

/**
 * Auto-kill and restart a script with multiple threads
 * @param ns NS object
 * @param host Host to run script on
 * @param threads Number of threads to run
 * @param scriptPath Path to the script
 * @param args Script arguments
 * @returns Process ID of the executed script
 */
export function execMultiAutoKill(
    ns: NS,
    host: string,
    threads: number,
    scriptPath: string,
    ...args: (string | number | boolean)[]
): number {
    // Kill existing instances
    if (ns.scriptRunning(scriptPath, host)) {
        ns.scriptKill(scriptPath, host);
    }

    // Execute the script
    return execMulti(ns, host, threads, scriptPath, ...args);
}

/**
 * Get maximum threads for a script on a server
 * @param ns NS object
 * @param host Host to check
 * @param scriptPath Path to the script
 * @returns Maximum number of threads possible
 */
export function getMaxThreads(ns: NS, host: string, scriptPath: string): number {
    const scriptRam = ns.getScriptRam(scriptPath);
    const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    return Math.floor(freeRam / scriptRam);
} 