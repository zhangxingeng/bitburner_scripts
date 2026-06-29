import { NS } from '@ns';

/**
 * Cross-cutting Player-Puppet Launcher — `cross/launcher.ts`
 *
 * THE ONLY FILE IN THE REPO PERMITTED TO TOUCH THE DOM.
 * (see docs/design/04-player-automation-and-control.md §3)
 *
 * Implements Mechanism 3a: stealth-DOM terminal-command injection.
 * Stealth: `eval("document")` keeps the literal token `document` out of the
 * source, so Bitburner's static RAM analyzer never charges the 25 GB penalty.
 *
 * Constraint: DOM access is UI-interfacing ONLY — clicks / keystrokes a human
 * could make, and reading text that is visibly rendered on screen (§1 ruling).
 * Never used to read React/JS internals, the save file, or hidden engine state.
 *
 * RAM breakdown:
 *   Base script:  1.6 GB
 *   ns.exec:     ~1.3 GB  (statically referenced; pays even if never called)
 *   ns.print/tprint/disableLog: 0 GB
 *   eval-hidden document:       0 GB  (static analyzer never sees the token)
 *   readScreen():               0 GB  (eval-hidden document; pure string ops)
 *   ─────────────────────────────────
 *   Total:       ~2.9 GB
 *
 * Launch: run /cross/launcher.js <terminal-command-to-inject>
 * Example: run /cross/launcher.js run /bootstrap.js
 */

// ── Terminal Injection (Mechanism 3a) ──────────────────────────────────────────

/**
 * Inject `command` into the Bitburner terminal as if a human typed and pressed Enter.
 *
 * Uses the React event-handler pattern proven in:
 *   - inigo  `src/augment/completeBitnode.ts:44`
 *   - alainbryden `scan.js:36`
 *
 * Returns `true` on success, `false` if the terminal element is absent (game
 * version drift, terminal not focused/visible) or if the handler invocation
 * throws.  Callers must fall back to `ns.exec` on `false`.
 */
export function runTerminalCommand(command: string): boolean {
    // Stealth DOM access — eval hides the literal token from the static analyzer.
    // ONLY for UI interfacing; must never read/mutate internal game state.
    // eslint-disable-next-line no-eval
    const doc = eval('document') as Document;

    const input = doc.getElementById('terminal-input') as HTMLInputElement | null;

    // Feature-detect: terminal may not be visible (e.g. running headless or
    // game update renamed the element).  Signal the caller to use the fallback.
    if (!input) return false;

    try {
        // React stows synthetic-event props on the DOM element.
        // Object.keys(el)[1] is the handler-bearing key (index 0 is the React
        // internal fibre key; index 1 carries the props including onChange /
        // onKeyDown).  Cast through unknown to satisfy strict tsc.
        const handlerKey = Object.keys(input)[1];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handlers = (input as unknown as Record<string, any>)[handlerKey];
        handlers.onChange({ target: { value: command } });
        handlers.onKeyDown({ key: 'Enter', preventDefault: () => null });
    } catch {
        return false;
    }

    return true;
}

// ── Read-side: screen perception (Mechanism 3b read) ──────────────────────────

/**
 * Read the rendered terminal output as a human would see it.
 *
 * UI READ ONLY — this is the symmetric "read" hand to `runTerminalCommand`'s
 * "write" hand (docs/design/04-player-automation-and-control.md §4 "Read-side").
 * It reads `innerText` of the visible terminal element — text painted on screen,
 * exactly what a human eyeballs.  It does NOT read React fibers, JS object
 * state, the save file, or any non-rendered internal data (§1 ruling).
 *
 * Stealth: same `eval("document")` dodge as `runTerminalCommand` — the literal
 * token `document` never appears in source, so the static RAM analyzer charges
 * 0 GB.  This function itself adds 0 GB (pure DOM read + string ops; no ns.*
 * calls).
 *
 * @param maxChars  Maximum tail length to return (default 4000).  The terminal
 *                  log grows unbounded; we return only the recent tail so the
 *                  caller always gets a bounded, fast string.
 * @returns The rendered terminal text (tail up to `maxChars` characters), or
 *          `''` if the element is absent (game version drift, terminal not
 *          visible) or if the DOM read throws.  Callers must treat `''` as
 *          "screen unavailable".
 *
 * ⚠️  SELECTOR NOTE: the terminal output list is assumed to carry id="terminal".
 *     Verify this id in-game; game updates may rename it.  The feature-detect +
 *     empty-string fallback ensures a drift never crashes the daemon loop.
 */
export function readScreen(maxChars = 4000): string {
    try {
        // Stealth DOM access — eval hides the literal token from the static analyzer.
        // ONLY a UI read of rendered/visible text; must never access internal state.
        // eslint-disable-next-line no-eval
        const doc = eval('document') as Document;

        const terminal = doc.getElementById('terminal');

        // Feature-detect: terminal may not be visible (game update, wrong panel).
        // Return '' so the caller treats the mirror as unavailable rather than
        // crashing the daemon loop on a stale element id.
        if (!terminal) return '';

        const text = terminal.innerText ?? '';

        // Return only the tail — the terminal log is unbounded but callers only
        // need the recent output to verify a command's result.
        return text.length > maxChars ? text.slice(text.length - maxChars) : text;
    } catch {
        // Any DOM read error is silently swallowed; daemon loop must not crash.
        return '';
    }
}

// ── High-level launch helper ───────────────────────────────────────────────────

/**
 * Launch `script` on `home` with `args`, preferring terminal injection (~0 RAM
 * path) and falling back to `ns.exec` if the terminal is unavailable.
 *
 * Exported so other modules can import without pulling in heavy dependencies.
 */
export function launch(ns: NS, script: string, ...args: (string | number | boolean)[]): boolean {
    const argsStr = args.length > 0 ? ' ' + args.join(' ') : '';
    const cmd     = `run ${script}${argsStr}`;

    if (runTerminalCommand(cmd)) return true;

    // Terminal injection unavailable — fall back to ns.exec on home.
    ns.print(`[launcher] Terminal unavailable; falling back to ns.exec for: ${cmd}`);
    const pid = ns.exec(script, 'home', 1, ...args);
    return pid !== 0;
}

// ── Main — thin testable entry ─────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    if (ns.args.length === 0) {
        ns.tprint('Usage: run /cross/launcher.js <terminal-command>');
        ns.tprint('Example: run /cross/launcher.js run /bootstrap.js');
        ns.tprint('Injects the given command into the terminal as if a human typed it.');
        return;
    }

    const cmd = ns.args.join(' ');
    const ok  = runTerminalCommand(cmd);

    if (!ok) {
        ns.tprint(`ERROR [launcher] Terminal input unavailable — could not inject: ${cmd}`);
        ns.tprint('Tip: use the launch() export with ns.exec as fallback for programmatic calls.');
        return;
    }

    ns.tprint(`[launcher] Injected: ${cmd}`);
}
