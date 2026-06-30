import type { ReactElement } from 'react';
import type { BrainSettings } from '../lib/settings';

/**
 * Shared types for the Central Control Console (docs/design/08-control-console.md).
 *
 * The console is a panel-registry shell: the NS loop publishes a read-only
 * `ConsoleState` snapshot each tick, the React tree renders registered `Panel`s
 * against it, and panels push `Intent`s back through `dispatch` into a
 * module-level outbound queue the loop drains. No ns.* ever runs in React (§3).
 *
 * Step A keeps `ConsoleState` minimal (the milestone-2 fields). It widens in
 * later steps (RAM/income/phase for MonitorPanel, decisions[] for DecisionsPanel).
 */

/**
 * Live system metrics gathered by the NS loop each tick (Step C — MonitorPanel).
 * All fields come from cheap, legitimately-held ns.* reads (home RAM, money,
 * script income) plus the phase string the detector publishes on PORT_PHASE —
 * never from React/game internals (§3 capability boundary).
 */
export interface MonitorSnapshot {
	ramUsed: number;       // home used RAM (GB)
	ramMax: number;        // home max RAM (GB)
	money: number;         // current money ($)
	incomePerSec: number;  // total script income ($/s)
	phase: string;         // DesignPhase string from PORT_PHASE ('—' if unset)
	scriptCount: number;   // running scripts on home
}

/** Read-only snapshot the NS loop dispatches to the React tree each tick. */
export interface ConsoleState {
	settings: BrainSettings;
	pendingAugs: number;
	monitor: MonitorSnapshot;
	// widened further in Step D+ : decisions[], notifications[]
}

/** Actions a panel can request. The loop drains the queue and performs the ns.* work. */
export type Intent =
	| { kind: 'setSettings'; settings: BrainSettings }
	| { kind: 'buyAugs' }
	| { kind: 'reset' };

export type Dispatch = (intent: Intent) => void;

/**
 * A registered console panel. Adding a feature = add a panel module + register it
 * in the shell's PANELS list; the shell itself never changes. `render` is pure
 * presentation over (state, dispatch) — no ns.*, no side effects beyond dispatch.
 */
export interface Panel {
	id: string;
	title: string;
	render: (state: ConsoleState, dispatch: Dispatch) => ReactElement;
}
