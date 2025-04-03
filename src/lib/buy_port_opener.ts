import { NS } from '@ns';

const PORT_OPENER_COSTS: [string, number][] = [
    ['tor', 200000],
    ['BruteSSH.exe', 500000],
    ['FTPCrack.exe', 1500000],
    ['relaySMTP.exe', 5000000],
    ['HTTPWorm.exe', 30000000],
    ['SQLInject.exe', 250000000]
];

export async function main(ns: NS): Promise<void> {
    buyAllPortOpeners(ns);
}

export function buyAllPortOpeners(ns: NS): void {
    for (const [item, cost] of PORT_OPENER_COSTS) {
        // Skip if we already have the item
        if (item === 'tor' && ns.hasTorRouter()) continue;
        if (ns.fileExists(item, 'home')) continue;
        // Check if we have enough money
        if (ns.getPlayer().money >= cost) {
            let success = false;
            // Try to purchase the item
            if (item === 'tor') {
                success = ns.singularity.purchaseTor();
            } else {
                success = ns.singularity.purchaseProgram(item);
            }
        }
    }
}



