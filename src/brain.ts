import type { NS } from '@ns';
import {
    findButton,
    findAnyButton,
    clickEl,
    clickButton,
    navToPage,
    visitLoc,
    terminalCmd,
} from './lib/dom';

/**
 * BRAIN — single-entry autonomous game runner.
 *
 * Launch:  run /brain.js
 *
 * DOM utilities imported from lib/dom.ts (zero ns.* cost).  Function names
 * deliberately avoid ns.* API collisions (see lib/dom.ts for details).
 *
 * Priority loop:
 *   1. EARN  — pick best target, prep + hack; manage hacknet
 *   2. ACQUIRE — TOR (DOM click) → programs (terminal buy) → RAM (DOM click)
 *   3. EXPAND — nuke servers as programs unlock
 *   4. LEARN — take free CS course when hack level < 100
 */

// ── Tuning ──────────────────────────────────────────────────────────────────────

const LOOP_MS           = 200;
const TARGET_RESCAN     = 25;
const HACKNET_TICKS     = 10;

const TOR_COST          = 200_000;
const OPENERS = ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe', 'HTTPWorm.exe', 'SQLInject.exe'];
const OPENER_COST: Record<string, number> = {
    'BruteSSH.exe': 500_000, 'FTPCrack.exe': 1_500_000,
    'relaySMTP.exe': 5_000_000, 'HTTPWorm.exe': 30_000_000, 'SQLInject.exe': 250_000_000,
};
const TECH_VENDORS = ['Alpha Enterprises', 'ECorp', 'NetLink Technologies', 'Omega Software', 'CompuTek'];
const UNIVERSITIES = ['Rothman University', 'Summit University', 'ZB Institute of Technology'];

// ── Helpers ─────────────────────────────────────────────────────────────────────

function hasTor(ns: NS): boolean {
    try { if (ns.hasTorRouter()) return true; } catch { /* nop */ }
    try { if (ns.scan('home').includes('darkweb')) return true; } catch { /* nop */ }
    return false;
}

function owns(ns: NS, file: string): boolean {
    try { return ns.fileExists(file, 'home'); } catch { return false; }
}

function scanAll(ns: NS): string[] {
    const visited = new Set<string>(['home']);
    const queue = ['home'];
    const result: string[] = ['home'];
    while (queue.length > 0) {
        for (const n of ns.scan(queue.shift()!)) {
            if (!visited.has(n)) { visited.add(n); queue.push(n); result.push(n); }
        }
    }
    return result;
}

// ── Target selection ──────────────────────────────────────────────────────────

function pickBest(ns: NS): string {
    const hl = ns.getPlayer().skills.hacking;
    let best = '';
    let bestScore = -1;
    for (const host of scanAll(ns)) {
        if (host === 'home') continue;
        try {
            const sv = ns.getServer(host);
            if (!sv.hasAdminRights) continue;
            if ((sv.moneyMax ?? 0) <= 0) continue;
            if ((sv.requiredHackingSkill ?? Infinity) > hl) continue;
            const ch = ns.hackAnalyzeChance(host);
            if (ch < 0.3) continue;
            const score = (sv.moneyMax ?? 0) * ns.hackAnalyze(host) * ch;
            if (score > bestScore) { bestScore = score; best = host; }
        } catch { /* skip */ }
    }
    return best || 'n00dles';
}

function needsW(ns: NS, h: string): boolean {
    const s = ns.getServer(h);
    return (s.hackDifficulty ?? 99) > (s.minDifficulty ?? 1) * 1.05;
}
function needsG(ns: NS, h: string): boolean {
    const s = ns.getServer(h);
    return (s.moneyAvailable ?? 0) < (s.moneyMax ?? 1) * 0.90;
}
function prepped(ns: NS, h: string): boolean {
    const s = ns.getServer(h);
    return (s.hackDifficulty ?? 99) <= (s.minDifficulty ?? 1) * 1.05 &&
        (s.moneyAvailable ?? 0) >= (s.moneyMax ?? 1) * 0.95;
}

// ── Hacknet ────────────────────────────────────────────────────────────────────

function manageHacknet(ns: NS): void {
    try {
        const num = ns.hacknet.numNodes();
        const max = ns.hacknet.maxNumNodes();
        const money = ns.getServerMoneyAvailable('home');
        if (num < max && ns.hacknet.getPurchaseNodeCost() < money * 0.05) {
            ns.hacknet.purchaseNode();
            return;
        }
        let best = { node: -1, type: '', cost: Infinity, gain: 0 };
        for (let i = 0; i < num; i++) {
            const st = ns.hacknet.getNodeStats(i);
            const p = st.production;
            const lc = ns.hacknet.getLevelUpgradeCost(i, 1);
            if (lc < money * 0.05 && p / st.level / lc > best.gain) best = { node: i, type: 'level', cost: lc, gain: p / st.level / lc };
            const rc = ns.hacknet.getRamUpgradeCost(i, 1);
            if (rc < money * 0.05 && p * 0.07 / rc > best.gain) best = { node: i, type: 'ram', cost: rc, gain: p * 0.07 / rc };
            const cc = ns.hacknet.getCoreUpgradeCost(i, 1);
            if (cc < money * 0.05 && p / (st.cores + 1) / cc > best.gain) best = { node: i, type: 'cores', cost: cc, gain: p / (st.cores + 1) / cc };
        }
        if (best.node >= 0) {
            if (best.type === 'level') ns.hacknet.upgradeLevel(best.node, 1);
            else if (best.type === 'ram') ns.hacknet.upgradeRam(best.node, 1);
            else if (best.type === 'cores') ns.hacknet.upgradeCore(best.node, 1);
        }
    } catch { /* skip */ }
}

// ── Nuke ────────────────────────────────────────────────────────────────────────

function nukeAll(ns: NS): number {
    const ops: Array<(h: string) => void> = [];
    if (owns(ns, 'BruteSSH.exe')) ops.push(h => ns.brutessh(h));
    if (owns(ns, 'FTPCrack.exe')) ops.push(h => ns.ftpcrack(h));
    if (owns(ns, 'relaySMTP.exe')) ops.push(h => ns.relaysmtp(h));
    if (owns(ns, 'HTTPWorm.exe')) ops.push(h => ns.httpworm(h));
    if (owns(ns, 'SQLInject.exe')) ops.push(h => ns.sqlinject(h));
    const seen = new Set<string>();
    const q = ['home'];
    let rooted = 0;
    while (q.length) {
        const h = q.shift()!;
        if (seen.has(h)) continue;
        seen.add(h);
        if (h !== 'home' && !ns.hasRootAccess(h)) {
            for (const o of ops) try { o(h); } catch { /* */ }
            try { ns.nuke(h); } catch { /* */ }
        }
        if (ns.hasRootAccess(h)) rooted++;
        for (const n of ns.scan(h)) if (!seen.has(n)) q.push(n);
    }
    return rooted;
}

/** Wait for a button to appear, using ns.sleep for polling. */
async function waitForBtn(ns: NS, text: string, ms = 2000): Promise<HTMLElement | null> {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
        const b = findButton(text);
        if (b) return b;
        if (findAnyButton(text)) return null;
        await ns.sleep(100);
    }
    return null;
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.tprint('BRAIN started — single-entry autonomous runner (no SF4 needed)');
    ns.ui.openTail();

    let tick = 0;
    let target = 'n00dles';

    // eslint-disable-next-line no-constant-condition
    while (true) {
        tick++;
        const t0 = Date.now();
        try {
            const player  = ns.getPlayer();
            const homeRam = ns.getServerMaxRam('home');
            const freeRam = homeRam - ns.getServerUsedRam('home');
            const money   = player.money;
            const hackLvl = player.skills.hacking;
            const tor     = hasTor(ns);
            const owned   = OPENERS.filter(f => owns(ns, f)).length;
            const missing = OPENERS.filter(f => !owns(ns, f));

            // ── EARN — hack best target + hacknet ─────────────────────────────
            if (tick % TARGET_RESCAN === 0) target = pickBest(ns);

            if (!prepped(ns, target)) {
                if (needsW(ns, target)) await ns.weaken(target);
                else if (needsG(ns, target)) await ns.grow(target);
            } else {
                if (ns.hackAnalyzeChance(target) >= 0.3) await ns.hack(target);
                if (needsW(ns, target)) await ns.weaken(target);
                if (needsG(ns, target)) await ns.grow(target);
            }

            if (tick % HACKNET_TICKS === 0) manageHacknet(ns);

            // ── ACQUIRE — TOR → programs → RAM ───────────────────────────────
            if (!tor && money >= TOR_COST) {
                ns.print('[brain] Buying TOR...');
                for (const v of TECH_VENDORS) {
                    if (!visitLoc(v)) continue;
                    const btn = await waitForBtn(ns, 'Purchase TOR router', 2000);
                    if (btn) { clickEl(btn); ns.print('[brain] TOR purchased'); break; }
                }
            }

            if (tor && missing.length > 0 && tick % 5 === 0) {
                const next = missing[0];
                if (money >= (OPENER_COST[next] ?? 0)) {
                    ns.print(`[brain] Buying ${next}...`);
                    terminalCmd(`buy ${next}`);
                    await ns.sleep(300);
                }
            }

            if (homeRam < 64 && tick % 30 === 0) {
                ns.print(`[brain] Upgrading RAM (${homeRam}GB)...`);
                for (const v of TECH_VENDORS) {
                    if (!visitLoc(v)) continue;
                    const btn = await waitForBtn(ns, "Upgrade 'home' RAM", 2000);
                    if (btn) { clickEl(btn); ns.print('[brain] RAM upgraded'); break; }
                }
            }

            // ── LEARN — free CS course ────────────────────────────────────────
            if (hackLvl < 100 && tick % 50 === 0) {
                for (const uni of UNIVERSITIES) {
                    if (!visitLoc(uni)) continue;
                    const btn = await waitForBtn(ns, 'Computer Science', 1500);
                    if (btn) { clickEl(btn); break; }
                }
            }

            // ── EXPAND — nuke network ─────────────────────────────────────────
            if (tick % 15 === 0) {
                const n = nukeAll(ns);
                if (tick % 60 === 0) ns.print(`[brain] Rooted: ${n} servers`);
            }

            // ── Status ────────────────────────────────────────────────────────
            if (tick % 50 === 0) {
                ns.print(`[brain] RAM=${homeRam}G free=${freeRam.toFixed(0)}G $${money.toLocaleString()} hack=${hackLvl} TOR=${tor} pgms=${owned}/${OPENERS.length}`);
            }
        } catch (err) {
            ns.print(`[brain] ERROR: ${String(err)}`);
            await ns.sleep(1000);
            continue;
        }
        await ns.sleep(Math.max(50, LOOP_MS - (Date.now() - t0)));
    }
}
