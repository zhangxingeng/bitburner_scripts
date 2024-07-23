import { NS } from "@ns";
import { HackUtils } from "./HackUtils";
import { ScanUtils } from "./ScanUtils";
import { maxBy } from "./utils";

namespace Var {
    export const home = 'home';
    export const homeReservedRam = 4;
    export const growPath = 'remote/grow.js';
    export const hackPath = 'remote/hack.js';
    export const weakenPath = 'remote/weaken.js';
}

/** @param {NS} ns **/
export async function main(ns: NS) {


    const serverList = ScanUtils.discoverServers(ns);
    const rootList = HackUtils.rootServers(ns, serverList);
    const hackableList = HackUtils.getHackable(ns, rootList);
    const [hackTarget, littleTarget] = getTarget(ns, hackableList);
    ns.print(`Target: ${hackTarget} and ${littleTarget}`);
    const res = await getThread(ns, hackTarget);
    const { grow, hack, security, weaken } = res;
    const { growRam, hackRam, weakenRam } = getUnitRam(ns);
    const ramTotal = grow * growRam + hack * hackRam + weaken * weakenRam;
    const hostServerList = filterByRam(ns, ramTotal, [...rootList, Var.home]);
    if (hostServerList.length === 0) { // attempt little target instead
        doPrep(ns, littleTarget, hostServerList);
        // littleHack();
        return;
    } else {
        doPrep(ns, hackTarget, hostServerList);
        // bigHack();
    }
}

function getTarget(ns: NS, serverList: string[]): [string, string] {
    const t1By = (server: string) => ns.getServerMaxMoney(server);
    const t2By = (server: string) => ns.getServerMaxMoney(server) * ns.hackAnalyze(server);
    let t1 = maxBy(serverList, t1By);
    t1 = t1 === null ? Var.home : t1;
    let t2 = maxBy(serverList, t2By);
    t2 = t2 === null ? Var.home : t2;
    return [t1, t2];
}

/**
 * @returns {grow, hack, security, weaken}
 * - grow: threads needed to grow to 2x server money
 * - hack: threads needed to hack to 1/2 server money
 * - security: security increase caused by grow and hack
 * - weaken: threads needed to weaken to 1.1 * security
 */
async function getThread(ns: NS, target: string): Promise<{ [key: string]: number }> {
    const grow = ns.growthAnalyze(target, 2);
    const hack = ns.hackAnalyzeThreads(target, ns.getServerMoneyAvailable(target) / 2);
    const security = ns.hackAnalyzeSecurity(grow) + ns.growthAnalyzeSecurity(hack);
    let weaken = 1;
    while (ns.weakenAnalyze(weaken) < security * 1.1) {
        weaken += 5;
        await ns.sleep(1); //wait 1ms prevent fast loops
    }
    return { grow, hack, security, weaken };
}

function getUnitRam(ns: NS) {
    const growRam = ns.getScriptRam(Var.growPath, Var.home);
    const hackRam = ns.getScriptRam(Var.hackPath, Var.home);
    const weakenRam = ns.getScriptRam(Var.weakenPath, Var.home);
    return { growRam, hackRam, weakenRam };
}

// filter servers that have enough ram to run the script
function filterByRam(ns: NS, needRam: number, serverList: string[]): string[] {
    const availableRam = (s: string) => ns.getServerMaxRam(s) - ns.getServerUsedRam(s);
    const res = serverList.filter(server => availableRam(server) >= needRam);
    return res;
}

/**
 * @returns {growThreads, weakenThreads}
 * - growThreads: threads needed to grow to 1/2 server max money
 * - weakenThreads: threads needed to weaken to min security level
 */
async function getPrepThreads(ns: NS, target: string) {
    const maxMoney = ns.getServerMaxMoney(target);
    const money = ns.getServerMoneyAvailable(target);
    const growHalfMaxRatio = .5 * maxMoney / money;
    let growThreads = 0;
    if (growHalfMaxRatio > 1) {
        growThreads = ns.growthAnalyze(target, growHalfMaxRatio);
    }
    const secLevel = ns.getServerSecurityLevel(target);
    const minSecLevel = ns.getServerMinSecurityLevel(target);
    const growSecInc = ns.growthAnalyzeSecurity(growThreads);
    const targetSecWeaken = secLevel + growSecInc - minSecLevel;
    let weakenThreads = 0;
    while (ns.weakenAnalyze(weakenThreads) < targetSecWeaken) {
        weakenThreads++;
        await ns.sleep(1);
    }
    if (weakenThreads == 0) {
        weakenThreads = 1;
    }
    return { growThreads, weakenThreads };
}

// obtain server to do prep
function getPrepServer(ns: NS, prepRam: number, hostList: string[]) {
    if (hostList.length === 0) { return null; }
    const prepServer = hostList.find(s => {
        const maxRam = ns.getServerMaxRam(s);
        const _reserveRam = s === Var.home ? Var.homeReservedRam : 0;
        const usedRam = ns.getServerUsedRam(s) + _reserveRam;
        return maxRam - usedRam >= prepRam;
    })
    return prepServer;
}

function runScripts(ns: NS, server: string, target: string, gt: number, wt: number) {
    const needWeaken = (t: string) => ns.getServerSecurityLevel(t) > ns.getServerMinSecurityLevel(t) * 1.5;
    if (gt > 1) {
        ns.exec(Var.growPath, server, gt, gt, 0, target);
        ns.exec(Var.weakenPath, server, wt, wt, target);
    } else if (needWeaken(target)) {
        ns.exec(Var.weakenPath, server, wt, wt, target);
    }
}

function getFreeRam(ns: NS, serverList: string[]) {
    // get the sum of free ram of all servers
    const _usable = (s: string) => ns.getServerMaxRam(s) - ns.getServerUsedRam(s);
    const ram = serverList.reduce((acc, s) => acc + _usable(s), 0);
    return ram;
}

function threadByRam(wt: number, gt: number, needRam: number, freeRam: number) {
    const c = needRam / freeRam;
    return {
        wt: Math.max(1, Math.floor(wt * c)),
        gt: Math.max(1, Math.floor(gt * c))
    }
}

async function dynamicRunScript(ns: NS, host: string, target: string, script: string, threads: number) {
    const reserveRam = host === Var.home ? Var.homeReservedRam : 0;
    const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host) - reserveRam;
    const scriptRam = ns.getScriptRam(script, host);
    const maxThreads = Math.min(Math.floor(freeRam / scriptRam), threads);
    if (maxThreads >= 1) {
        ns.exec(script, host, maxThreads, maxThreads, target);
        await ns.sleep(10);
    }
}

async function distributeScripts(ns: NS, hostList: string[], target: string, wt: number, gt: number) {
    for (const host of hostList) {
        await dynamicRunScript(ns, host, target, Var.weakenPath, wt);
        await dynamicRunScript(ns, host, target, Var.growPath, gt);
    }
}

async function littlePrep(ns: NS, target: string, wt: number, gt: number, prepRam: number) {
    const hostList = ScanUtils.discoverServers(ns);
    const freeRam = getFreeRam(ns, hostList);
    ({ wt, gt } = threadByRam(wt, gt, prepRam, freeRam));
    if (wt < 1 || gt < 1) {
        ns.tprint(`Not enough ram to run scripts`);
        return;
    }
    await distributeScripts(ns, hostList, target, wt, gt);
}

async function doPrep(ns: NS, target: string, hostList: string[]) {
    const { growThreads, weakenThreads } = await getPrepThreads(ns, target);
    const { growRam, weakenRam } = getUnitRam(ns);
    const prepRam = growRam * growThreads + weakenRam * weakenThreads;
    const prepServer = getPrepServer(ns, prepRam, hostList);
    const _sec = ns.getServerSecurityLevel(target);
    const _minSec = ns.getServerMinSecurityLevel(target);
    const _needGrow = growThreads > 1 || _sec > _minSec * 1.5;
    if (prepServer) {
        runScripts(ns, prepServer, target, growThreads, weakenThreads);
    } else if (_needGrow) {
        await littlePrep(ns, target, weakenThreads, growThreads, prepRam);
    }
    await ns.sleep(ns.getWeakenTime(target) + 1000);
}

async function littleHack() {

}