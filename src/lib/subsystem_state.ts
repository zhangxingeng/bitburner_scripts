import type { NS } from '@ns';

/**
 * Generic subsystem-status contract (docs/design/11 §3.2).
 *
 * Every player-subsystem manager (gang, corp, bladeburner, sleeve, stanek,
 * grafting, contracts, hacknet, stock) publishes ONE of these each loop to
 * `status/subsystems/<id>.json`. The control console reads them (0 GB) to render
 * the Subsystems overview + per-subsystem detail. Same producer-writes /
 * UI-reads split as player_state.ts and decisions.ts.
 *
 * `available` (SF/BitNode present & feature usable) is decided by the manager
 * itself; a manager that finds its feature absent publishes `available:false`
 * and idles — it does NOT exit (so the sequencer keeps it alive and it picks up
 * availability later, e.g. after a dev-cheat SF grant).
 */

export interface SubsystemStatus {
	id:        string;                              // 'gang' | 'corp' | 'bladeburner' | …
	available: boolean;                             // SF/BitNode present & feature usable
	enabled:   boolean;                             // settings toggle (manager's view of it)
	running:   boolean;                             // manager is actively managing (vs idling)
	headline:  string;                              // one-line state for the overview row
	metrics:   Record<string, number | string>;    // detail rows for the per-subsystem view
	ts:        number;                              // ms epoch (0 = never published)
}

export function emptySubsystem(id: string): SubsystemStatus {
	return { id, available: false, enabled: false, running: false, headline: '', metrics: {}, ts: 0 };
}

const DIR = 'status/subsystems';
const fileFor = (id: string): string => `${DIR}/${id}.json`;

/** Read one subsystem's status. Missing/corrupt → empty (ts:0 flags stale). Never throws. */
export function loadSubsystem(ns: NS, id: string): SubsystemStatus {
	try {
		const raw = ns.read(fileFor(id));
		if (!raw || raw.trim() === '') return emptySubsystem(id);
		const parsed = JSON.parse(raw) as Partial<SubsystemStatus>;
		return { ...emptySubsystem(id), ...parsed, id };
	} catch {
		return emptySubsystem(id);
	}
}

/** Producer side: publish a subsystem's status. */
export function saveSubsystem(ns: NS, s: SubsystemStatus): void {
	ns.write(fileFor(s.id), JSON.stringify(s, null, 2), 'w');
}

/** Read several subsystems' statuses (console convenience). */
export function loadAllSubsystems(ns: NS, ids: readonly string[]): SubsystemStatus[] {
	return ids.map(id => loadSubsystem(ns, id));
}
