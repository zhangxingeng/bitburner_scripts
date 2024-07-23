import { NS } from "@ns"
/** @param {NS} ns **/

export class ScanUtils {

    static discoverServers(ns: NS): string[] {
        const serverList = ["home"]; // Initialize with "home" as the first entry
        for (const server of serverList) {
            const scanResult = ns.scan(server).slice(server === "home" ? 0 : 1);
            serverList.push(...scanResult);
        }
        return serverList.filter(s => s !== "home");
    }

    // reverse find path from home to server
    static GetServerPath(ns: NS, server: string): string[] {
        const path = [server];
        while (server != 'home') {
            server = ns.scan(server)[0]; // first entry always parent
            path.unshift(server);
        }
        return path;
    }


    static ServerReport(ns: NS, server: string, log = false) {
        var so = ns.getServer(server);
        const printFunc = log ? ns.print : ns.tprint;
        const hackDifficulty = so.hackDifficulty || 0;
        const minHackDifficulty = so.minDifficulty || 0;
        const moneyMax = so.moneyMax || 0;
        const moneyAvailable = so.moneyAvailable || 0;

        const moneyAvailableStr = ns.formatNumber(moneyAvailable, 2);
        const moneyMaxStr = ns.formatNumber(moneyMax, 2);
        const moneyPercentStr = ns.formatNumber(moneyAvailable / moneyMax * 100, 2);
        const securityStr = ns.formatNumber(hackDifficulty - minHackDifficulty, 2);
        const minHackDifficultyStr = ns.formatNumber(minHackDifficulty, 2);
        const hackDifficultyStr = ns.formatNumber(hackDifficulty, 2);


        const threadWeakenOnce = Math.ceil(ns.weakenAnalyze(1, 1));
        const threadGrowMax = Math.ceil(ns.growthAnalyze(server, moneyMax / Math.max(moneyAvailable, 1), 1));
        const threadHackMax = Math.ceil(ns.hackAnalyzeThreads(server, moneyAvailable));

        printFunc(server);
        printFunc(`Money: Available: \$${moneyAvailableStr}, Max: \$${moneyMaxStr}, Percent: ${moneyPercentStr}%`);
        printFunc(`Security: ${securityStr} (min: ${minHackDifficultyStr}, max: ${hackDifficultyStr})`);
        printFunc(`Threads: Weaken: ${threadWeakenOnce}, Grow: ${threadGrowMax}, Hack: ${threadHackMax}`);

        const hasFormulas = ns.fileExists("formulas.exe", "home");
        if (hasFormulas) {
            const hackTimeBase = ns.formulas.hacking.hackTime(so, ns.getPlayer());
            printFunc(`Time: Weaken: ${ns.tFormat(hackTimeBase * 4)}, Grow: ${ns.tFormat(hackTimeBase * 3.2)}, Hack: ${ns.tFormat(hackTimeBase)}`);
        }
    }
}