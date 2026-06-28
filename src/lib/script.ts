import type { NS } from '@ns';

/** Copy scripts to all target servers. Throws if any copy fails. */
export function copyScripts(ns: NS, scripts: string[], fromServer: string, targetList: string[]): boolean {
    const missing = scripts.filter(s => !ns.fileExists(s, fromServer));
    if (missing.length > 0) {
        throw new Error(`Missing scripts on ${fromServer}: ${missing.join(', ')}`);
    }
    for (const target of targetList) {
        if (ns.getServerMaxRam(target) < 2) return false;
        if (!ns.scp(scripts, target, fromServer)) {
            throw new Error(`Failed to copy scripts to ${target} from ${fromServer}`);
        }
    }
    return true;
}

/** Copy a script to a target server if it doesn't already exist there. */
export function ensureScriptExists(ns: NS, script: string, targetServer: string): boolean {
    if (!ns.fileExists(script, targetServer)) {
        return ns.scp(script, targetServer, 'home');
    }
    return true;
}

/** Distribute threads across available servers. Returns true if all threads were placed. */
export function distributeThreads(
    ns: NS,
    script: string,
    threads: number,
    servers: { host: string; freeRam: number }[],
    ...args: (string | number | boolean)[]
): boolean {
    if (threads <= 0) return true;

    const scriptRam = ns.getScriptRam(script);
    let remaining = threads;
    const sorted = [...servers].sort((a, b) => b.freeRam - a.freeRam);

    for (const server of sorted) {
        if (remaining <= 0) break;
        const maxThreads = Math.floor(server.freeRam / scriptRam);
        if (maxThreads <= 0) continue;

        const toRun = Math.min(maxThreads, remaining);
        if (!ensureScriptExists(ns, script, server.host)) continue;

        const pid = ns.exec(script, server.host, toRun, ...args);
        if (pid > 0) {
            remaining -= toRun;
            server.freeRam -= toRun * scriptRam;
        }
    }
    return remaining === 0;
}
