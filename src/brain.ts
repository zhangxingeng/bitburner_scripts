import type { NS } from '@ns';

/**
 * BRAIN — single-entry autonomous game runner. Replaces bootstrap.ts +
 * phase_detector.ts + player_sequencer.ts + program_acquirer.ts + hacknet_manager.ts
 * + early_prepper.ts + ui_actions.ts with ONE script.
 *
 * Launch:  run /brain.js
 *
 * All DOM functionality is INLINED — no imports from lib/ to avoid the
 * RAM analyzer counting transitive ns.* references from imported modules.
 * DOM access uses eval('document') for 0 GB static RAM.
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

// ── Inlined DOM utilities (0 GB — eval hides document from RAM analyzer) ────────

function doc(): Document { return eval('document') as Document; }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function win(): Window & typeof globalThis { return eval('window') as Window & typeof globalThis; }

function findButton(text: string): HTMLElement | null {
    try {
        const d = doc();
        for (const btn of Array.from(d.querySelectorAll('button'))) {
            const t = (btn.textContent ?? '').trim();
            if (!t.toLowerCase().includes(text.toLowerCase())) continue;
            if (t.length < 5) continue;
            if ((btn as HTMLButtonElement).disabled) continue;
            return btn as HTMLElement;
        }
        return null;
    } catch { return null; }
}

function clickBtn(btn: HTMLElement): void { try { btn.click(); } catch { /* nop */ } }

function findAndClick(text: string): boolean {
    const b = findButton(text);
    if (!b) return false;
    clickBtn(b);
    return true;
}

async function waitForBtn(ns: NS, text: string, ms = 2000): Promise<HTMLElement | null> {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
        const b = findButton(text);
        if (b) return b;
        await ns.sleep(100);
    }
    return null;
}

/** Sidebar page navigation — inlined from navigator.ts (0 GB). */
function navToPage(pageName: string): boolean {
    try {
        const d = doc();
        // Primary: find clickPage via React fiber (same as navigator.ts)
        const drawer = d.querySelector('.MuiDrawer-root');
        if (drawer) {
            for (const k of Object.keys(drawer)) {
                if (!k.startsWith('__reactFiber$')) continue;
                const root = (drawer as unknown as Record<string, { child?: unknown; sibling?: unknown; memoizedProps?: { clickPage?: unknown } }>)[k];
                const stack: Array<{ child?: unknown; sibling?: unknown; memoizedProps?: { clickPage?: unknown } }> = [];
                if ((root as { child?: unknown })?.child) stack.push((root as { child?: unknown }).child as typeof stack[0]);
                let guard = 0;
                while (stack.length && guard++ < 5000) {
                    const f = stack.pop()!;
                    if (typeof f.memoizedProps?.clickPage === 'function') {
                        (f.memoizedProps.clickPage as (p: string) => void)(pageName);
                        return true;
                    }
                    if ((f as { child?: unknown }).child) stack.push((f as { child?: unknown }).child as typeof stack[0]);
                    if ((f as { sibling?: unknown }).sibling) stack.push((f as { sibling?: unknown }).sibling as typeof stack[0]);
                }
                break;
            }
        }
        // Fallback: click sidebar ListItem
        const items = d.querySelectorAll('.MuiDrawer-root .MuiListItem-root');
        for (const item of Array.from(items)) {
            const label = item.querySelector('.MuiListItemText-root');
            if ((label?.textContent ?? '').trim() === pageName) {
                (item as HTMLElement).click();
                return true;
            }
        }
        return false;
    } catch { return false; }
}

/** Navigate to City page, then click a location button. */
function goToLocation(locName: string): boolean {
    if (!navToPage('City')) return false;
    return findAndClick(locName);
}

/** Inject a terminal command (inlined from launcher.ts). */
function terminalCmd(command: string): boolean {
    try {
        const d = doc();
        const w = win();
        const input = d.getElementById('terminal-input') as HTMLInputElement | null;
        if (!input) {
            // Navigate to Terminal and retry next tick
            navToPage('Terminal');
            return false;
        }
        const setNativeValue = Object.getOwnPropertyDescriptor(
            w.HTMLInputElement.prototype, 'value',
        )?.set;
        if (!setNativeValue) return false;
        setNativeValue.call(input, command);
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
        input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        return true;
    } catch { return false; }
}

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
                    if (!goToLocation(v)) continue;
                    const btn = await waitForBtn(ns, 'Purchase TOR router', 2000);
                    if (btn) { clickBtn(btn); ns.print('[brain] TOR purchased'); break; }
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
                    if (!goToLocation(v)) continue;
                    const btn = await waitForBtn(ns, "Upgrade 'home' RAM", 2000);
                    if (btn) { clickBtn(btn); ns.print('[brain] RAM upgraded'); break; }
                }
            }

            // ── LEARN — free CS course ────────────────────────────────────────
            if (hackLvl < 100 && tick % 50 === 0) {
                for (const uni of UNIVERSITIES) {
                    if (!goToLocation(uni)) continue;
                    const btn = await waitForBtn(ns, 'Computer Science', 1500);
                    if (btn) { clickBtn(btn); break; }
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
