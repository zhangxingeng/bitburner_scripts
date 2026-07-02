import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { upsertPending, removePending, drainReplies } from '../lib/decisions';

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
 * Sleeve augmentation purchases (irreversible money spend) are handled as a
 * PARALLEL concern via the shared approve/deny/defer decision queue
 * (lib/decisions.ts, kind 'sleeveSpend') — see checkSleeveAugPurchase() below.
 * They are not part of the task priority ladder above and never override it.
 *
 * NOT automated (flagged TODO(decision)):
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
 *   - ns.sleeve.getSleevePurchasableAugs(i) → {name, cost}[] (augs affordable-shape, NOT owned augs)
 *   - ns.sleeve.purchaseSleeveAug(i, augName) → boolean (real money spend, permanent)
 *   NOTE: getSleeveStats / getInformation were REMOVED in 2.2.0; use getSleeve instead.
 *   NOTE: neither aug call is Singularity-gated (both live under ns.sleeve), so no
 *   ns_dodge/SF4 wrapping is needed here.
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

/**
 * How often (in main-loop ticks, TICK_MS apart) to re-check purchasable sleeve
 * augs. getSleevePurchasableAugs() doesn't change second-to-second — gating it
 * behind a slower cadence avoids needless API-call churn every 5s tick.
 * 6 ticks × 5s ≈ 30s.
 */
const AUG_CHECK_INTERVAL_TICKS = 6;

/** How long a "Defer" verdict suppresses a given sleeve-aug decision (12 × 5s ≈ 1 min). */
const AUG_DECISION_DEFER_TICKS = 12;

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

/**
 * Check whether sleeve `idx` has an affordable augmentation purchase available
 * and, if so, surface it as a pending decision (approve/deny/defer). This is a
 * PARALLEL concern to assignSleeveTask above — augmentation purchases are an
 * irreversible spend, not a "task" a sleeve performs, and never affect the
 * priority ladder. Called only every AUG_CHECK_INTERVAL_TICKS ticks by main().
 *
 * Decision id: `sleeveAug:${idx}:${augName}` — stable per (sleeve, aug) pair,
 * so multiple sleeves (or multiple candidate augs over time for one sleeve)
 * each get their own independent pending entry.
 */
function checkSleeveAugPurchase(
	ns: NS,
	idx: number,
	tick: number,
	deniedAugIds: Set<string>,
	deferUntilTick: Map<string, number>,
): void {
	let augs: ReturnType<typeof ns.sleeve.getSleevePurchasableAugs>;
	try {
		augs = ns.sleeve.getSleevePurchasableAugs(idx);
	} catch {
		return; // API unavailable this tick — next scheduled check will retry.
	}
	if (augs.length === 0) return;

	const cheapest = augs.reduce((a, b) => (b.cost < a.cost ? b : a));
	const id = `sleeveAug:${idx}:${cheapest.name}`;

	// Deny → suppressed indefinitely for this exact pair. Defer → suppressed
	// until the cooldown tick passes.
	if (deniedAugIds.has(id)) return;
	if (tick < (deferUntilTick.get(id) ?? 0)) return;

	if (ns.getPlayer().money < cheapest.cost) return; // not affordable yet — don't surface prematurely

	const added = upsertPending(ns, {
		id,
		kind: 'sleeveSpend',
		prompt: `Sleeve ${idx}: buy augmentation "${cheapest.name}" for $${cheapest.cost.toLocaleString()}?`,
		command: `sleeve.purchaseSleeveAug(${idx}, "${cheapest.name}")`,
		context: { sleeveIdx: idx, augName: cheapest.name, cost: cheapest.cost },
		ts: Date.now(),
	});
	if (added) {
		ns.print(`DECISION sleeve ${idx} aug purchase surfaced: ${cheapest.name} ($${cheapest.cost.toLocaleString()})`);
	}
}

/**
 * Apply verdicts on pending sleeve-aug decisions. Drained every main-loop tick
 * (independent of AUG_CHECK_INTERVAL_TICKS) so a verdict is acted on promptly.
 * Mirrors the drain/apply pattern proven in cross/player_sequencer.ts.
 */
function applySleeveAugReplies(
	ns: NS,
	tick: number,
	deniedAugIds: Set<string>,
	deferUntilTick: Map<string, number>,
): void {
	for (const reply of drainReplies(ns)) {
		if (!reply.id.startsWith('sleeveAug:')) continue; // not ours — leave to its owner
		removePending(ns, reply.id);

		const [, idxStr, ...augNameParts] = reply.id.split(':');
		const idx = Number(idxStr);
		const augName = augNameParts.join(':');

		if (reply.verdict === 'approve') {
			let ok = false;
			try {
				ok = ns.sleeve.purchaseSleeveAug(idx, augName);
			} catch (e) {
				ns.print(`WARN: purchaseSleeveAug(${idx}, ${augName}) threw: ${String(e)}`);
			}
			ns.print(ok
				? `DECISION approved — sleeve ${idx} bought "${augName}"`
				: `WARN: sleeve ${idx} purchase of "${augName}" returned false (money/state may have changed)`);
		} else if (reply.verdict === 'deny') {
			deniedAugIds.add(reply.id);
			ns.print(`DECISION denied — sleeve ${idx} aug "${augName}" suppressed`);
		} else if (reply.verdict === 'defer') {
			deferUntilTick.set(reply.id, tick + AUG_DECISION_DEFER_TICKS);
			ns.print(`DECISION deferred — sleeve ${idx} aug "${augName}" re-surfacing in ${AUG_DECISION_DEFER_TICKS} ticks`);
		}
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	// ── Sleeve-aug decision suppression state (Step D — DecisionsPanel) ───────
	// Keyed by decision id (`sleeveAug:${idx}:${augName}`); persists in-memory
	// for the life of this daemon, mirroring cross/player_sequencer.ts's pattern.
	const deniedAugIds   = new Set<string>();
	const deferUntilTick = new Map<string, number>();
	let   tick = 0;

	while (true) {
		tick++;

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

		// ── Apply human/MCP verdicts on any pending sleeve-aug decisions ──────
		// Drained every tick regardless of the slower surfacing cadence below,
		// so a verdict is acted on promptly once given.
		applySleeveAugReplies(ns, tick, deniedAugIds, deferUntilTick);

		// ── Sleeve management loop ────────────────────────────────────────────

		const tasks: string[] = [];
		let   totalShock = 0;
		let   totalSync  = 0;

		for (let i = 0; i < numSleeves; i++) {
			const task = assignSleeveTask(ns, i);
			tasks.push(`s${i}:${task}`);

			// Augmentation-purchase decision surfacing — parallel concern, does not
			// affect `task` above. Cheap-but-not-free API call, so gated to a slower
			// cadence than the main 5s tick.
			if (tick % AUG_CHECK_INTERVAL_TICKS === 0) {
				checkSleeveAugPurchase(ns, i, tick, deniedAugIds, deferUntilTick);
			}

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
