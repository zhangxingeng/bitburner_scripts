import type { NS } from '@ns';

/**
 * Shared player-state snapshot contract (docs/design/09-parallel-build-plan.md §2.3).
 *
 * The console UI loop must show faction/aug/character info, but those reads are
 * Singularity calls (16 GB) that we must NOT charge to the cheap per-tick console
 * loop. So the PRODUCER (player_sequencer) gathers them on a slow cadence through
 * ns_dodge and publishes a plain JSON snapshot here; the console CONSUMER reads it
 * with a 0 GB `ns.read`. Same split as decisions.ts (producer writes, UI reads).
 *
 * Capability boundary (§3): this is legitimately-held data the sequencer already
 * gathers — never React/game internals.
 */

export interface PlayerSnapshot {
	ts:           number;    // ms epoch of snapshot (0 = never published)
	factions:     string[];  // joined factions
	invitations:  string[];  // pending faction invitations
	augsOwned:    number;    // installed augmentations
	augsPending:  number;    // purchased/queued, not yet installed
	hackingLevel: number;
	city:         string;
}

export const EMPTY_PLAYER: PlayerSnapshot = {
	ts: 0, factions: [], invitations: [], augsOwned: 0, augsPending: 0, hackingLevel: 0, city: '',
};

const PLAYER_FILE = 'status/player_state.json';

/** Read the published snapshot. Missing/corrupt → EMPTY_PLAYER (ts:0 flags stale). Never throws. */
export function loadPlayerState(ns: NS): PlayerSnapshot {
	try {
		const raw = ns.read(PLAYER_FILE);
		if (!raw || raw.trim() === '') return EMPTY_PLAYER;
		const parsed = JSON.parse(raw) as Partial<PlayerSnapshot>;
		// Merge over EMPTY so a partial/older snapshot can't yield undefined fields.
		return { ...EMPTY_PLAYER, ...parsed };
	} catch {
		return EMPTY_PLAYER;
	}
}

/** Producer side: overwrite the published snapshot. */
export function savePlayerState(ns: NS, s: PlayerSnapshot): void {
	ns.write(PLAYER_FILE, JSON.stringify(s, null, 2), 'w');
}
