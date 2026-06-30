import { domDocument } from './react';

/**
 * Navigator — switch the game to any sidebar page from anywhere, read the
 * current page, and ensure the Terminal page is active before injecting.
 *
 * Ground truth: docs/design/06-ui-navigation.md (derived from ../bitburner-src).
 * Bitburner v3.0.2 / React 17.0.2: navigation is a React state update, NOT URL
 * routing, and there is no global Router. We drive the game's OWN navigation:
 *   1. Primary — the React fiber bridge: SidebarRoot passes a `clickPage(page)`
 *      callback as a prop down to each SidebarAccordion. We read it off the fiber
 *      and call it; this routes through the real Router.toPage with correct
 *      context, and works even when an accordion section is collapsed.
 *   2. Fallback — synthetic DOM click: React 17 delegates events at #root, so a
 *      native .click() on a nav ListItem fires the real onClick (nav handlers do
 *      not gate on event.isTrusted). The section must be expanded first
 *      (Collapse unmountOnExit removes collapsed items from the DOM).
 *
 * Capability boundary (design/06 §1): this is UI INTERFACING — invoking the
 * game's own click handlers, the same action a human takes by clicking. We never
 * read save state / RNG / game objects through the fiber; we only use it to click.
 *
 * Zero-RAM: pure eval('document') DOM access (via ./react) + no ns.* — costs
 * 0 GB and is importable into any hot path (launcher) or UI script.
 */

// ── Page constants (mirrored from bitburner-src/src/ui/Enums.ts; value string === sidebar text) ──

export const GamePage = {
	Terminal: 'Terminal', ScriptEditor: 'Script Editor', ActiveScripts: 'Active Scripts',
	CreateProgram: 'Create Program', StaneksGift: "Stanek's Gift",
	Stats: 'Stats', Factions: 'Factions', Augmentations: 'Augmentations', Hacknet: 'Hacknet',
	Sleeves: 'Sleeves', Grafting: 'Grafting',
	City: 'City', Travel: 'Travel', Job: 'Job', StockMarket: 'Stock Market',
	Bladeburner: 'Bladeburner', Corporation: 'Corporation', Gang: 'Gang',
	IPvGO: 'IPvGO Subnet', DarkNet: 'Dark Net',
	Milestones: 'Milestones', Documentation: 'Documentation', Achievements: 'Achievements', Options: 'Options',
} as const;

export type GamePageValue = typeof GamePage[keyof typeof GamePage];

/** All known page strings — used to tell nav items apart from section headers. */
const PAGE_VALUES: ReadonlySet<string> = new Set(Object.values(GamePage));

/** Sidebar section a page lives under (SidebarRoot.tsx). Used by the DOM-click fallback. */
const SECTION_OF: Record<GamePageValue, 'Hacking' | 'Character' | 'World' | 'Help'> = {
	Terminal: 'Hacking', 'Script Editor': 'Hacking', 'Active Scripts': 'Hacking',
	'Create Program': 'Hacking', "Stanek's Gift": 'Hacking',
	Stats: 'Character', Factions: 'Character', Augmentations: 'Character', Hacknet: 'Character',
	Sleeves: 'Character', Grafting: 'Character',
	City: 'World', Travel: 'World', Job: 'World', 'Stock Market': 'World',
	Bladeburner: 'World', Corporation: 'World', Gang: 'World',
	'IPvGO Subnet': 'World', 'Dark Net': 'World',
	Milestones: 'Help', Documentation: 'Help', Achievements: 'Help', Options: 'Help',
};

// ── Fiber helpers ──────────────────────────────────────────────────────────────

/** React 17 stores its fiber/props under randomized `__reactFiber$xxx` expandos. */
function fiberKey(el: Element, prefix: string): string | null {
	for (const k of Object.keys(el)) if (k.startsWith(prefix)) return k;
	return null;
}

/** Cached clickPage callback; re-resolved whenever a call fails or it's lost. */
let cachedClickPage: ((page: string) => void) | null = null;

/**
 * Resolve the sidebar's `clickPage(page)` prop by DFS-ing the fiber subtree under
 * the drawer for any fiber whose memoizedProps carries a clickPage function.
 */
function findClickPage(): ((page: string) => void) | null {
	if (cachedClickPage) return cachedClickPage;
	const drawer = domDocument.querySelector('.MuiDrawer-root');
	if (!drawer) return null;
	const key = fiberKey(drawer, '__reactFiber$');
	if (!key) return null;
	const root = (drawer as unknown as Record<string, { child?: unknown; sibling?: unknown; memoizedProps?: { clickPage?: unknown } }>)[key];
	type Fiber = { child?: Fiber; sibling?: Fiber; memoizedProps?: { clickPage?: unknown } };
	const stack: Fiber[] = [];
	if ((root as Fiber)?.child) stack.push((root as Fiber).child as Fiber);
	let guard = 0;
	while (stack.length && guard++ < 5000) {
		const f = stack.pop()!;
		const cp = f.memoizedProps?.clickPage;
		if (typeof cp === 'function') {
			cachedClickPage = cp as (page: string) => void;
			return cachedClickPage;
		}
		if (f.child) stack.push(f.child);
		if (f.sibling) stack.push(f.sibling);
	}
	return null;
}

// ── DOM helpers ────────────────────────────────────────────────────────────────

/** Trimmed text of a sidebar ListItem (its ListItemText typography). */
function itemText(item: Element): string {
	const t = item.querySelector('.MuiListItemText-root');
	return (t?.textContent ?? item.textContent ?? '').trim();
}

/** Find the sidebar nav ListItem whose label === the given text, or null. */
function findNavItem(text: string): HTMLElement | null {
	const items = domDocument.querySelectorAll('.MuiDrawer-root .MuiListItem-root');
	for (const item of Array.from(items)) {
		if (itemText(item) === text) return item as HTMLElement;
	}
	return null;
}

/** Expand the collapsible section a page lives in, if it's currently hidden. */
function expandSectionFor(page: GamePageValue): void {
	const header = findNavItem(SECTION_OF[page]);
	if (!header) return;
	// The Collapse wrapper is a following sibling of the header ListItem.
	let sib: Element | null = header.nextElementSibling;
	while (sib && !sib.classList.contains('MuiCollapse-root')) sib = sib.nextElementSibling;
	if (sib && sib.classList.contains('MuiCollapse-hidden')) header.click();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Navigate to a sidebar page from anywhere. Returns true on success, false if
 * the page item is absent (locked/conditional) or both paths fail. Never throws.
 */
export function goTo(page: GamePageValue): boolean {
	// Primary: the fiber clickPage bridge (works even when sections are collapsed).
	const cp = findClickPage();
	if (cp) {
		try {
			cp(page);
			return true;
		} catch {
			cachedClickPage = null; // stale/unsupported — fall through to DOM click
		}
	}
	// Fallback: synthetic DOM click on the nav item (expand its section first).
	try {
		expandSectionFor(page);
		const item = findNavItem(page);
		if (item) {
			item.click();
			return true;
		}
	} catch {
		/* tolerate missing DOM */
	}
	return false;
}

/**
 * The page currently shown, detected by the active nav item's left-border accent
 * (the active class is tss-hashed, so we probe computed style, not class name).
 * Returns null if nothing matches.
 */
export function currentPage(): GamePageValue | null {
	const win = domDocument.defaultView;
	if (!win) return null;
	const items = domDocument.querySelectorAll('.MuiDrawer-root .MuiListItem-root');
	for (const item of Array.from(items)) {
		const text = itemText(item);
		if (!PAGE_VALUES.has(text)) continue; // skip section headers
		const cs = win.getComputedStyle(item);
		const w = parseFloat(cs.borderLeftWidth || '0');
		if (cs.borderLeftStyle !== 'none' && w > 0 && cs.borderLeftColor && !cs.borderLeftColor.includes('rgba(0, 0, 0, 0)')) {
			return text as GamePageValue;
		}
	}
	return null;
}

/**
 * Ensure the Terminal page is active before a terminal injection. Closes the
 * "inject silently no-ops off the Terminal page" failure (design/06 §6). Returns
 * true if Terminal is (now) active.
 */
export function ensureTerminal(): boolean {
	if (currentPage() === GamePage.Terminal) return true;
	return goTo(GamePage.Terminal);
}
