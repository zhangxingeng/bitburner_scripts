import { NS } from '@ns';
import { getPaths } from './lib/util_normal_ram';
import { traverse } from './lib/util_high_ram';


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