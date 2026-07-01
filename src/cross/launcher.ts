import { NS } from '@ns';
import { ensureTerminal } from '../lib/navigator';

/**
 * Cross-cutting Player-Puppet Launcher — `cross/launcher.ts`
 *
 * THE ONLY FILE IN THE REPO PERMITTED TO TOUCH THE DOM.
 * (see docs/design/04-player-automation-and-control.md §3)
 *
 * Implements Mechanism 3a: stealth-DOM terminal-command injection.
 * Stealth: `eval("docu"+"ment")` splits the literal keyword so Bitburner's
 * static RAM analyzer never charges the 25 GB penalty.
 *
 * Constraint: DOM access is UI-interfacing ONLY — clicks / keystrokes a human
 * could make, and reading text that is visibly rendered on screen (§1 ruling).
 * Never used to read React/JS internals, the save file, or hidden engine state.
 *
 * RAM breakdown:
 *   Base script:  1.6 GB
 *   ns.exec:     ~1.3 GB  (statically referenced; pays even if never called)
 *   ns.print/tprint/disableLog: 0 GB
 *   eval-hidden DOM:            0 GB  (static analyzer never sees the token)
 *   readScreen():               0 GB  (eval-hidden DOM; pure string ops)
 *   ─────────────────────────────────
 *   Total:       ~2.9 GB
 *
 * Launch: run /cross/launcher.js <terminal-command-to-inject>
 * Example: run /cross/launcher.js run /brain.js
 */

// ── Terminal Injection (Mechanism 3a) ──────────────────────────────────────────

/**
 * Inject `command` into the Bitburner terminal as if a human typed and pressed Enter.
 *
 * Dispatches REAL DOM events — native value-setter, then an `input` event, then
 * an Enter `keydown` — instead of calling the React handlers directly. This is
 * the path a physical keystroke takes: the `input` event makes React re-render
 * with the new value, so the Enter handler reads the FRESH state. Calling the
 * captured handlers directly submitted the PRE-change value and nothing ran
 * (the game's onKeyDown reads `command` from React state, not the event) — see
 * docs/design/13 §8.3.
 *
 * Returns `true` on success, `false` if the terminal element is absent (game
 * version drift, terminal not on screen) or if the dispatch throws.  Callers
 * must fall back to `ns.exec` on `false`.
 */
export function runTerminalCommand(command: string): boolean {
    // Stealth DOM access — eval hides the literal tokens from the static analyzer.
    // ONLY for UI interfacing; must never read/mutate internal game state.
    // eslint-disable-next-line no-eval
    const doc = eval('docu'+'ment') as Document;
    // eslint-disable-next-line no-eval
    const win = eval('win'+'dow') as Window & typeof globalThis;

    const input = doc.getElementById('terminal-input') as HTMLInputElement | null;

    // Feature-detect: #terminal-input only exists on the Terminal page, so off
    // it injection silently no-ops (docs/design/06-ui-navigation.md §6). Kick a
    // navigation back to Terminal via the zero-RAM Navigator; the React re-render
    // is async so the element won't be ready THIS call — we signal the caller to
    // fall back / retry, and the next attempt (next tick) lands on Terminal.
    // For an await-capable single call that waits out the render, use
    // runTerminalCommandEnsured().
    if (!input) {
        ensureTerminal();
        return false;
    }

    try {
        // 1. Set the value through the prototype's native setter. React's
        //    controlled <input> tracks the last value it wrote; assigning via the
        //    native setter (not `input.value =`) leaves that tracker stale, so
        //    React's onChange actually fires on the next input event — the
        //    standard controlled-input drive idiom.
        const setNativeValue = Object.getOwnPropertyDescriptor(
            win.HTMLInputElement.prototype, 'value',
        )?.set;
        if (!setNativeValue) return false;
        setNativeValue.call(input, command);

        // 2. Real `input` event → React runs onChange → setValue(command) →
        //    synchronous re-render (React 17 flushes before dispatch returns), so
        //    the element's onKeyDown now closes over the fresh `value` state.
        input.dispatchEvent(new win.Event('input', { bubbles: true }));

        // 3. Real Enter keydown → React invokes the FRESH onKeyDown, which echoes
        //    the line and runs Terminal.executeCommands(value) (TerminalInput.tsx).
        input.dispatchEvent(new win.KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        }));
    } catch {
        return false;
    }

    return true;
}

/**
 * Robust single-call inject for await-capable callers (the in-game brain).
 *
 * If the Terminal page isn't active, navigates there via the Navigator and waits
 * out the async React re-render (polling for #terminal-input up to `timeoutMs`)
 * before injecting — so one call reliably lands the command regardless of which
 * page the player is on (docs/design/06-ui-navigation.md §6). Falls back to the
 * plain primitive once the element exists.
 *
 * @returns true if the command was injected, false if Terminal never became
 *          ready within the timeout (caller should fall back to `ns.exec`).
 */
export async function runTerminalCommandEnsured(ns: NS, command: string, timeoutMs = 800): Promise<boolean> {
    // eslint-disable-next-line no-eval
    const doc = eval('docu'+'ment') as Document;
    if (!doc.getElementById('terminal-input')) {
        ensureTerminal(); // kick the navigation (async React state update)
        const deadline = Date.now() + timeoutMs;
        while (!doc.getElementById('terminal-input') && Date.now() < deadline) {
            await ns.sleep(50);
        }
    }
    return runTerminalCommand(command);
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
 * Stealth: same `eval("docu"+"ment")` dodge as `runTerminalCommand` — the literal
 * keyword never appears in source, so the static RAM analyzer charges 0 GB.  This function itself adds 0 GB (pure DOM read + string ops; no ns.*
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
        const doc = eval('docu'+'ment') as Document;

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
        ns.tprint('Example: run /cross/launcher.js run /brain.js');
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
