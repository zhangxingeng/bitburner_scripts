import { NS } from "@ns";

/** 
 * Attempts to hack a server based on security and money thresholds.
 * @param {NS} ns - Netscript object provided by the game
 */
export async function main(ns: NS) {
    const target: string = String(ns.args[0]) ?? 'joesguns';
    const moneyThresh = ns.getServerMaxMoney(target) * 0.9;
    const securityThresh = ns.getServerMinSecurityLevel(target) + 5;

    while (true) {
        if (ns.getServerSecurityLevel(target) > securityThresh) {
            await ns.weaken(target);
        } else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
            await ns.grow(target);
        } else {
            await ns.hack(target);
        }
    }
}
