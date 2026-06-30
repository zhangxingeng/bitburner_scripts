import type { ReactElement } from 'react';
import type { BrainSettings } from '../lib/settings';
import type { PendingDecision, Verdict } from '../lib/decisions';
import type { Notification } from '../cross/notification';
import type { PlayerSnapshot } from '../lib/player_state';

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
	monitor: MonitorSnapshot;          // MonitorPanel    (Step C)
	decisions: PendingDecision[];      // DecisionsPanel  (Step D) — judgment calls awaiting a verdict
	logs: Notification[];              // LogPanel        (Wave 1-B) — last N from status/notifications.txt
	currentPage: string;               // QuickNavPanel   (Wave 1-A) — Navigator.currentPage() or ''
	player: PlayerSnapshot;            // FactionsPanel   (Wave 1-C) — published by the sequencer
}

/**
 * Persisted window chrome (Step E). The shell owns these values in React state;
 * the loop persists them to status/ui_state.json via the `persistUi` intent and
 * reloads them at startup. Pure data — no ns.* on the React side (§3).
 */
export interface UiState {
	open: boolean;       // window visible?
	x: number;           // top-left x (px)
	y: number;           // top-left y (px)
	w: number;           // width (px)
	h: number;           // height (px)
	activeTab: string;   // id of the visible panel
}

/** Actions a panel (or the shell) can request. The loop drains + performs ns.* work. */
export type Intent =
	| { kind: 'setSettings'; settings: BrainSettings }
	| { kind: 'buyAugs' }
	| { kind: 'reset' }
	| { kind: 'decide'; id: string; verdict: Verdict }
	| { kind: 'navigate'; page: string }          // QuickNav → loop calls Navigator.goTo
	| { kind: 'joinFaction'; faction: string }    // Factions → loop ns_dodge joinFaction
	| { kind: 'persistUi'; ui: UiState };         // shell → loop writes status/ui_state.json

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
