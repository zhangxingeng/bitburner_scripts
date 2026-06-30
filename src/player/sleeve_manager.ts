import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';

/**
 * Sleeve manager (docs/design/11) — persistent daemon.
 *
 * Availability: SF10 or BN10 (checked each tick via try/catch on getNumSleeves).
 * When unavailable: publishes {available:false} and idles — does NOT exit, so the
 * sequencer keeps it alive to pick up availability after a dev-cheat SF grant.
 *
 * Strategy (SAFE auto — conservative defaults, no irreversible spends):
 *   1. shock > SHOCK_HIGH_THRESHOLD  → shock recovery (always)
 *   2. sync < 100                    → synchronize
 *   3. any physical stat < GYM_TARGET → gym workout at Powerhouse Gym (Sector-12)
 *   4. shock > 0                     → finish shock recovery before crime
 *   5. default                       → commit Homicide (karma/money grind)
 *
 * NOT automated (flagged TODO(decision)):
 *   - Sleeve augmentation purchases
 *   - Sleeve memory upgrades (no API — must be done at The Covenant UI)
 *   - Following player faction/company work (requires ns.singularity — too costly here)
 *   - Bladeburner sleeve actions
 *
 * API signatures confirmed against bitburner-src/src/NetscriptFunctions/Sleeve.ts (2025).
 *   - ns.sleeve.getNumSleeves() → number
 *   - ns.sleeve.getSleeve(i) → { shock, sync, city, skills: { strength, defense, dexterity, agility, hacking, charisma }, hp, ... }
 *   - ns.sleeve.setToShockRecovery(i) → boolean
 *   - ns.sleeve.setToSynchronize(i) → boolean
 *   - ns.sleeve.setToGymWorkout(i, gymName: GymLocationName, stat: GymType) → boolean
 *   - ns.sleeve.setToCommitCrime(i, crimeType: CrimeType) → boolean
 *   - ns.sleeve.travel(i, city: CityName) → boolean
 *   - ns.sleeve.getTask(i) → task object | null
 *   NOTE: getSleeveStats / getInformation were REMOVED in 2.2.0; use getSleeve instead.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Sleeve manager tick when sleeves are available. */
const TICK_MS = 5_000;

/** Tick when sleeves are unavailable (longer idle saves RAM cycles). */
const IDLE_MS = 10_000;

/**
 * Shock threshold above which a sleeve is forced into recovery regardless of
 * other priorities. Recovery continues each tick until shock drops below this.
 * 0 = recover fully before doing anything else.
 */
const SHOCK_HIGH_THRESHOLD = 97;

/**
 * Conservative gym targets (base skill levels). Sleeves train at Powerhouse Gym
 * in Sector-12 until these are reached, then switch to crime. Kept low so we
 * don't burn player money for long; bump in settings once cash flow is stable.
 */
const GYM_TARGETS: Record<string, number> = {
	str: 50,
	def: 50,
	dex: 50,
	agi: 50,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Test sleeve API access without throwing into the outer loop.
 * Returns the count of available sleeves (≥1) or 0/throws if unavailable.
 */
function tryGetNumSleeves(ns: NS): number {
	try {
		return ns.sleeve.getNumSleeves();
	} catch {
		return 0;
	}
}

/**
 * Assign the best task for one sleeve based on the conservative priority ladder.
 * Returns a short description of the assigned task.
 */
function assignSleeveTask(ns: NS, idx: number): string {
	let sleeve: ReturnType<typeof ns.sleeve.getSleeve>;
	try {
		sleeve = ns.sleeve.getSleeve(idx);
	} catch (e) {
		return `error:getSleeve(${String(e)})`;
	}

	const { shock, sync, city, skills } = sleeve;

	// Priority 1 — high shock: always recover first.
	if (shock > SHOCK_HIGH_THRESHOLD) {
		ns.sleeve.setToShockRecovery(idx);
		return `shock-recovery (shock=${shock.toFixed(1)}%)`;
	}

	// Priority 2 — synchronize (memory sync unlocks better task effectiveness).
	if (sync < 100) {
		ns.sleeve.setToSynchronize(idx);
		return `synchronize (sync=${sync.toFixed(1)}%)`;
	}

	// Priority 3 — gym training for low physical stats.
	// Travel to Sector-12 if needed (one-time cost per city change, cheap).
	const gymStats: Array<{ key: 'strength' | 'defense' | 'dexterity' | 'agility'; stat: 'str' | 'def' | 'dex' | 'agi' }> = [
		{ key: 'strength',  stat: 'str' },
		{ key: 'defense',   stat: 'def' },
		{ key: 'dexterity', stat: 'dex' },
		{ key: 'agility',   stat: 'agi' },
	];
	for (const { key, stat } of gymStats) {
		const target = GYM_TARGETS[stat] ?? 0;
		if (skills[key] < target) {
			const gymCity = ns.enums.CityName.Sector12;
			if (city !== gymCity) {
				ns.sleeve.travel(idx, gymCity);
			}
			const gym = ns.enums.LocationName.Sector12PowerhouseGym;
			ns.sleeve.setToGymWorkout(idx, gym, stat);
			return `gym-${key} (${skills[key]}/${target})`;
		}
	}

	// Priority 4 — finish residual shock before crime.
	if (shock > 0) {
		ns.sleeve.setToShockRecovery(idx);
		return `shock-recovery (partial, shock=${shock.toFixed(1)}%)`;
	}

	// Priority 5 — commit Homicide for karma (crucial for gang unlock).
	// TODO(decision): switch to faction work once player is in a faction with a sleeve slot.
	ns.sleeve.setToCommitCrime(idx, ns.enums.CrimeType.homicide);
	return `crime:Homicide`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	while (true) {
		const settings  = loadSettings(ns);
		const enabled   = settings.autoSleeve;
		const numSleeves = tryGetNumSleeves(ns);
		const available  = numSleeves > 0;

		if (!available) {
			// Feature absent: idle and keep daemon alive.
			const status: SubsystemStatus = {
				id:        'sleeve',
				available: false,
				enabled,
				running:   false,
				headline:  'Sleeves unavailable (need SF10/BN10)',
				metrics:   {},
				ts:        Date.now(),
			};
			saveSubsystem(ns, status);
			await ns.sleep(IDLE_MS);
			continue;
		}

		// ── Sleeve management loop ────────────────────────────────────────────

		const tasks: string[] = [];
		let   totalShock = 0;
		let   totalSync  = 0;

		for (let i = 0; i < numSleeves; i++) {
			const task = assignSleeveTask(ns, i);
			tasks.push(`s${i}:${task}`);

			// Accumulate metrics (tolerates getSleeve failures — task already handled them).
			try {
				const sl = ns.sleeve.getSleeve(i);
				totalShock += sl.shock;
				totalSync  += sl.sync;
			} catch {
				// Sleeve data unavailable this tick; count contributes 0.
			}
		}

		const avgShock = numSleeves > 0 ? totalShock / numSleeves : 0;
		const avgSync  = numSleeves > 0 ? totalSync  / numSleeves : 0;

		// Build headline: summarise what most sleeves are doing.
		const taskSummary = tasks.slice(0, 4).join(', ') + (tasks.length > 4 ? ` +${tasks.length - 4}` : '');
		const headline = enabled
			? `Sleeves(${numSleeves}) shock=${avgShock.toFixed(1)}% sync=${avgSync.toFixed(1)}% | ${taskSummary}`
			: `Sleeves(${numSleeves}) — autoSleeve OFF (monitoring only)`;

		const status: SubsystemStatus = {
			id:        'sleeve',
			available: true,
			enabled,
			running:   enabled,
			headline,
			metrics: {
				count:    numSleeves,
				avgShock: Number(avgShock.toFixed(2)),
				avgSync:  Number(avgSync.toFixed(2)),
				tasks:    tasks.join(' | '),
			},
			ts: Date.now(),
		};
		saveSubsystem(ns, status);

		await ns.sleep(TICK_MS);
	}
}
