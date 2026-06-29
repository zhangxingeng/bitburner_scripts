import { NS } from '@ns';
import { getPaths } from '../lib/servers';
import { traverse } from '../lib/connect';


/** Navigate to a server by name or regex pattern.
 * Usage: run /player/goto.js <target>
 */
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
    }
}
