import type { NS } from '@ns';
import { React, ReactDOM, domWindow, domDocument } from '../lib/react';
import { BrainSettings, loadSettings, saveSettings } from '../lib/settings';
import { SCRIPT_PATHS } from '../lib/config';
import { PORT_AUGS, peekPort } from '../lib/ports';
import { notify } from '../cross/notification';
import { executeCommand } from '../lib/ns_dodge';

/**
 * Config Dashboard — the human steering panel for the Thread-P brain.
 *
 * Minimal-footprint UI (docs/design/05-thread-p-sequencing.md §8): injects a
 * single ⚙ gear button into the game toolbar (next to Save / Kill / Remote API);
 * clicking it toggles a self-owned floating panel mounted on document.body, fully
 * under our control, that renders BrainSettings as live toggles plus two action
 * buttons. We never colonise the game's own layout beyond that one gear.
 *
 * NS-safety contract (§3): no ns.* call ever runs inside the React tree. Toggle
 * and button handlers only mutate plain module-level mailboxes; the NS main loop
 * drains them each tick and performs all ns.* work (saveSettings, ns.run,
 * Singularity install via ns_dodge). Fresh state flows back to the panel over a
 * per-PID DOM CustomEvent.
 *
 * Mount:  ns.run('/ui/config_dashboard.js', 'home', 1)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const GEAR_ID = 'bb-brain-gear';
const PANEL_HOST_ID = 'bb-brain-panel-host';
const TOGGLE_EVENT = 'bb-brain-panel-toggle';

/**
 * Stable toolbar anchor (docs/design/06-ui-navigation.md §4, from bitburner-src
 * CharacterOverview.tsx). The Save / Remote-API / Kill-all row is a class-less
 * flex Box; the "kill all scripts" IconButton is the only stable hook. Its
 * grandparent (button → right Box → row) is the row we append the gear into.
 */
const KILL_ANCHOR = '[aria-label="kill all scripts"]';

type ToggleKey =
	| 'autoJoinFactions'
	| 'autoBuyPrograms'
	| 'autoSolveContracts'
	| 'autoBuyAugs'
	| 'autoReset'
	| 'autoBitNode';

const TOGGLES: { key: ToggleKey; label: string }[] = [
	{ key: 'autoJoinFactions',   label: 'Auto-join factions' },
	{ key: 'autoBuyPrograms',    label: 'Auto-buy programs' },
	{ key: 'autoSolveContracts', label: 'Auto-solve contracts' },
	{ key: 'autoBuyAugs',        label: 'Auto-buy augs' },
	{ key: 'autoReset',          label: 'Auto-reset' },
	{ key: 'autoBitNode',        label: 'Auto-BitNode' },
];

// ── Loop ↔ React mailboxes (plain values — never touched by ns.* in React) ────

interface PanelState {
	settings: BrainSettings;
	pendingAugs: number;
}

/** Set by the React toggle handlers; drained + persisted by the NS loop. */
let outboundSettings: BrainSettings | null = null;
/** Set by the React button handlers; drained + executed by the NS loop. */
let outboundAction: 'buyAugs' | 'reset' | null = null;

// ── Presentational components ─────────────────────────────────────────────────

const Toggle = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) => (
	<div
		onClick={onClick}
		style={{
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			cursor: 'pointer',
			padding: '3px 7px',
			margin: '2px 0',
			borderRadius: '3px',
			border: '1px solid #2a2a2a',
			background: on ? 'rgba(0,160,0,0.18)' : 'transparent',
			color: on ? '#4ec94e' : '#999',
		}}
	>
		<span>{label}</span>
		<span style={{ fontWeight: 'bold' }}>{on ? 'ON' : 'OFF'}</span>
	</div>
);

const ActionButton = ({ label, bg, onClick }: { label: string; bg: string; onClick: () => void }) => (
	<div
		onClick={onClick}
		style={{
			flex: 1,
			textAlign: 'center',
			cursor: 'pointer',
			padding: '5px 6px',
			margin: '2px',
			borderRadius: '4px',
			background: bg,
			color: 'white',
			fontWeight: 'bold',
			userSelect: 'none',
		}}
	>
		{label}
	</div>
);

/** The ⚙ gear injected into the game toolbar. Dispatches the toggle event only. */
const Gear = () => (
	<span
		title="Brain Config"
		onClick={() => domWindow.dispatchEvent(new Event(TOGGLE_EVENT))}
		style={{
			cursor: 'pointer',
			font: 'inherit',
			color: 'inherit',
			fontSize: '1.2em',
			padding: '0 6px',
			userSelect: 'none',
			lineHeight: 1,
		}}
	>
		⚙
	</span>
);

/** Self-owned floating window: draggable, toggled by the gear, mounted on body. */
const FloatingPanel = ({
	initial,
	eventName,
	onToggle,
	onBuyAugs,
	onReset,
}: {
	initial: PanelState;
	eventName: string;
	onToggle: (next: BrainSettings) => void;
	onBuyAugs: () => void;
	onReset: () => void;
}) => {
	const [state, setState] = React.useState<PanelState>(initial);
	const [open, setOpen] = React.useState<boolean>(false);
	const [pos, setPos] = React.useState<{ x: number; y: number }>({ x: 240, y: 120 });
	const drag = React.useRef<{ dx: number; dy: number } | null>(null);

	// Fresh state from the NS loop.
	React.useEffect(() => {
		const handler = (e: Event) => setState((e as CustomEvent<PanelState>).detail);
		domWindow.addEventListener(eventName, handler);
		return () => domWindow.removeEventListener(eventName, handler);
	}, [eventName]);

	// Gear toggle.
	React.useEffect(() => {
		const handler = () => setOpen(o => !o);
		domWindow.addEventListener(TOGGLE_EVENT, handler);
		return () => domWindow.removeEventListener(TOGGLE_EVENT, handler);
	}, []);

	if (!open) return null;

	const flip = (key: ToggleKey) => {
		const next = { ...state.settings, [key]: !state.settings[key] };
		setState({ ...state, settings: next }); // optimistic; loop confirms next tick
		onToggle(next);
	};

	const onDown = (e: React.MouseEvent) => { drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }; };
	const onMove = (e: React.MouseEvent) => { if (drag.current) setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }); };
	const onUp = () => { drag.current = null; };

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
				width: '240px',
				background: 'rgba(0,0,0,0.92)',
				border: '1px solid #4ec94e',
				borderRadius: '6px',
				color: '#cfcfcf',
				fontFamily: 'Consolas, monospace',
				fontSize: '12px',
				boxShadow: '0 4px 18px rgba(0,0,0,0.6)',
			}}
		>
			<div
				onMouseDown={onDown}
				style={{
					cursor: 'move',
					padding: '5px 8px',
					borderBottom: '1px solid #2a6f2a',
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					color: '#4ec94e',
					fontWeight: 'bold',
				}}
			>
				<span>⚙ Brain Config</span>
				<span style={{ cursor: 'pointer' }} onClick={() => setOpen(false)}>✕</span>
			</div>
			<div style={{ padding: '6px 8px' }}>
				{TOGGLES.map(t => (
					<Toggle key={t.key} label={t.label} on={state.settings[t.key]} onClick={() => flip(t.key)} />
				))}
				<div style={{ color: '#bbb', margin: '6px 0 3px' }}>
					Pending augs: <span style={{ color: '#e0c050' }}>{state.pendingAugs}</span>
				</div>
				<div style={{ display: 'flex' }}>
					<ActionButton label="Buy augs" bg="#2a6f2a" onClick={onBuyAugs} />
					<ActionButton label="Reset now" bg="#8a2a2a" onClick={onReset} />
				</div>
			</div>
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

/** Launch aug_planner --purchase (same path the sequencer uses for auto-buy). */
function runBuyAugs(ns: NS): void {
	if (ns.isRunning(SCRIPT_PATHS.augPlanner, 'home')) return;
	const pid = ns.run(SCRIPT_PATHS.augPlanner, 1, '--purchase');
	notify(ns, pid > 0
		? 'Config panel: buying recommended augmentations…'
		: 'Config panel: aug_planner failed to start (insufficient RAM?)');
}

/** Install queued augmentations (irreversible) and re-bootstrap after reset. */
async function runReset(ns: NS): Promise<void> {
	notify(ns, 'Config panel: installing augmentations and resetting…');
	try {
		// Routes through ns_dodge so the 16 GB Singularity cost isn't charged here.
		// On success the game soft-resets immediately and re-runs /bootstrap.js;
		// nothing after this line executes.
		await executeCommand<void>(ns, 'ns.singularity.installAugmentations("/bootstrap.js")');
	} catch {
		notify(ns, 'Config panel: install failed — buy augmentations first, or SF4 is required.');
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	const eventName = `bb-config-${ns.pid}`;
	let current = loadSettings(ns);
	const initial: PanelState = { settings: current, pendingAugs: parseInt(peekPort(ns, PORT_AUGS) ?? '0', 10) };

	// Self-owned floating panel host on document.body.
	const panelHost = domDocument.createElement('div');
	panelHost.id = PANEL_HOST_ID;
	domDocument.body.appendChild(panelHost);
	ReactDOM.render(
		<FloatingPanel
			initial={initial}
			eventName={eventName}
			onToggle={next => { outboundSettings = next; }}
			onBuyAugs={() => { outboundAction = 'buyAugs'; }}
			onReset={() => { outboundAction = 'reset'; }}
		/>,
		panelHost,
	);

	// Gear button in the toolbar, kept alive across game re-renders.
	const gearHostRef: { node: HTMLElement | null } = { node: null };
	ensureGear(gearHostRef);
	const observer = new MutationObserver(() => ensureGear(gearHostRef));
	const root = domDocument.getElementById('root');
	if (root) observer.observe(root, { childList: true, subtree: true });

	writeMountDiag(ns, gearHostRef.node !== null);
	ns.print(gearHostRef.node ? 'Config dashboard: gear injected into toolbar' : 'Config dashboard: toolbar anchor not found (see status/ui_mount.json)');

	ns.atExit(() => {
		observer.disconnect();
		ReactDOM.unmountComponentAtNode(panelHost);
		panelHost.remove();
		if (gearHostRef.node) {
			ReactDOM.unmountComponentAtNode(gearHostRef.node);
			gearHostRef.node.remove();
		}
	});

	while (true) {
		// 1. Drain a pending settings edit BEFORE reading state back, so the event
		//    we dispatch already reflects the user's toggle (no clobber race).
		if (outboundSettings) {
			current = outboundSettings;
			outboundSettings = null;
			saveSettings(ns, current);
		}

		// 2. Drain a pending button action.
		if (outboundAction === 'buyAugs') {
			outboundAction = null;
			runBuyAugs(ns);
		} else if (outboundAction === 'reset') {
			outboundAction = null;
			await runReset(ns); // may reset the game; loop ends there
		}

		// 3. Re-assert the gear (cheap; covers observer gaps) and push fresh state.
		ensureGear(gearHostRef);
		const pendingAugs = parseInt(peekPort(ns, PORT_AUGS) ?? '0', 10);
		domWindow.dispatchEvent(new CustomEvent<PanelState>(eventName, { detail: { settings: current, pendingAugs } }));

		await ns.sleep(current.tickIntervalMs);
	}
}
