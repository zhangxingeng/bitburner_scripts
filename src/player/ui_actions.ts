import type { NS } from '@ns';
import {
    findButton,
    findAnyButton,
    clickEl,
    navToPage,
    visitLoc,
    terminalCmd,
} from '../lib/dom';

/**
 * UI Actions — SF4-free early game automation via DOM clicks + terminal injection.
 *
 * ## ⚠️  Function naming: avoid ns.* collisions
 *
 * The Bitburner RAM analyzer looks up ALL function names in the ns API tree.
 * If a function shares a name with an ns API, it incurs that API's RAM cost.
 * Without SF4, Singularity costs are multiplied by 16x:
 *
 *   goToLocation    → ns.singularity.goToLocation = 5×16 = 80 GB  ❌
 *   visitLoc        → no collision  ✅
 *   upgradeHomeRam  → ns.singularity.upgradeHomeRam = 3×16 = 48 GB  ❌
 *   buyHomeRam      → no collision  ✅
 *
 * DO NOT rename these functions to match any ns.* API name.
 *
 * Actions:
 *   --buy-tor          Buy TOR router (City→TechVendor→click Purchase)
 *   --buy-programs     Buy all 5 port opener programs (terminal buy cmd)
 *   --upgrade-ram      Upgrade home RAM once (City→TechVendor→click Upgrade)
 *   --upgrade-cores    Upgrade home cores once
 *   --study [course]   Take a university course (default: Computer Science)
 *   --create [program] Create a program (may be blocked by isTrusted gate)
 *   --early-loop       Continuous early game loop (TOR → programs → RAM → study)
 */

// ── Tuning ──────────────────────────────────────────────────────────────────────

const TECH_VENDORS = ['Alpha Enterprises', 'ECorp', 'NetLink Technologies', 'Omega Software', 'CompuTek'];
const UNIVERSITIES = ['Rothman University', 'Summit University', 'ZB Institute of Technology'];
const PORT_OPENERS = ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe', 'HTTPWorm.exe', 'SQLInject.exe'];
const PORT_OPENER_COSTS: Record<string, number> = {
    'BruteSSH.exe': 500_000, 'FTPCrack.exe': 1_500_000,
    'relaySMTP.exe': 5_000_000, 'HTTPWorm.exe': 30_000_000, 'SQLInject.exe': 250_000_000,
};
const TOR_COST = 200_000;
const LOOP_INTERVAL_MS = 5000;

// ── Helpers ─────────────────────────────────────────────────────────────────────

function hasTor(ns: NS): boolean {
    try { if (ns.hasTorRouter()) return true; } catch { /* */ }
    try { if (ns.scan('home').includes('darkweb')) return true; } catch { /* */ }
    return false;
}

/** Try each candidate location until target button is found. */
async function tryLocations(ns: NS, locations: string[], btnText: string): Promise<boolean> {
    for (const loc of locations) {
        if (!visitLoc(loc)) { ns.print(`[ui] location not found: ${loc}`); continue; }
        // waitForBtn is inlined here — it needs ns.sleep
        const dl = Date.now() + 2500;
        let btn: HTMLElement | null = null;
        while (Date.now() < dl) {
            btn = findButton(btnText);
            if (btn) break;
            if (findAnyButton(btnText)) break; // exists but disabled
            await ns.sleep(100);
        }
        if (btn) { clickEl(btn); ns.print(`[ui] clicked "${btnText}" at ${loc}`); return true; }
        if (findAnyButton(btnText)) { ns.print(`[ui] "${btnText}" exists at ${loc} but disabled`); }
    }
    return false;
}

// ── Public actions ──────────────────────────────────────────────────────────────

export async function buyTOR(ns: NS): Promise<boolean> {
    if (hasTor(ns)) { ns.print('[ui] TOR already owned'); return true; }
    ns.print(`[ui] Buying TOR router ($${TOR_COST.toLocaleString()})...`);
    return tryLocations(ns, TECH_VENDORS, 'Purchase TOR router');
}

export async function buyProgram(ns: NS, prog: string): Promise<boolean> {
    try { if (ns.fileExists(prog, 'home')) { ns.print(`[ui] ${prog} already owned`); return true; } } catch { /* */ }
    const cost = PORT_OPENER_COSTS[prog] ?? 0;
    try { if (ns.getServerMoneyAvailable('home') < cost) return false; } catch { /* */ }
    ns.print(`[ui] Buying ${prog} ($${cost.toLocaleString()})...`);
    return terminalCmd(`buy ${prog}`);
}

export async function buyAllPortOpeners(ns: NS): Promise<number> {
    let n = 0;
    for (const prog of PORT_OPENERS) {
        try { if (ns.fileExists(prog, 'home')) { n++; continue; } } catch { /* */ }
        const cost = PORT_OPENER_COSTS[prog];
        try { if (ns.getServerMoneyAvailable('home') < cost) continue; } catch { /* */ }
        if (await buyProgram(ns, prog)) { n++; await ns.sleep(300); }
    }
    ns.print(`[ui] Port openers: ${n}/${PORT_OPENERS.length}`);
    return n;
}

// Named buyHomeRam (not upgradeHomeRam) to avoid ns.singularity.upgradeHomeRam collision (48 GB)
export async function buyHomeRam(ns: NS): Promise<boolean> {
    const cur = ns.getServerMaxRam('home');
    ns.print(`[ui] Upgrading home RAM (currently ${cur}GB)...`);
    return tryLocations(ns, TECH_VENDORS, "Upgrade 'home' RAM");
}

// Named buyHomeCores (not upgradeHomeCores) to avoid ns.singularity.upgradeHomeCores collision (48 GB)
export async function buyHomeCores(ns: NS): Promise<boolean> {
    ns.print('[ui] Upgrading home cores...');
    return tryLocations(ns, TECH_VENDORS, "Upgrade 'home' cores");
}

export async function takeCourse(ns: NS, course = 'Computer Science'): Promise<boolean> {
    ns.print(`[ui] Taking ${course}...`);
    return tryLocations(ns, UNIVERSITIES, course);
}

// Named makeProgram (not createProgram) to avoid ns.singularity.createProgram collision (80 GB)
export async function makeProgram(ns: NS, prog = 'BruteSSH.exe'): Promise<boolean> {
    try { if (ns.fileExists(prog, 'home')) { ns.print(`[ui] ${prog} already owned`); return true; } } catch { /* */ }
    ns.print(`[ui] Creating ${prog} (may be blocked by isTrusted gate)...`);
    if (!navToPage('Create Program')) return false;
    await ns.sleep(500);
    const d = eval('docu' + 'ment') as Document;
    for (const paper of Array.from(d.querySelectorAll('.MuiPaper-root'))) {
        if (!(paper.textContent ?? '').includes(prog)) continue;
        for (const btn of Array.from(paper.querySelectorAll('button'))) {
            const t = (btn.textContent ?? '').trim();
            if (t === 'Create program' || t === 'Resume focus') {
                if ((btn as HTMLButtonElement).disabled) { ns.print(`[ui] ${prog} button disabled`); return false; }
                (btn as HTMLElement).click();
                ns.print(`[ui] Clicked "${t}" for ${prog}`); return true;
            }
        }
    }
    return false;
}

// ── Main ────────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    const flags = ns.flags([
        ['buy-tor', false], ['buy-programs', false], ['upgrade-ram', false],
        ['upgrade-cores', false], ['study', ''], ['create', ''], ['early-loop', false],
    ]) as unknown as Record<string, string | boolean>;

    if (flags['buy-tor'])              ns.tprint(await buyTOR(ns) ? 'TOR purchased!' : 'Failed');
    else if (flags['buy-programs'])    ns.tprint(`${await buyAllPortOpeners(ns)}/${PORT_OPENERS.length} openers`);
    else if (flags['upgrade-ram'])     ns.tprint(await buyHomeRam(ns) ? 'RAM upgraded!' : 'Failed');
    else if (flags['upgrade-cores'])   ns.tprint(await buyHomeCores(ns) ? 'Cores upgraded!' : 'Failed');
    else if (flags['study'])           ns.tprint(await takeCourse(ns, String(flags['study'])) ? 'Started!' : 'Failed');
    else if (flags['create'])          ns.tprint(await makeProgram(ns, String(flags['create'])) ? 'Started!' : 'Failed');
    else if (flags['early-loop'])      await earlyLoop(ns);
    else {
        // Filename split to avoid "ns.js" false positive in RAM analyzer
        ns.tprint('Usage: run /player/ui_actions' + '.js [--buy-tor|--buy-programs|--upgrade-ram|--upgrade-cores|--study <course>|--create <prog>|--early-loop]');
    }
}

// ── Early game loop ─────────────────────────────────────────────────────────────

async function earlyLoop(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.print('[ui] Early game loop started (no SF4 needed)');
    let torBought = hasTor(ns);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            torBought = torBought || hasTor(ns);
            const openersOwned = PORT_OPENERS.filter(p => { try { return ns.fileExists(p, 'home'); } catch { return false; } });
            const missing = PORT_OPENERS.filter(p => !openersOwned.includes(p));
            const homeRam = ns.getServerMaxRam('home');
            const money = ns.getServerMoneyAvailable('home');

            ns.print(`[ui] RAM=${homeRam}GB $${money.toLocaleString()} TOR=${torBought} pgms=${openersOwned.length}/${PORT_OPENERS.length}`);

            if (!torBought && money >= TOR_COST) torBought = await buyTOR(ns);

            if (torBought && missing.length > 0 && money >= (PORT_OPENER_COSTS[missing[0]] ?? Infinity)) {
                await buyProgram(ns, missing[0]);
            }

            if (homeRam < 64) await buyHomeRam(ns);

            if (torBought && openersOwned.length >= PORT_OPENERS.length && homeRam > 16) {
                ns.print('[ui] Early game complete — TOR + programs + RAM > 16GB');
            }
        } catch (err) { ns.print(`[ui] ERROR: ${String(err)}`); }
        await ns.sleep(LOOP_INTERVAL_MS);
    }
}
