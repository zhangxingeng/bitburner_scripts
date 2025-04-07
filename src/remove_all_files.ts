import { NS } from '@ns';
import { findAllPaths, traverse } from './lib/utils';

export async function main(ns: NS): Promise<void> {
    const deleteAll = ns.args[0] === 'all';
    let deletedCount = 0;

    if (deleteAll) {
        // Get all server paths
        const serverPaths = findAllPaths(ns);

        for (const [target, path] of serverPaths) {
            try {
                // Traverse to the target server
                traverse(ns, path);

                // Get all files on the current server
                const allFiles = ns.ls(target);
                for (const file of allFiles) {
                    if (file === ns.getScriptName()) continue;
                    if (file.endsWith('.js') || file.includes('/')) {
                        const success = ns.rm(file, target);
                        if (success) deletedCount++;
                    }
                }

                // Return home after processing each server
                ns.singularity.connect('home');
            } catch (error) {
                ns.print(`ERROR on ${target}: ${String(error)}`);
                // Try to return home if something goes wrong
                ns.singularity.connect('home');
            }
        }
    } else {
        // Just process the home server
        const allFiles = ns.ls('home');
        for (const file of allFiles) {
            if (file === ns.getScriptName()) continue;
            if (file.endsWith('.js') || file.includes('/')) {
                const success = ns.rm(file);
                if (success) deletedCount++;
            }
        }
    }

    ns.print(`Cleanup complete. Deleted ${deletedCount} files.`);
    const remainingFiles = ns.ls('home');
    ns.print(`Remaining file count on home: ${remainingFiles.length}`);
}