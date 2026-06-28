import { NS } from '@ns';
import { ensureScriptExists } from '../lib/script';

/**
 * Execute a script with multiple threads on a host server.
 * Moved from engine/exec_multi.ts.
 *
 * Automatically adjusts thread count if the host has insufficient RAM.
 */
export function execMulti(
    ns: NS,
    host: string,
    threads: number,
    scriptPath: string,
    ...args: (string | number | boolean)[]
): number {
    if (!ns.serverExists(host)) {
        ns.print(`Host does not exist: ${host}`);
        return 0;
    }

    if (!ns.fileExists(scriptPath)) {
        ns.print(`Script does not exist: ${scriptPath}`);
        return 0;
    }

    const scriptRam = ns.getScriptRam(scriptPath);
    const availableRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    const maxThreads = Math.floor(availableRam / scriptRam);

    if (maxThreads < 1) return 0;

    const actualThreads = Math.min(threads, maxThreads);
    if (actualThreads < 1) return 0;

    // Copy script to remote host if not already present
    if (host !== 'home' && !ns.fileExists(scriptPath, host)) {
        if (!ns.scp(scriptPath, host, 'home')) {
            ns.print(`Failed to copy ${scriptPath} to ${host}`);
            return 0;
        }
    }

    return ns.exec(scriptPath, host, actualThreads, ...args);
}

/**
 * Kill any existing instance of a script on a host, then restart it.
 */
export function execMultiAutoKill(
    ns: NS,
    host: string,
    threads: number,
    scriptPath: string,
    ...args: (string | number | boolean)[]
): number {
    if (ns.scriptRunning(scriptPath, host)) {
        ns.scriptKill(scriptPath, host);
    }
    return execMulti(ns, host, threads, scriptPath, ...args);
}

/**
 * Distribute script execution across multiple servers according to a per-server thread allocation.
 * Returns the total number of threads successfully executed.
 */
export function distributeExecution(
    ns: NS,
    scriptPath: string,
    totalThreads: number,
    serverAllocation: number[],
    serverList: string[],
    ...args: (string | number | boolean)[]
): number {
    if (totalThreads <= 0) return 0;

    let executedThreads = 0;
    for (let i = 0; i < serverAllocation.length; i++) {
        const threads = serverAllocation[i];
        if (threads <= 0) continue;

        const server = serverList[i];
        ensureScriptExists(ns, scriptPath, server);

        const pid = execMulti(ns, server, threads, scriptPath, ...args);
        if (pid > 0) {
            executedThreads += threads;
        }
    }
    return executedThreads;
}

/** Maximum threads a script can run on a server given its current free RAM. */
export function getMaxThreads(ns: NS, host: string, scriptPath: string): number {
    const scriptRam = ns.getScriptRam(scriptPath);
    const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
    return Math.floor(freeRam / scriptRam);
}
