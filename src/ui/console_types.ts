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

/** Read-only snapshot the NS loop dispatches to the React tree each tick. */
export interface ConsoleState {
	settings: BrainSettings;
	pendingAugs: number;
	// widened by Step C+ : ram, income, phase, decisions[], notifications[]
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
