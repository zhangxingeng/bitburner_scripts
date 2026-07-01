import type { NS } from '@ns';
import { findAllPaths } from './net_scan';
import { checkOwnSF } from './sf_check';

/** Connect through a server path. Throws if any hop fails or SF4 is absent. */
export function traverse(ns: NS, path: string[]): boolean {
    if (!checkOwnSF(ns, 4)) throw new Error('traverse: SF4 required for ns.singularity.connect');
    if (ns.getHostname() !== path[0]) throw new Error(`invalid path start: expected ${path[0]}, at ${ns.getHostname()}`);
    for (const server of path.slice(1)) {
        if (!ns.singularity.connect(server)) {
            throw new Error(`Failed to connect to ${server}`);
        }
    }
    return ns.getHostname() === path.at(-1);
}

/** Auto-connect to a target server by finding its path. Throws if SF4 is absent. */
export function autoConnect(ns: NS, target: string): void {
    if (!checkOwnSF(ns, 4)) throw new Error('autoConnect: SF4 required for ns.singularity.connect');
    const path = findAllPaths(ns).get(target);
    if (!path) throw new Error(`Server not found: ${target}`);
    for (const server of path.slice(1)) {
        ns.singularity.connect(server);
    }
}
