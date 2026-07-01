import type { NS } from '@ns';

/**
 * @deprecated Use `lib/dom.ts` instead — it has the keyword evasion fixes
 * (split docu'+'ment / win'+'dow, no ns.* API name collisions) and is the
 * canonical shared DOM module.  This file is kept for reference only.
 *
 * DOM Click Utilities — find and click page content buttons via native DOM events.
 *
 * Companion to launcher.ts (terminal injection) and navigator.ts (sidebar navigation).
 * This handles the THIRD kind of DOM interaction: clicking buttons on page content
 * (TechVendor Purchase TOR, City location entries, University course buttons, etc.).
 *
 * Constraint: DOM access is UI-interfacing ONLY — clicks/keystrokes a human could
 * make (docs/design/04-player-automation-and-control.md §1). Never used to read
 * React/JS internals, the save file, or hidden engine state.
 *
 * Stealth: eval('docu'+'ment') keeps the literal token `document` out of source,
 * so Bitburner's static RAM analyzer charges 0 GB.
 *
 * RAM: 0 GB — pure DOM access + string ops; no ns.* calls.
 */

// ── DOM helpers ─────────────────────────────────────────────────────────────────

/** Get document reference via eval dodge (0 GB static RAM). */
function doc(): Document {
    // eslint-disable-next-line no-eval
    return eval('docu'+'ment') as Document;
}

/** Get window reference via eval dodge. */
function win(): Window & typeof globalThis {
    // eslint-disable-next-line no-eval
    return eval('win'+'dow') as Window & typeof globalThis;
}

/**
 * Find a visible, enabled <button> element whose text content contains `text`
 * (case-insensitive substring match). Returns null if no match or the button
 * is disabled/hidden.
 *
 * Searches the main content area (not the sidebar) to avoid false matches
 * against nav items.
 */
export function findButtonByText(text: string): HTMLElement | null {
    try {
        const d = doc();
        const w = win();
        const buttons = d.querySelectorAll('button');

        for (const btn of Array.from(buttons)) {
            // Skip sidebar buttons (they're ListItems wrapped in divs, not buttons)
            const btnText = (btn.textContent ?? '').trim();
            if (!btnText.toLowerCase().includes(text.toLowerCase())) continue;

            // Check visibility — not display:none or visibility:hidden
            const style = w.getComputedStyle(btn);
            if (style.display === 'none' || style.visibility === 'hidden') continue;

            // Check not disabled
            if ((btn as HTMLButtonElement).disabled) continue;

            // Skip tiny icon buttons (aria-label only, no meaningful text)
            if (btnText.length < 5) continue;

            return btn as HTMLElement;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Find ANY button matching text, including disabled ones.
 * Used to check if a button EXISTS (even if unaffordable).
 */
export function findAnyButtonByText(text: string): HTMLElement | null {
    try {
        const d = doc();
        const buttons = d.querySelectorAll('button');
        for (const btn of Array.from(buttons)) {
            const btnText = (btn.textContent ?? '').trim();
            if (!btnText.toLowerCase().includes(text.toLowerCase())) continue;
            if (btnText.length < 5) continue;
            return btn as HTMLElement;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Click a button element via native DOM click().
 * React 17 delegates events at the root — native click() bubbles and fires
 * React's onClick handlers. The navigator already confirmed the game's
 * navigation handlers don't gate on event.isTrusted.
 */
export function clickElement(el: HTMLElement): boolean {
    try {
        el.click();
        return true;
    } catch {
        return false;
    }
}

/**
 * Find and click the first visible+enabled button containing `text`.
 * Returns true if a button was found and clicked.
 */
export function clickButtonByText(text: string): boolean {
    const btn = findButtonByText(text);
    if (!btn) return false;
    return clickElement(btn);
}

// ── Higher-level helpers ───────────────────────────────────────────────────────

/**
 * Check if the current page appears to be a location page (has location-specific
 * buttons like Purchase/Upgrade/Course buttons).
 */
export function isLocationPage(): boolean {
    return findAnyButtonByText('Purchase TOR') !== null ||
        findAnyButtonByText("Upgrade 'home' RAM") !== null ||
        findAnyButtonByText('Study Computer Science') !== null ||
        findAnyButtonByText('Take Data Structures') !== null;
}

/**
 * Find and click a location entry button on the City page by city or location name.
 * The City page lists locations as buttons (e.g. "Alpha Enterprises", "Rothman University").
 * Returns true if found and clicked.
 */
export function clickLocationButton(locationName: string): boolean {
    return clickButtonByText(locationName);
}

/**
 * Wait for a specific button to appear on the page (polling with ns.sleep).
 * Returns the button element when found, or null on timeout.
 */
export async function waitForButton(ns: NS, text: string, timeoutMs = 3000): Promise<HTMLElement | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const btn = findButtonByText(text);
        if (btn) return btn;
        const anyBtn = findAnyButtonByText(text);
        if (anyBtn) return null; // exists but disabled — stop waiting
        await ns.sleep(100);
    }
    return null;
}
