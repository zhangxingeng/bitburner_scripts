import { NS } from '@ns';

/**
 * Copies scripts to target servers
 * @param {NS} ns - Netscript API
 * @param {string[]} scripts - Array of script names to copy
 * @param {string} fromServer - Source server
 * @param {string[]} targetList - Array of target servers
 * @returns {boolean} True if all scripts were copied successfully, false otherwise
 */
export function copyScripts(ns: NS, scripts: string[], fromServer: string, targetList: string[]): boolean {
    // first check if all scripts exist on fromServer
    const missingScripts = scripts.filter(script => !ns.fileExists(script, fromServer));
    if (missingScripts.length > 0) {
        throw new Error(`Missing scripts on ${fromServer}: ${missingScripts.join(', ')}`);
    }
    for (const target of targetList) {
        if (ns.getServerMaxRam(target) < 2) { return false; }
        const copyResult = ns.scp(scripts, target, fromServer);
        if (!copyResult) {
            throw new Error(`Failed to copy ${scripts.join(', ')} to ${target} from ${fromServer}`);
        }
    }
    return true;
}

/**
 * Copy a batch script to a target server if it doesn't exist
 * @param {NS} ns - Netscript API
 * @param {string} script - Script path
 * @param {string} targetServer - Target server
 * @returns {boolean} - Whether the script exists on the target server
 */
export function ensureScriptExists(ns: NS, script: string, targetServer: string): boolean {
    if (!ns.fileExists(script, targetServer)) {
        return ns.scp(script, targetServer, 'home');
    }
    return true;
}

/**
 * Distribute a batch of threads across available servers
 * @param {NS} ns - Netscript API
 * @param {string} script - Script to run
 * @param {number} threads - Total threads needed
 * @param {ServerHost[]} servers - Available servers with free RAM
 * @param {any[]} args - Script arguments
 * @returns {boolean} - Whether all threads were successfully distributed
 */
export function distributeThreads(
    ns: NS,
    script: string,
    threads: number,
    servers: { host: string, freeRam: number }[],
    ...args: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
): boolean {
    if (threads <= 0) return true;

    const scriptRam = ns.getScriptRam(script);
    let remainingThreads = threads;

    // Sort servers by free RAM (descending)
    const sortedServers = [...servers].sort((a, b) => b.freeRam - a.freeRam);

    for (const server of sortedServers) {
        if (remainingThreads <= 0) break;

        // Calculate how many threads we can run on this server
        const maxThreads = Math.floor(server.freeRam / scriptRam);
        if (maxThreads <= 0) continue;

        const threadsToRun = Math.min(maxThreads, remainingThreads);

        // Copy script if needed
        if (!ensureScriptExists(ns, script, server.host)) {
            continue;
        }

        // Run the script
        const pid = ns.exec(script, server.host, threadsToRun, ...args);

        if (pid > 0) {
            remainingThreads -= threadsToRun;
            server.freeRam -= threadsToRun * scriptRam;
        }
    }

    return remainingThreads === 0;
}

