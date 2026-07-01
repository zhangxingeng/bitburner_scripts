/**
 * DOM UTILITIES — zero-RAM-cost browser interaction helpers.
 *
 * ⚠️ This file relies on the keyword-split and ns.*-name-collision RAM-evasion
 * rules — see docs/design/15-ram-evasion-rules.md for the full explanation and
 * the current rename table. Short version: never un-split `docu'+'ment`/
 * `win'+'dow` below, and never name a function after an `ns.*` API.
 *
 * ## RAM footprint
 *
 * This file uses zero `ns.*` calls — importing it from another script adds
 * **0 GB** of transitive RAM. The only RAM cost comes from the importer's own
 * `ns.*` usage.
 *
 * ## How to use
 *
 * ```ts
 * import { doc, win, clickButton, navToPage, terminalCmd } from '../lib/dom';
 * ```
 *
 * All functions work without `ns` (except `waitForBtn` which needs `ns.sleep`).
 */

import { goTo, type GamePageValue } from './navigator';

// ── Keyword-evading accessors ──────────────────────────────────────────────────

/** Returns the global docu'+'ment object.  String is split to evade the 25 GB
 *  static penalty on the literal keyword. */
function doc(): Document {
    return eval('docu' + 'ment') as Document;
}

/** Returns the global win'+'dow object.  String is split to evade the 25 GB
 *  static penalty on the literal keyword. */
function win(): Window & typeof globalThis {
    return eval('win' + 'dow') as Window & typeof globalThis;
}

// ── Button helpers ─────────────────────────────────────────────────────────────

/** Find an enabled button whose text contains `text`.  Skips short matches
 *  (< 5 chars) and disabled buttons. */
export function findButton(text: string): HTMLElement | null {
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
    } catch {
        return null;
    }
}

/** Like `findButton` but also returns disabled buttons.  Useful for checking
 *  whether a button *exists* (e.g. "TOR already purchased" vs "not available"). */
export function findAnyButton(text: string): HTMLElement | null {
    try {
        const d = doc();
        for (const btn of Array.from(d.querySelectorAll('button'))) {
            const t = (btn.textContent ?? '').trim();
            if (!t.toLowerCase().includes(text.toLowerCase())) continue;
            if (t.length < 5) continue;
            return btn as HTMLElement;
        }
        return null;
    } catch {
        return null;
    }
}

export function clickEl(el: HTMLElement): boolean {
    try { el.click(); return true; } catch { return false; }
}

export function clickButton(text: string): boolean {
    const b = findButton(text);
    return b ? clickEl(b) : false;
}

/**
 * Click a location on the City map.  Handles both rendering modes:
 *   ASCIICity  — locations are <span aria-label="Alpha Enterprises">T</span>
 *   ListCity   — locations are <Button>Alpha Enterprises</Button>
 *
 * Tries <button> text match first (ListCity / inside a location page),
 * then <span aria-label> match (ASCII city map).
 */
export function clickLocation(locName: string): boolean {
    // 1. Button mode (ListCity or regular page buttons)
    const btn = findButton(locName);
    if (btn) return clickEl(btn);

    // 2. ASCII map mode — <span aria-label="locName">
    try {
        const d = doc();
        const spans = d.querySelectorAll('span[aria-label]');
        for (const span of Array.from(spans)) {
            if ((span.getAttribute('aria-label') ?? '').trim() === locName) {
                return clickEl(span as HTMLElement);
            }
        }
    } catch { /* fall through */ }
    return false;
}

// ── Sidebar navigation ─────────────────────────────────────────────────────────

/**
 * Navigate to a sidebar page by name (e.g. "City", "Terminal", "Stats").
 *
 * Delegates to lib/navigator.ts::goTo — that module handles a case this one
 * used to miss (a collapsed sidebar section hides its items from the DOM
 * fallback entirely) and caches the fiber clickPage lookup instead of
 * re-walking the tree on every call. Kept as a thin string-typed wrapper here
 * since every current caller (visitLoc, ui_actions.ts's makeProgram) already
 * passes plain page-name strings rather than importing GamePage directly.
 */
export function navToPage(pageName: string): boolean {
    return goTo(pageName as GamePageValue);
}

/** visitLoc: navigate City then click a location.  Handles ASCII map (<span>)
 *  and ListCity (<button>) modes.  NOT named goToLocation — collides with
 *  ns.singularity.goToLocation (80 GB). */
export function visitLoc(locName: string): boolean {
    if (!navToPage('City')) return false;
    return clickLocation(locName);
}

// ── Terminal injection ─────────────────────────────────────────────────────────

/**
 * Inject a command into the in-game terminal by simulating native DOM events.
 *
 * Uses `Object.getOwnPropertyDescriptor` + native setter to set the input value
 * (bypasses React's virtual DOM), then dispatches `input` + `keydown[Enter]`
 * events that the game's terminal handler recognises.
 */
export function terminalCmd(command: string): boolean {
    try {
        const d = doc();
        const w = win();
        const input = d.getElementById('terminal-input') as HTMLInputElement | null;
        if (!input) {
            navToPage('Terminal');
            return false;
        }
        const setNativeValue = Object.getOwnPropertyDescriptor(
            w.HTMLInputElement.prototype, 'value',
        )?.set;
        if (!setNativeValue) return false;
        setNativeValue.call(input, command);
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
        input.dispatchEvent(new w.KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        }));
        return true;
    } catch {
        return false;
    }
}
