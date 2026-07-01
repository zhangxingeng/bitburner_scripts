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
 * ⚠️  Function names here (buyHomeRam, buyHomeCores, makeProgram, ...) deliberately
 * avoid colliding with ns.* API names — see docs/ram_evasion_rules.md.
 *
 * NOTE: brain.ts (docs/design/14) calls buyTOR/buyAllPortOpeners/buyHomeRam/
 * takeCourse directly, inline, pre-SF4 — it is NOT launched as a separate
 * `--early-loop` daemon alongside brain.ts (that would race the same DOM clicks
 * against brain.ts's own calls). The CLI flags below remain for manual/standalone use.
 *
 * Actions:
 *   --buy-tor          Buy TOR router (City→TechVendor→click Purchase)
 *   --buy-programs     Buy all 5 port opener programs (terminal buy cmd)
 *   --upgrade-ram      Upgrade home RAM once (City→TechVendor→click Upgrade)
 *   --upgrade-cores    Upgrade home cores once
 *   --study [course]   Take a university course (default: Computer Science)
 *   --create [program] Create a program (may be blocked by isTrusted gate)
 *   --early-loop       Continuous early game loop (TOR → programs → RAM → study);
 *                      standalone/manual use only, not auto-launched by brain.ts
 */

// ── Tuning ──────────────────────────────────────────────────────────────────────

const TECH_VENDORS = ['Alpha Enterprises', 'ECorp', 'NetLink Technologies', 'Omega Software', 'CompuTek'];
const UNIVERSITIES = ['Rothman University', 'Summit University', 'ZB Institute of Technology'];
// Each of the candidates above only exists in one city (../bitburner-src/src/Locations/data/
// LocationsMetadata.ts) — without SF4 there's no travel logic here, so trying a location outside
// the player's current city always fails. Filtering avoids spamming "location not found" every
// acquire tick for the 3-4 candidates that were never reachable in the first place.
const LOCATION_CITY: Record<string, string> = {
    'Alpha Enterprises': 'Sector-12', 'ECorp': 'Aevum', 'NetLink Technologies': 'Aevum',
    'Omega Software': 'Ishima', 'CompuTek': 'Volhaven',
    'Rothman University': 'Sector-12', 'Summit University': 'Aevum', 'ZB Institute of Technology': 'Volhaven',
};
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

/** Try each candidate location until target button is found. Skips locations in a city the
 *  player isn't currently in (see LOCATION_CITY) — silently, since that's expected, not an error. */
async function tryLocations(ns: NS, locations: string[], btnText: string): Promise<boolean> {
    const city = ns.getPlayer().city;
    const reachable = locations.filter(loc => LOCATION_CITY[loc] === undefined || LOCATION_CITY[loc] === city);
    for (const loc of reachable) {
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
    // Pre-check affordability so an unaffordable attempt doesn't still flip the visible page to
    // City every acquire tick (visitLoc always navigates there first) for nothing.
    if (ns.getServerMoneyAvailable('home') < TOR_COST) return false;
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

// Mirrors Player.getUpgradeHomeRamCost (../bitburner-src/src/PersonObjects/Player/
// PlayerObjectServerMethods.ts) — that's a Singularity-gated call, so this stays a plain-JS
// estimate (0 GB, no ns.* call) purely to skip a pointless City-page navigation when we
// already know we can't afford it. Assumes the BitNode HomeComputerRamCost multiplier is 1
// (true outside a few late-game BitNodes) — worst case we under/over-estimate by that factor
// and skip or attempt one cycle later than ideal, never a wrong purchase.
function estimateHomeRamCost(currentRam: number): number {
    const numUpgrades = Math.log2(currentRam);
    const mult = Math.pow(1.58, numUpgrades);
    return currentRam * 32_000 * mult;
}

// Named buyHomeRam (not upgradeHomeRam) to avoid ns.singularity.upgradeHomeRam collision (48 GB)
export async function buyHomeRam(ns: NS): Promise<boolean> {
    const cur = ns.getServerMaxRam('home');
    if (ns.getServerMoneyAvailable('home') < estimateHomeRamCost(cur)) return false;
    ns.print(`[ui] Upgrading home RAM (currently ${cur}GB)...`);
    return tryLocations(ns, TECH_VENDORS, "Upgrade 'home' RAM");
}

// Named buyHomeCores (not upgradeHomeCores) to avoid ns.singularity.upgradeHomeCores collision (48 GB)
export async function buyHomeCores(ns: NS): Promise<boolean> {
    ns.print('[ui] Upgrading home cores...');
    return tryLocations(ns, TECH_VENDORS, "Upgrade 'home' cores");
}

export async function takeCourse(ns: NS, course = 'Computer Science'): Promise<boolean> {
    // Clicking a course button always calls Player.startWork on a NEW ClassWork, which
    // finishes (and dialog-pops) whatever class was already running (PlayerObjectWorkMethods.ts
    // startWork -> currentWork.finish(true)) — re-clicking every acquire tick would restart
    // the class from zero and spam a popup every cycle. "Stop taking course" only renders
    // on the Work-in-progress screen while a class is active (WorkInProgressRoot.tsx) — no
    // Singularity call needed, so this stays SF4-free like the rest of this file.
    if (findAnyButton('Stop taking course')) { ns.print('[ui] already studying'); return true; }
    ns.print(`[ui] Taking ${course}...`);
    return tryLocations(ns, UNIVERSITIES, course);
}

/**
 * Re-focus on work that's still running unfocused. Navigating to any other page while working
 * auto-unfocuses (GameRoot.tsx: leaving Page.Work calls Player.stopFocusing()) without cancelling
 * the work — every acquire-cycle purchase attempt does exactly this navigation, so without this,
 * a study session loses its focus bonus for good the first time brain.ts goes to buy something.
 * The "Focus" button (CharacterOverview.tsx's WorkInProgressOverview, visible on any page while
 * unfocused work is active) calls Player.startFocusing() only — it never touches currentWork, so
 * clicking it is always safe, unlike re-clicking the course/job button itself.
 */
export async function resumeFocus(ns: NS): Promise<boolean> {
    const btn = findAnyButton('Focus');
    if (!btn) return false;
    clickEl(btn);
    ns.print('[ui] resumed focus');
    return true;
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
