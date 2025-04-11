import { NS, SourceFileLvl } from '@ns';
import { findAllPaths } from './util_low_ram';

/**
 * Traverse a path of servers
 * @param ns - Netscript API
 * @param path - Path to traverse
 * @returns True if the path was traversed successfully
 */
export function traverse(ns: NS, path: string[]): boolean {
    if (ns.getHostname() !== path[0]) { throw new Error('invalid path'); }
    for (const server of path.slice(1)) {
        const connected = ns.singularity.connect(server);
        if (!connected) { throw new Error(`Failed to connect to ${server}`); }
    }
    return ns.getHostname() === path.at(-1);
}


/**
 * Automatically connects to a target server
 * @param ns - Netscript API
 * @param target - Target server name
 * @throws Error if server is not found
 */
export async function autoConnect(ns: NS, target: string): Promise<void> {
    const path = (await findAllPaths(ns)).get(target);
    if (!path) throw new Error('Server not found');
    // Connect through each server in the path
    for (const server of path.slice(1)) {
        await ns.singularity.connect(server);
    }
};

export function checkOwnSF(ns: NS, number: number, lvl: number = 0): boolean {
    const sourceFiles = ns.singularity.getOwnedSourceFiles();
    return sourceFiles.some((sf: SourceFileLvl) => sf.n === number && sf.lvl >= lvl);
}