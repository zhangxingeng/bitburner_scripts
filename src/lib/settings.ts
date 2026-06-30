import type { NS } from '@ns';

// ── Brain autonomy settings (docs/design/05-thread-p-sequencing.md §1) ────────
//
// Single source of truth for what the player_sequencer may do unattended.
// Judgment items default OFF (human decides irreversible spends).
// The control console's ConfigPanel renders these as toggles and writes changes back.
// No module except this file defines defaults; all callers import DEFAULT_SETTINGS
// and/or call loadSettings(ns).

export interface BrainSettings {
	// ── Autonomy switches (judgment items default OFF) ─────────────────────
	autoJoinFactions:   boolean;   // default true  — safe; fully reversible
	autoBuyPrograms:    boolean;   // default true  — safe; fully reversible
	autoSolveContracts: boolean;   // default false — manual until solver is leaned
	autoBuyAugs:        boolean;   // default false — irreversible spend
	autoReset:          boolean;   // default false — point of no return for current node
	autoBitNode:        boolean;   // default false — irreversible strategic fork

	// ── Tunables ───────────────────────────────────────────────────────────
	brainRamFloorGb:    number;    // default 16   — home RAM needed to auto-start sequencer
	verificationDelayMs: number;   // default 500  — wait after action before read-back
	tickIntervalMs:     number;    // default 5000 — sequencer loop cadence
}

export const DEFAULT_SETTINGS: BrainSettings = {
	autoJoinFactions:    true,
	autoBuyPrograms:     true,
	autoSolveContracts:  false,
	autoBuyAugs:         false,
	autoReset:           false,
	autoBitNode:         false,
	brainRamFloorGb:     16,
	verificationDelayMs: 500,
	tickIntervalMs:      5000,
};

// ── Persistence (status/settings.json) ───────────────────────────────────────
//
// The UI writes overrides here; the sequencer and any other module calls
// loadSettings(ns) to pick them up.  Missing or corrupt file → DEFAULT_SETTINGS.
// Only ns.read / ns.write are used — both are ~0 GB via the file API.

const SETTINGS_FILE = 'status/settings.json';

/**
 * Load BrainSettings from `status/settings.json`, shallow-merging any stored
 * overrides onto DEFAULT_SETTINGS.  A missing or invalid file returns
 * DEFAULT_SETTINGS unchanged — never throws.
 */
export function loadSettings(ns: NS): BrainSettings {
	try {
		const raw = ns.read(SETTINGS_FILE);
		if (!raw || raw.trim() === '') return { ...DEFAULT_SETTINGS };
		const overrides = JSON.parse(raw) as Partial<BrainSettings>;
		return { ...DEFAULT_SETTINGS, ...overrides };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * Persist `settings` to `status/settings.json` (overwrite mode).
 * Called by the control console's NS loop when it drains a setSettings intent.
 */
export function saveSettings(ns: NS, settings: BrainSettings): void {
	ns.write(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'w');
}
