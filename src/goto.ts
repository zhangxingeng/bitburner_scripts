import { NS } from '@ns';
import { getPaths, traverse } from './utils';


/** @param {NS} ns */
export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;
    const paths = getPaths(ns, target);
    if (paths.size === 0) {
        ns.tprint(`No server with regex ${target} found`);
        return;
    } else if (paths.size === 1) {
        const path = paths.values().next().value!;
        traverse(ns, path);
    } else {
        ns.tprint(`Multiple servers found with regex ${target}`);
        for (const path of paths.values()) {
            ns.tprint(path.join(' -> '));
        }
        return;
    }


}