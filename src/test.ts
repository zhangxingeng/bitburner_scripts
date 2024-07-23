import { NS } from "@ns";
import { killAll, findServer } from "./utils";
import { ScanUtils } from "./ScanUtils";
/** 
 * Distribute the hacking script to each server and run it.
 * @param {NS} ns - Netscript object provided by the game
 */
export async function main(ns: NS) {
    /** Kill All Scripts */
    // killAll(ns);
    // ns.tprint("Done");
    /** Find server by keyword */
    const _serverName = await ns.prompt('Enter server name: ', { type: 'text' });
    const _res = findServer(ns, String(_serverName));
    const toCommand = (s: string) => s === `connect ${s};`;
    const chainedCommand = (s: string[]) => s.map(toCommand).join('');
    _res.forEach(s => {
        for (const key in s) {
            ns.tprint(`Server: ${key} Path: ${chainedCommand(s[key])}`);
        }
    });
}
