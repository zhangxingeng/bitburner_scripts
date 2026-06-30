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
	autoSolveContracts: boolean;   // default false — manual until solver is leaned (contracts manager)
	autoBuyAugs:        boolean;   // default false — irreversible spend
	autoReset:          boolean;   // default false — point of no return for current node
	autoBitNode:        boolean;   // default false — irreversible strategic fork

	// ── Subsystem manager switches (design/11) — SF/BitNode-gated; default OFF ──
	// Each manager self-guards on availability and no-ops when its SF is absent.
	autoGang:           boolean;   // default false — gang (SF2/BN2)
	autoCorp:           boolean;   // default false — corporation (SF3/BN3) [stub this round]
	autoBladeburner:    boolean;   // default false — bladeburner (SF6/7)
	autoSleeve:         boolean;   // default false — sleeves (SF10/BN10)
	autoStanek:         boolean;   // default false — Stanek's Gift (BN13/SF13)
	autoGrafting:       boolean;   // default false — grafting (BN10/SF10)
	// Already-autonomous engines, now under the unified model (default ON to preserve behavior):
	autoHacknet:        boolean;   // default true  — hacknet node/hash manager
	autoStock:          boolean;   // default true  — stock trading engine

	// ── Tunables ───────────────────────────────────────────────────────────
	brainRamFloorGb:    number;    // default 16   — home RAM needed to auto-start sequencer
	verificationDelayMs: number;   // default 500  — wait after action before read-back
	tickIntervalMs:     number;    // default 5000 — sequencer loop cadence
}

/** Keys of BrainSettings whose value is boolean — i.e. the autonomy toggles. */
export type BooleanSettingKey = {
	[K in keyof BrainSettings]: BrainSettings[K] extends boolean ? K : never;
}[keyof BrainSettings];

export const DEFAULT_SETTINGS: BrainSettings = {
	autoJoinFactions:    true,
	autoBuyPrograms:     true,
	autoSolveContracts:  false,
	autoBuyAugs:         false,
	autoReset:           false,
	autoBitNode:         false,
	autoGang:            false,
	autoCorp:            false,
	autoBladeburner:     false,
	autoSleeve:          false,
	autoStanek:          false,
	autoGrafting:        false,
	autoHacknet:         true,
	autoStock:           true,
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
