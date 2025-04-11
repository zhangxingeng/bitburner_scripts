import { NS } from '@ns';

/**
 * A minimal RAM version of the file removal script
 * Only removes files from the current server
 * Doesn't import any external libraries to keep RAM usage low
 */
export async function main(ns: NS): Promise<void> {
    // Disable logs to reduce output noise
    ns.disableLog('ALL');

    // Get current script name to avoid deleting itself
    const currentScript = ns.getScriptName();
    let deletedCount = 0;

    // Process current server only
    const currentServer = ns.getHostname();
    const allFiles = ns.ls(currentServer);

    // Log what we're about to do
    ns.print(`Starting file cleanup on ${currentServer}`);
    ns.print(`Found ${allFiles.length} files, keeping ${currentScript}`);

    // Process each file
    for (const file of allFiles) {
        // Skip the current script to avoid self-deletion
        if (file === currentScript) continue;

        // Only delete .js files and files in subdirectories
        if (file.endsWith('.js') || file.includes('/')) {
            try {
                const success = ns.rm(file);
                if (success) {
                    deletedCount++;
                    // Only print first few deletions to avoid log spam
                    if (deletedCount <= 5) {
                        ns.print(`Deleted: ${file}`);
                    } else if (deletedCount === 6) {
                        ns.print('Additional deletions will not be logged individually...');
                    }
                }
            } catch (error) {
                ns.print(`ERROR deleting ${file}: ${String(error)}`);
            }
        }
    }

    // finally remove the script itself
    ns.rm(currentScript);

    // Summary
    ns.print(`Cleanup complete on ${currentServer}`);
    ns.print(`Deleted ${deletedCount} out of ${allFiles.length} files`);
}
