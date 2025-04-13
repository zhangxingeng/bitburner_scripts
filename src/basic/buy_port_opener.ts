import { NS } from '@ns';
import { executeCommand } from './simple_through_file';
import { isSingleInstance } from '../lib/util_low_ram';

const PORT_OPENER_NAMES: string[] = [
    'tor',
    'BruteSSH.exe',
    'FTPCrack.exe',
    'relaySMTP.exe',
    'HTTPWorm.exe',
    'SQLInject.exe',
    'Formulas.exe'
];

const PORT_OPENER_COSTS: number[] = [
    200000,
    500000,
    1500000,
    5000000,
    30000000,
    250000000,
    5000000000
];

export async function main(ns: NS): Promise<void> {
    // Create a copy of opener names to buy
    let remainingToBuy = [...PORT_OPENER_NAMES];
    // check if single instance if already have script running just exits
    if (!isSingleInstance(ns)) { return; }
    while (remainingToBuy.length > 0) {
        remainingToBuy = await buyPortOpeners(ns, remainingToBuy);
        if (remainingToBuy.length === 0) {
            ns.tprint('All port openers purchased successfully!');
            break;
        }
        ns.print(`Still need to buy: ${remainingToBuy.join(', ')}`);
        await ns.sleep(10000); // Wait 10 seconds before trying again
    }
}

export async function buyPortOpeners(ns: NS, openersToBuy: string[]): Promise<string[]> {
    // Create a new array to track remaining items to buy
    const remaining: string[] = [];

    for (const opener of openersToBuy) {
        // Check if we already have it
        if (opener === 'tor' && ns.hasTorRouter()) continue;
        if (opener !== 'tor' && ns.fileExists(opener, 'home')) continue;

        // Get the cost
        const index = PORT_OPENER_NAMES.indexOf(opener);
        const cost = PORT_OPENER_COSTS[index];

        // Try to purchase if we have enough money
        if (ns.getPlayer().money >= cost) {
            let success = false;
            if (opener === 'tor') {
                success = await executeCommand(ns, 'ns.singularity.purchaseTor()');
            } else {
                success = await executeCommand(ns, `ns.singularity.purchaseProgram("${opener}")`);
            }
        }
        remaining.push(opener);
    }

    return remaining;
}



