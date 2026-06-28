import type { NS, SourceFileLvl } from '@ns';
import { findAllPaths } from './servers';

/** Connect through a server path. Throws if any hop fails. */
export function traverse(ns: NS, path: string[]): boolean {
    if (ns.getHostname() !== path[0]) throw new Error(`invalid path start: expected ${path[0]}, at ${ns.getHostname()}`);
    for (const server of path.slice(1)) {
        if (!ns.singularity.connect(server)) {
            throw new Error(`Failed to connect to ${server}`);
        }
    }
    return ns.getHostname() === path.at(-1);
}

/** Auto-connect to a target server by finding its path. */
export function autoConnect(ns: NS, target: string): void {
    const path = findAllPaths(ns).get(target);
    if (!path) throw new Error(`Server not found: ${target}`);
    for (const server of path.slice(1)) {
        ns.singularity.connect(server);
    }
}

/** Check whether the player owns a source file at the given level. */
export function checkOwnSF(ns: NS, number: number, lvl = 0): boolean {
    return ns.singularity.getOwnedSourceFiles().some(
        (sf: SourceFileLvl) => sf.n === number && sf.lvl >= lvl,
    );
}
