import { NS } from "@ns"
/** @param {NS} ns **/


export class HackUtils {
    /** Check what openers can be used return available list of opener functions */
    static getOpeners(ns: NS): ((host: string) => void)[] {
        const programs = {
            'BruteSSH': ns.brutessh,
            'FTPCrack': ns.ftpcrack,
            'relaySMTP': ns.relaysmtp,
            'HTTPWorm': ns.httpworm,
            'SQLInject': ns.sqlinject
        }
        const res: ((host: string) => void)[] = [];
        for (const [program, func] of Object.entries(programs)) {
            if (ns.fileExists(program + '.exe')) {
                res.push(func);
            }
        }
        return res;
    }

    // open openable ports
    static openPorts(ns: NS, server: string) {
        const openers = HackUtils.getOpeners(ns);
        openers.map(opener => opener(server));
    }

    // attempt to hack a server return true if successful
    static #tryRoot(ns: NS, server: string): boolean {
        if (ns.hasRootAccess(server)) { return true; }
        // check level req pass
        const canHack = (s: string) => ns.getServerRequiredHackingLevel(s) <= ns.getHackingLevel();
        if (!canHack(server)) { return false; }
        // check openable port pass
        const openers = HackUtils.getOpeners(ns);
        if (openers.length < ns.getServerNumPortsRequired(server)) { return false; }
        openers.map(opener => opener(server));
        ns.nuke(server);
        return ns.hasRootAccess(server);
    }

    static rootServers(ns: NS, serverList: string[]): string[] {
        let rooted = [];
        for (const server of serverList) {
            if (HackUtils.#tryRoot(ns, server)) {
                rooted.push(server);
            }
        }
        return rooted;
    }

    static getHackable(ns: NS, rootList: string[]): string[] {
        let targetList = [];
        const noHackList = [...ns.getPurchasedServers(), 'home'];
        const canHack = (s: string) => ns.getServerRequiredHackingLevel(s) <= ns.getHackingLevel();
        const hasMoney = (s: string) => ns.getServerMaxMoney(s) > 0;
        targetList = rootList.filter(s => canHack(s) && !noHackList.includes(s) && hasMoney(s));
        return targetList;
    }


    // let hacked servers hack each other
    static hackByList(ns: NS, scriptPath: string, serverList: string[], thConfig: [number, number, number]) {
        const isRoot = (s: string) => ns.hasRootAccess(s);
        const haveMoney = (s: string) => ns.getServerMaxMoney(s) > 0;
        const rootServer = serverList.filter(s => isRoot(s));
        const targetServer = rootServer.filter(s => haveMoney(s));
        ns.tprint(`-- Money servers: ${targetServer.join(', ')}`);
        for (const source of [...rootServer, 'home']) {
            if (!ns.scp(scriptPath, source)) {
                ns.tprint(`Failed to scp ${scriptPath} to ${source}`);
                return;
            }
            ns.killall(source);
            for (const target of targetServer.filter(s => s !== source)) {
                let th;
                if (source === 'home') { th = thConfig[0]; } else if (source.includes('home')) { th = thConfig[1]; } else { th = thConfig[2]; }
                if (!ns.exec(scriptPath, source, th, target)) {
                    ns.tprint(`Failed to exec ${scriptPath} on ${source} to hack ${target}`);
                    break;
                }
            }
        }
    }
}