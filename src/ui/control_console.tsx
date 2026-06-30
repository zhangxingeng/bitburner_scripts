import type { NS } from '@ns';
import { React, ReactDOM, domWindow, domDocument } from '../lib/react';
import { loadSettings, saveSettings, BrainSettings } from '../lib/settings';
import { SCRIPT_PATHS } from '../lib/config';
import { notify } from '../cross/notification';
import { executeCommand } from '../lib/ns_dodge';
import { PORT_AUGS, PORT_PHASE, peekPort } from '../lib/ports';
import { loadPending, pushReply } from '../lib/decisions';
import { loadPlayerState } from '../lib/player_state';
import { loadAllSubsystems } from '../lib/subsystem_state';
import { SUBSYSTEM_IDS } from '../lib/manager_registry';
import { goTo, currentPage, GamePage } from '../lib/navigator';
import type { GamePageValue } from '../lib/navigator';
import type { Notification } from '../cross/notification';
import type { ConsoleState, Intent, Dispatch, Panel, MonitorSnapshot, UiState } from './console_types';
import { configPanel } from './panels/config_panel';
import { monitorPanel } from './panels/monitor_panel';
import { decisionsPanel } from './panels/decisions_panel';
import { factionsPanel } from './panels/factions_panel';
import { quickNavPanel } from './panels/quicknav_panel';
import { logPanel } from './panels/log_panel';
import { subsystemsPanel } from './panels/subsystems_panel';
import { chartsPanel } from './panels/charts_panel';
import { auditPanel } from './panels/audit_panel';

/**
 * Central Control Console — the brain's in-game UI surface.
 * (docs/design/08-control-console.md; grew out of milestone-2's config_dashboard.)
 *
 * Minimal-footprint shell (design/06 §4, /05 §8): injects a single robot button
 * into the game toolbar (next to Save / Kill / Remote API); clicking it toggles a
 * self-owned draggable window mounted on document.body, fully under our control.
 * The window is a panel REGISTRY — it renders each registered `Panel`'s
 * render(state, dispatch). Adding a feature = add a panel to PANELS; the shell
 * never changes.
 *
 * NS-safety contract (§3): no ns.* call ever runs inside the React tree. Panels
 * push Intents into a module-level outbound queue; the NS main loop drains it
 * each tick and performs all ns.* work (saveSettings, ns.run, Singularity install
 * via ns_dodge). Fresh ConsoleState flows back to the window over a per-PID DOM
 * CustomEvent.
 *
 * Mount:  ns.run('/ui/control_console.js', 'home', 1)
 */

// ── Registered panels (design/08 §4) — order IS the tab order (design/09 §6) ──
const PANELS: Panel[] = [monitorPanel, subsystemsPanel, decisionsPanel, factionsPanel, quickNavPanel, chartsPanel, auditPanel, logPanel, configPanel];

/** How many recent notifications the loop hands the LogPanel each tick. */
const LOG_TAIL = 30;

// ── Constants ─────────────────────────────────────────────────────────────────

const GEAR_ID = 'bb-brain-gear';
const PANEL_HOST_ID = 'bb-brain-panel-host';
const TOGGLE_EVENT = 'bb-brain-panel-toggle';

/**
 * Console loop cadence — deliberately decoupled from settings.tickIntervalMs
 * (the sequencer's 5 s cadence). The UI must feel responsive: an intent (e.g. a
 * nav click) is drained at the top of the loop, so this is the worst-case
 * click→action latency. 200 ms is imperceptible yet cheap.
 */
const CONSOLE_TICK_MS = 200;
/** Refresh slow-changing data (decisions/logs/player) every Nth tick (~1 Hz). */
const SLOW_REFRESH_EVERY = 5;

/**
 * Toolbar button icon. MUI isn't exposed on window (only React/ReactDOM are), so
 * we inline the SVG path from the game's own @mui/icons-material set rather than
 * importing the component. This is the "Reddit" mascot (robot-ish) — the control
 * console is the brain's face. 24px + currentColor matches the sibling SvgIcons
 * (save/Remote-API/kill); an explicit theme-green color fixes the earlier
 * dark-on-dark invisibility (color:inherit resolved to the dark text color).
 */
const CONSOLE_ICON_PATH =
	'M22 12.14a2.19 2.19 0 0 0-3.71-1.57 10.93 10.93 0 0 0-5.86-1.87l1-4.7 3.27.71a1.56 1.56 0 1 0 .16-.76l-3.64-.77c-.11-.02-.22 0-.29.06-.09.05-.14.14-.16.26l-1.11 5.22c-2.33.07-4.43.78-5.95 1.86A2.2 2.2 0 0 0 4.19 10a2.16 2.16 0 0 0-.9 4.15 3.6 3.6 0 0 0-.05.66c0 3.37 3.92 6.12 8.76 6.12s8.76-2.73 8.76-6.12c0-.21-.01-.44-.05-.66A2.21 2.21 0 0 0 22 12.14M7 13.7c0-.86.68-1.56 1.54-1.56s1.56.7 1.56 1.56a1.56 1.56 0 0 1-1.56 1.56c-.86.02-1.54-.7-1.54-1.56m8.71 4.14C14.63 18.92 12.59 19 12 19c-.61 0-2.65-.1-3.71-1.16a.4.4 0 0 1 0-.57.4.4 0 0 1 .57 0c.68.68 2.14.91 3.14.91s2.47-.23 3.14-.91a.4.4 0 0 1 .57 0c.14.16.14.41 0 .57m-.29-2.56c-.86 0-1.56-.7-1.56-1.56a1.56 1.56 0 0 1 1.56-1.56c.86 0 1.58.7 1.58 1.56a1.6 1.6 0 0 1-1.58 1.56z';
/** Theme-primary green (matches the default-theme active accent / save icon). */
const CONSOLE_ICON_COLOR = '#00cc00';

/**
 * Stable toolbar anchor (docs/design/06-ui-navigation.md §4, from bitburner-src
 * CharacterOverview.tsx). The Save / Remote-API / Kill-all row is a class-less
 * flex Box; the "kill all scripts" IconButton is the only stable hook. Its
 * grandparent (button → right Box → row) is the row we append the gear into.
 */
const KILL_ANCHOR = '[aria-label="kill all scripts"]';

// ── Loop ↔ React bridge (plain values — never touched by ns.* in React) ───────

/** Set by panel dispatch(); drained + executed by the NS loop each tick. */
let outboundIntents: Intent[] = [];
const dispatch: Dispatch = (intent) => { outboundIntents.push(intent); };

// ── Shell ─────────────────────────────────────────────────────────────────────

/** The robot console button injected into the game toolbar. Toggles the window. */
const Gear = () => {
	const [hover, setHover] = React.useState(false);
	return (
		<span
			title="Control Console"
			onClick={() => domWindow.dispatchEvent(new Event(TOGGLE_EVENT))}
			onMouseEnter={() => setHover(true)}
			onMouseLeave={() => setHover(false)}
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				cursor: 'pointer',
				padding: '8px', // matches MUI IconButton → same 40px height as siblings
				borderRadius: '50%',
				color: CONSOLE_ICON_COLOR,
				background: hover ? 'rgba(0,204,0,0.12)' : 'transparent',
				transition: 'background 120ms',
				userSelect: 'none',
			}}
		>
			<svg viewBox="0 0 24 24" width={24} height={24} fill="currentColor" aria-hidden="true">
				<path d={CONSOLE_ICON_PATH} />
			</svg>
		</span>
	);
};

/** Window-chrome minimums so a resize can't shrink the console into uselessness. */
const MIN_W = 200;
const MIN_H = 160;

/**
 * Self-owned floating window: draggable, RESIZABLE, TABBED (Step E). Toggled by
 * the gear. Renders ONE panel at a time, selected by the tab bar (PANELS order =
 * tab order). All chrome (open / pos / size / active tab) is persisted to
 * status/ui_state.json via the `persistUi` intent — never an ns.* call in React
 * (§3); the loop does the write and seeds `initialUi` at startup.
 */
const ConsoleShell = ({ initial, initialUi, eventName }: { initial: ConsoleState; initialUi: UiState; eventName: string }) => {
	const [state, setState] = React.useState<ConsoleState>(initial);
	const [open, setOpen] = React.useState<boolean>(initialUi.open);
	const [pos, setPos] = React.useState<{ x: number; y: number }>({ x: initialUi.x, y: initialUi.y });
	const [size, setSize] = React.useState<{ w: number; h: number }>({ w: initialUi.w, h: initialUi.h });
	const [activeTab, setActiveTab] = React.useState<string>(initialUi.activeTab);
	const interaction = React.useRef<
		| { mode: 'move'; dx: number; dy: number }
		| { mode: 'resize'; sx: number; sy: number; ow: number; oh: number }
		| null
	>(null);

	// Latest persist closure in a ref so the once-registered gear handler always
	// reads current pos/size/activeTab (avoids stale-closure persistence).
	const persistRef = React.useRef<(over?: Partial<UiState>) => void>(() => {});
	persistRef.current = (over = {}) => {
		dispatch({ kind: 'persistUi', ui: { open, x: pos.x, y: pos.y, w: size.w, h: size.h, activeTab, ...over } });
	};

	// Fresh ConsoleState from the NS loop.
	React.useEffect(() => {
		const handler = (e: Event) => setState((e as CustomEvent<ConsoleState>).detail);
		domWindow.addEventListener(eventName, handler);
		return () => domWindow.removeEventListener(eventName, handler);
	}, [eventName]);

	// Gear toggle — flip open and persist the new visibility.
	React.useEffect(() => {
		const handler = () => setOpen(prev => { const nv = !prev; persistRef.current({ open: nv }); return nv; });
		domWindow.addEventListener(TOGGLE_EVENT, handler);
		return () => domWindow.removeEventListener(TOGGLE_EVENT, handler);
	}, []);

	if (!open) return null;

	const onTitleDown = (e: React.MouseEvent) => { interaction.current = { mode: 'move', dx: e.clientX - pos.x, dy: e.clientY - pos.y }; };
	const onResizeDown = (e: React.MouseEvent) => {
		e.stopPropagation(); // don't start a move
		interaction.current = { mode: 'resize', sx: e.clientX, sy: e.clientY, ow: size.w, oh: size.h };
	};
	const onMove = (e: React.MouseEvent) => {
		const it = interaction.current;
		if (!it) return;
		if (it.mode === 'move') setPos({ x: e.clientX - it.dx, y: e.clientY - it.dy });
		else setSize({ w: Math.max(MIN_W, it.ow + (e.clientX - it.sx)), h: Math.max(MIN_H, it.oh + (e.clientY - it.sy)) });
	};
	// End any drag/resize and persist the final geometry.
	const onUp = () => { if (interaction.current) { interaction.current = null; persistRef.current(); } };

	const selectTab = (id: string) => { setActiveTab(id); persistRef.current({ activeTab: id }); };
	const closeWindow = () => { setOpen(false); persistRef.current({ open: false }); };

	const active = PANELS.find(p => p.id === activeTab) ?? PANELS[0];

	return (
		<div
			onMouseMove={onMove}
			onMouseUp={onUp}
			onMouseLeave={onUp}
			style={{
				position: 'fixed',
				left: pos.x,
				top: pos.y,
				zIndex: 10000, // above tail windows (~1500)
				width: size.w,
				height: size.h,
				display: 'flex',
				flexDirection: 'column',
				background: 'rgba(0,0,0,0.92)',
				border: '1px solid #4ec94e',
				borderRadius: '6px',
				color: '#cfcfcf',
				fontFamily: 'Consolas, monospace',
				fontSize: '12px',
				boxShadow: '0 4px 18px rgba(0,0,0,0.6)',
				overflow: 'hidden',
			}}
		>
			{/* Title bar (drag handle) */}
			<div
				onMouseDown={onTitleDown}
				style={{
					cursor: 'move',
					padding: '5px 8px',
					borderBottom: '1px solid #2a6f2a',
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					color: '#4ec94e',
					fontWeight: 'bold',
					flexShrink: 0,
				}}
			>
				<span>Control Console</span>
				<span style={{ cursor: 'pointer' }} onClick={closeWindow}>✕</span>
			</div>

			{/* Tab bar — one panel visible at a time (PANELS order = tab order) */}
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '4px 6px 0', flexShrink: 0 }}>
				{PANELS.map(p => {
					const on = p.id === active.id;
					return (
						<span
							key={p.id}
							onClick={() => selectTab(p.id)}
							title={p.title}
							style={{
								cursor: 'pointer',
								padding: '2px 6px',
								borderRadius: '3px 3px 0 0',
								fontSize: '10px',
								fontWeight: on ? 'bold' : 'normal',
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
								color: on ? '#0a0a0a' : '#8fbf8f',
								background: on ? '#4ec94e' : 'rgba(78,201,78,0.10)',
								userSelect: 'none',
							}}
						>
							{p.title}
						</span>
					);
				})}
			</div>

			{/* Active panel body (scrolls if it exceeds the window height) */}
			<div style={{ padding: '6px 8px', overflowY: 'auto', overflowX: 'hidden', flex: 1 }}>
				{active.render(state, dispatch)}
			</div>

			{/* Resize handle (bottom-right corner) */}
			<div
				onMouseDown={onResizeDown}
				title="Resize"
				style={{
					position: 'absolute',
					right: 0,
					bottom: 0,
					width: '14px',
					height: '14px',
					cursor: 'nwse-resize',
					background: 'linear-gradient(135deg, transparent 50%, #4ec94e 50%, #4ec94e 60%, transparent 60%, transparent 72%, #4ec94e 72%, #4ec94e 82%, transparent 82%)',
					opacity: 0.6,
				}}
			/>
		</div>
	);
};

// ── Toolbar injection (raw DOM host + MutationObserver to survive re-renders) ──

/** Find the Save/Remote-API/Kill toolbar row to anchor the gear into, or null. */
function findToolbarRow(): HTMLElement | null {
	const kill = domDocument.querySelector(KILL_ANCHOR);
	if (!kill) return null;
	// button → right-side Box (closest div) → outer flex row Box.
	const rightBox = kill.closest('div');
	return (rightBox?.parentElement as HTMLElement | null) ?? null;
}

/**
 * Ensure the gear host span exists inside the toolbar and the Gear is rendered.
 * Idempotent: re-attaches if the game's re-render detached our host.
 */
function ensureGear(gearHostRef: { node: HTMLElement | null }): void {
	if (gearHostRef.node && domDocument.contains(gearHostRef.node)) return;
	const row = findToolbarRow();
	if (!row) return;
	const host = domDocument.createElement('span');
	host.id = GEAR_ID;
	host.style.display = 'inline-flex';
	host.style.alignItems = 'center';
	row.appendChild(host);
	gearHostRef.node = host;
	ReactDOM.render(<Gear />, host);
}

/** One-time diagnostic dump of toolbar candidates (acts as a live DOM probe). */
function writeMountDiag(ns: NS, anchored: boolean): void {
	const labels: string[] = [];
	domDocument.querySelectorAll('[aria-label]').forEach(el => {
		const l = el.getAttribute('aria-label');
		if (l && labels.length < 60) labels.push(l);
	});
	const row = findToolbarRow();
	const diag = {
		anchored,
		killAnchorFound: domDocument.querySelector(KILL_ANCHOR) !== null,
		rowTag: row?.tagName ?? null,
		rowCls: row?.className?.toString().slice(0, 160) ?? null,
		ariaLabels: labels,
	};
	ns.write('status/ui_mount.json', JSON.stringify(diag, null, 2), 'w');
}

// ── NS loop helpers (all ns.* lives here, outside React) ──────────────────────

/**
 * Build the live MonitorSnapshot (design/08 §4.2). Every read here is cheap and
 * legitimately-held: home RAM/money, total script income, running-script count,
 * and the phase string the detector publishes on PORT_PHASE. No game internals.
 */
function gatherMonitor(ns: NS): MonitorSnapshot {
	return {
		ramUsed:      ns.getServerUsedRam('home'),
		ramMax:       ns.getServerMaxRam('home'),
		money:        ns.getServerMoneyAvailable('home'),
		incomePerSec: ns.getTotalScriptIncome()[0],
		phase:        peekPort(ns, PORT_PHASE) ?? '—',
		scriptCount:  ns.ps('home').length,
	};
}

/**
 * Read the last LOG_TAIL notifications game_agent mirrors to status/notifications.txt
 * (despite the .txt name it holds a JSON array of Notification — see game_agent
 * mirrorNotify). 0 GB ns.read; newest entries are at the tail. Missing/corrupt → [].
 */
function gatherLogs(ns: NS): Notification[] {
	try {
		const raw = ns.read('status/notifications.txt');
		if (!raw || raw.trim() === '') return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.slice(-LOG_TAIL) as Notification[];
	} catch {
		return [];
	}
}

/** Valid page strings (Navigator). Guards the navigate intent against junk pages. */
const PAGE_SET: ReadonlySet<string> = new Set(Object.values(GamePage));

/** Navigate the game to `page` via the Navigator (action-only fiber click; 0 GB). */
function runNavigate(ns: NS, page: string): void {
	if (!PAGE_SET.has(page)) { notify(ns, `Control console: unknown page "${page}" — navigation skipped.`); return; }
	const ok = goTo(page as GamePageValue);
	if (!ok) notify(ns, `Control console: navigation to "${page}" failed.`);
}

/** Join a faction on the user's request via ns_dodge (Singularity cost stays off the loop daemon). */
async function runJoinFaction(ns: NS, faction: string): Promise<void> {
	try {
		const ok = await executeCommand<boolean>(ns, `ns.singularity.joinFaction(${JSON.stringify(faction)})`);
		notify(ns, ok
			? `Control console: joined faction ${faction}.`
			: `Control console: could not join ${faction} (no invitation, or SF4 required).`);
	} catch {
		notify(ns, `Control console: join ${faction} failed (SF4 required?).`);
	}
}

// ── Window-state persistence (Step E) ─────────────────────────────────────────

const UI_STATE_FILE = 'status/ui_state.json';

/** First-run window chrome: closed, parked top-left of the play area, tab = Monitor. */
const DEFAULT_UI: UiState = { open: false, x: 240, y: 120, w: 260, h: 360, activeTab: PANELS[0].id };

/** Read persisted window chrome. Missing/corrupt → DEFAULT_UI; merge guards partial files. */
function loadUiState(ns: NS): UiState {
	try {
		const raw = ns.read(UI_STATE_FILE);
		if (!raw || raw.trim() === '') return DEFAULT_UI;
		const parsed = JSON.parse(raw) as Partial<UiState>;
		const ui: UiState = { ...DEFAULT_UI, ...parsed };
		// A persisted tab whose panel no longer exists falls back to the first tab.
		if (!PANELS.some(p => p.id === ui.activeTab)) ui.activeTab = PANELS[0].id;
		return ui;
	} catch {
		return DEFAULT_UI;
	}
}

/** Persist window chrome (driven by the shell's persistUi intent). */
function saveUiState(ns: NS, ui: UiState): void {
	ns.write(UI_STATE_FILE, JSON.stringify(ui, null, 2), 'w');
}

/** Launch aug_planner --purchase (same path the sequencer uses for auto-buy). */
function runBuyAugs(ns: NS): void {
	if (ns.isRunning(SCRIPT_PATHS.augPlanner, 'home')) return;
	const pid = ns.run(SCRIPT_PATHS.augPlanner, 1, '--purchase');
	notify(ns, pid > 0
		? 'Control console: buying recommended augmentations…'
		: 'Control console: aug_planner failed to start (insufficient RAM?)');
}

/** Install queued augmentations (irreversible) and re-bootstrap after reset. */
async function runReset(ns: NS): Promise<void> {
	notify(ns, 'Control console: installing augmentations and resetting…');
	try {
		// Routes through ns_dodge so the 16 GB Singularity cost isn't charged here.
		// On success the game soft-resets immediately and re-runs /bootstrap.js;
		// nothing after this line executes.
		await executeCommand<void>(ns, 'ns.singularity.installAugmentations("/bootstrap.js")');
	} catch {
		notify(ns, 'Control console: install failed — buy augmentations first, or SF4 is required.');
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	// Singleton guard: if another instance is already running (same filename,
	// different pid) bail before touching the DOM — a second toolbar gear / body
	// portal would double-inject and fight over the same per-PID event names.
	const self = ns.getScriptName();
	const existing = ns.ps().find(p => p.filename === self && p.pid !== ns.pid);
	if (existing) {
		ns.tprint(`Control console already running (pid ${existing.pid}); exiting.`);
		return;
	}

	const eventName = `bb-console-${ns.pid}`;
	let current = loadSettings(ns);
	const initial: ConsoleState = {
		settings: current,
		pendingAugs: parseInt(peekPort(ns, PORT_AUGS) ?? '0', 10),
		monitor: gatherMonitor(ns),
		decisions: loadPending(ns),
		logs: gatherLogs(ns),
		currentPage: currentPage() ?? '',
		player: loadPlayerState(ns),
		subsystems: loadAllSubsystems(ns, SUBSYSTEM_IDS),
	};
	const initialUi = loadUiState(ns);

	// Self-owned floating window host on document.body.
	const panelHost = domDocument.createElement('div');
	panelHost.id = PANEL_HOST_ID;
	domDocument.body.appendChild(panelHost);
	ReactDOM.render(<ConsoleShell initial={initial} initialUi={initialUi} eventName={eventName} />, panelHost);

	// Gear button in the toolbar, kept alive across game re-renders.
	const gearHostRef: { node: HTMLElement | null } = { node: null };
	ensureGear(gearHostRef);
	const observer = new MutationObserver(() => ensureGear(gearHostRef));
	const root = domDocument.getElementById('root');
	if (root) observer.observe(root, { childList: true, subtree: true });

	writeMountDiag(ns, gearHostRef.node !== null);
	ns.print(gearHostRef.node ? 'Control console: gear injected into toolbar' : 'Control console: toolbar anchor not found (see status/ui_mount.json)');

	ns.atExit(() => {
		observer.disconnect();
		ReactDOM.unmountComponentAtNode(panelHost);
		panelHost.remove();
		if (gearHostRef.node) {
			ReactDOM.unmountComponentAtNode(gearHostRef.node);
			gearHostRef.node.remove();
		}
	});

	// Slow-changing data cache (refreshed ~1 Hz in the loop), seeded from `initial`.
	let tick = 0;
	let slowDecisions = initial.decisions;
	let slowLogs = initial.logs;
	let slowPlayer = initial.player;
	let slowSubsystems = initial.subsystems;

	while (true) {
		// 1. Drain queued intents BEFORE publishing state, so the event we dispatch
		//    already reflects the user's edits (no clobber race). Order preserved.
		if (outboundIntents.length) {
			const intents = outboundIntents;
			outboundIntents = [];
			for (const intent of intents) {
				if (intent.kind === 'setSettings') {
					current = intent.settings;
					saveSettings(ns, current);
				} else if (intent.kind === 'buyAugs') {
					runBuyAugs(ns);
				} else if (intent.kind === 'reset') {
					await runReset(ns); // may reset the game; loop ends there
				} else if (intent.kind === 'decide') {
					// Responder only: forward the verdict to the producer (sequencer),
					// which owns applying it + clearing the pending entry.
					pushReply(ns, { id: intent.id, verdict: intent.verdict });
				} else if (intent.kind === 'navigate') {
					runNavigate(ns, intent.page);
				} else if (intent.kind === 'joinFaction') {
					await runJoinFaction(ns, intent.faction);
				} else if (intent.kind === 'persistUi') {
					saveUiState(ns, intent.ui);
				} else if (intent.kind === 'toggleSubsystem') {
					// Flip a subsystem autonomy toggle; the sequencer picks it up next tick.
					current = { ...current, [intent.settingKey]: intent.on };
					saveSettings(ns, current);
				}
			}
		}

		// 2. Re-assert the gear (cheap; covers observer gaps) and publish fresh state.
		ensureGear(gearHostRef);

		// Slow-changing data (file reads) refresh ~1 Hz; fast data (RAM/income,
		// nav highlight, pending-augs) every tick so metrics and the active-page
		// highlight stay smooth without reading three files at the loop rate.
		if (tick % SLOW_REFRESH_EVERY === 0) {
			slowDecisions  = loadPending(ns);
			slowLogs       = gatherLogs(ns);
			slowPlayer     = loadPlayerState(ns);
			slowSubsystems = loadAllSubsystems(ns, SUBSYSTEM_IDS);
		}
		const pendingAugs = parseInt(peekPort(ns, PORT_AUGS) ?? '0', 10);
		domWindow.dispatchEvent(new CustomEvent<ConsoleState>(eventName, {
			detail: { settings: current, pendingAugs, monitor: gatherMonitor(ns), decisions: slowDecisions, logs: slowLogs, currentPage: currentPage() ?? '', player: slowPlayer, subsystems: slowSubsystems },
		}));

		tick++;
		await ns.sleep(CONSOLE_TICK_MS);
	}
}
