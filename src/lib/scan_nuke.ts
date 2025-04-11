import { NS } from '@ns';

/** @param {NS} ns */
export async function main(ns: NS) {
    nukeRec(ns, 'home');
}

/** @param {NS} ns */
function nukeRec(ns: NS, host: string, parent?: string) {
    const hosts = ns.scan(host);

    for (const i in hosts) {
        const tarHost = hosts[i];
        if (tarHost === parent) {
            continue;
        }
        ns.run('/lib/autonuke.js', 1, tarHost);
        if (ns.hasRootAccess(tarHost)) {
            nukeRec(ns, tarHost, host);
        }
    }
}