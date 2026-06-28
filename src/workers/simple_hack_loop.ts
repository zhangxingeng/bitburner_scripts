import { NS } from '@ns';

/**
 * Simple H→W→G→W loop. Target is passed as argument (strategy_agent picks it).
 * Stripped of BFS target-finding to save ~0.5 GB RAM (no ns.scan, no ns.getServer).
 *
 * Usage:
 *   run /workers/simple_hack_loop.js n00dles
 *   run /workers/simple_hack_loop.js foodnstuff --tail
 */

export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string | undefined;
    if (!target) {
        ns.tprint('ERROR: specify target server as first argument');
        return;
    }

    ns.print(`Starting H→W→G→W loop on ${target}`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        // HACK — steal money (0.1 GB, +security 0.002/thread)
        const stolen = await ns.hack(target);
        ns.print(`[HACK] ${target}: $${stolen}`);
        await ns.sleep(200);

        // WEAKEN — counter hack security (0.15 GB, -security)
        await ns.weaken(target);
        await ns.sleep(200);

        // GROW — restore money (0.15 GB, +security 0.004/thread)
        await ns.grow(target);
        await ns.sleep(200);

        // WEAKEN — counter grow security (0.15 GB, -security)
        await ns.weaken(target);
        await ns.sleep(200);
    }
}
