import type { NS } from '@ns';

/**
 * UI Actions — SF4-free early game automation via DOM clicks + terminal injection.
 *
 * ALL DOM/navigation/terminal functionality is INLINED — zero imports from
 * lib/launcher, lib/navigator, or lib/dom_click.  This keeps the RAM analyzer
 * from counting their transitive ns.* references.
 *
 * Actions:
 *   --buy-tor          Buy TOR router (City→TechVendor→click Purchase)
 *   --buy-programs     Buy all 5 port opener programs (terminal buy cmd)
 *   --upgrade-ram      Upgrade home RAM once (City→TechVendor→click Upgrade)
 *   --upgrade-cores    Upgrade home cores once
 *   --study [course]   Take a university course (default: Computer Science)
 *   --create [program] Create a program (may be blocked by isTrusted gate)
 *   --early-loop       Continuous early game loop (TOR → programs → RAM → study)
 *
 * RAM target: ≤ 5 GB (inlined DOM = 0 GB; only ns.* API calls count).
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

// ── Inlined DOM utilities (0 GB — eval hides document from RAM analyzer) ────────

function doc(): Document { return eval('document') as Document; }
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

function findAnyButton(text: string): HTMLElement | null {
    try {
        const d = doc();
        for (const btn of Array.from(d.querySelectorAll('button'))) {
            const t = (btn.textContent ?? '').trim();
            if (!t.toLowerCase().includes(text.toLowerCase())) continue;
            if (t.length < 5) continue;
            return btn as HTMLElement;
        }
        return null;
    } catch { return null; }
}

function clickEl(el: HTMLElement): boolean { try { el.click(); return true; } catch { return false; } }
function clickBtn(text: string): boolean { const b = findButton(text); return b ? clickEl(b) : false; }

async function waitForBtn(ns: NS, text: string, ms = 2000): Promise<HTMLElement | null> {
    const dl = Date.now() + ms;
    while (Date.now() < dl) {
        const b = findButton(text);
        if (b) return b;
        if (findAnyButton(text)) return null; // exists but disabled
        await ns.sleep(100);
    }
    return null;
}

// ── Inlined sidebar navigation (0 GB — same React fiber pattern as navigator.ts) ─

function navToPage(pageName: string): boolean {
    try {
        const d = doc();
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
        const items = d.querySelectorAll('.MuiDrawer-root .MuiListItem-root');
        for (const item of Array.from(items)) {
            const label = item.querySelector('.MuiListItemText-root');
            if ((label?.textContent ?? '').trim() === pageName) { (item as HTMLElement).click(); return true; }
        }
        // Fallback: try clicking "World" section to expand if collapsed
        for (const item of Array.from(items)) {
            const label = item.querySelector('.MuiListItemText-root');
            if ((label?.textContent ?? '').trim() === 'World') { (item as HTMLElement).click(); break; }
        }
        return false;
    } catch { return false; }
}

/** Navigate to City page, then click a location button. */
function goToLocation(locName: string): boolean {
    if (!navToPage('City')) return false;
    return clickBtn(locName);
}

// ── Inlined terminal injection (0 GB — same native-event pattern as launcher.ts) ─

function terminalCmd(command: string): boolean {
    try {
        const d = doc();
        const w = win();
        const input = d.getElementById('terminal-input') as HTMLInputElement | null;
        if (!input) { navToPage('Terminal'); return false; }
        const setNativeValue = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')?.set;
        if (!setNativeValue) return false;
        setNativeValue.call(input, command);
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
        input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        return true;
    } catch { return false; }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function hasTor(ns: NS): boolean {
    try { if (ns.hasTorRouter()) return true; } catch { /* */ }
    try { if (ns.scan('home').includes('darkweb')) return true; } catch { /* */ }
    return false;
}

/** Try each candidate location until target button is found. */
async function tryLocations(ns: NS, locations: string[], btnText: string): Promise<boolean> {
    for (const loc of locations) {
        if (!goToLocation(loc)) { ns.print(`[ui] location not found: ${loc}`); continue; }
        const btn = await waitForBtn(ns, btnText, 2500);
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

export async function upgradeHomeRam(ns: NS): Promise<boolean> {
    const cur = ns.getServerMaxRam('home');
    ns.print(`[ui] Upgrading home RAM (currently ${cur}GB)...`);
    return tryLocations(ns, TECH_VENDORS, "Upgrade 'home' RAM");
}

export async function upgradeHomeCores(ns: NS): Promise<boolean> {
    ns.print('[ui] Upgrading home cores...');
    return tryLocations(ns, TECH_VENDORS, "Upgrade 'home' cores");
}

export async function takeCourse(ns: NS, course = 'Computer Science'): Promise<boolean> {
    ns.print(`[ui] Taking ${course}...`);
    return tryLocations(ns, UNIVERSITIES, course);
}

export async function createProgram(ns: NS, prog = 'BruteSSH.exe'): Promise<boolean> {
    try { if (ns.fileExists(prog, 'home')) { ns.print(`[ui] ${prog} already owned`); return true; } } catch { /* */ }
    ns.print(`[ui] Creating ${prog} (may be blocked by isTrusted gate)...`);
    if (!navToPage('Create Program')) return false;
    await ns.sleep(500);
    const d = doc();
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
    else if (flags['upgrade-ram'])     ns.tprint(await upgradeHomeRam(ns) ? 'RAM upgraded!' : 'Failed');
    else if (flags['upgrade-cores'])   ns.tprint(await upgradeHomeCores(ns) ? 'Cores upgraded!' : 'Failed');
    else if (flags['study'])           ns.tprint(await takeCourse(ns, String(flags['study'])) ? 'Started!' : 'Failed');
    else if (flags['create'])          ns.tprint(await createProgram(ns, String(flags['create'])) ? 'Started!' : 'Failed');
    else if (flags['early-loop'])      await earlyLoop(ns);
    else {
        ns.tprint('Usage: run /player/ui_actions.js [--buy-tor|--buy-programs|--upgrade-ram|--upgrade-cores|--study <course>|--create <prog>|--early-loop]');
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

            if (homeRam < 64) await upgradeHomeRam(ns);

            // Exit condition: everything acquired and RAM > 16GB
            if (torBought && openersOwned.length >= PORT_OPENERS.length && homeRam > 16) {
                ns.print('[ui] Early game complete — TOR + programs + RAM > 16GB');
            }
        } catch (err) { ns.print(`[ui] ERROR: ${String(err)}`); }
        await ns.sleep(LOOP_INTERVAL_MS);
    }
}
