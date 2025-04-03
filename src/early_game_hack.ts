import { NS } from '@ns';

/**
 * A crude hacking script that continuously weakens, grows, and hacks a target server.
 * @param ns Netscript API
 */
export async function main(ns: NS): Promise<void> {
    // Get the target server from command line arguments
    ns.disableLog('ALL');
    ns.ui.openTail();
    const target: string = 'n00dles';
    let task = 'hack';
    while (true) {
        const sec: number = ns.getServerSecurityLevel(target);
        const money: number = ns.getServerMoneyAvailable(target);
        const securityThreshold: number = sec + 5;
        const moneyThreshold: number = money * 0.75;
        if (sec > securityThreshold) {
            task = 'weaken';
            await ns.weaken(target);
        } else if (money < moneyThreshold) {
            task = 'grow';
            await ns.grow(target);
        } else {
            task = 'hack';
            await ns.hack(target);
        }
        ns.clearLog();
        ns.print(`Target: ${target}, Security: ${sec}, Money: ${money}: ${task}`);
    }
}
