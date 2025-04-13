import { NS } from '@ns';


/** @param {NS} ns */
export async function main(ns: NS) {
    const host = ns.args[0] as string;
    if (!ns.serverExists(host)) {
        ns.tprint(`server not exist: ${host}`);
        ns.exit();
    }

    const ports = ns.getServerNumPortsRequired(host);
    const means = [ns.brutessh, ns.ftpcrack, ns.relaysmtp, ns.httpworm, ns.sqlinject];
    const files = ['/BruteSSH.exe', '/FTPCrack.exe', '/relaySMTP.exe', '/HTTPWorm.exe', '/SQLInject.exe'];

    // ns.tprint(`nuking ${host}, ports: ${ports}`)
    for (let i = 0; i < ports; ++i) {
        if (!ns.fileExists(files[i])) { continue; }
        means[i](host);
    }
    try { ns.nuke(host); } catch (e) {/*pass*/ }

}