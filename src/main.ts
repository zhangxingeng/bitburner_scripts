import { NS } from "@ns";
import { HackUtils } from "./HackUtils";
import { ScanUtils } from "./ScanUtils";
/** 
 * Distribute the hacking script to each server and run it.
 * @param {NS} ns - Netscript object provided by the game
 */
export async function main(ns: NS) {
    const allServers = ScanUtils.discoverServers(ns);
    ns.tprint(`Got total of ${allServers.length} servers`);
    const rootedServers = HackUtils.rootServers(ns, allServers);
    ns.tprint(`Rooted servers: ${rootedServers.join(', ')}`);
    HackUtils.hackByList(ns, "basic.js", rootedServers, [1700, 40, 2]);
}


