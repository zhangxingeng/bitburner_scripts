import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { upsertPending, removePending, drainReplies } from '../lib/decisions';

/**
 * Gang manager (docs/design/11) — Wave 1 implementation.
 *
 * Contract: a PERSISTENT daemon. Each loop, check feature availability; if absent
 * publish { available:false } and idle (DO NOT exit — the sequencer keeps it
 * alive so it picks up availability after a dev-cheat SF grant). When available,
 * do the management work, publish live metrics, and surface irreversible/scarce
 * spends as decisions (lib/decisions.ts) rather than auto-spending.
 *
 * Reference: example_code_dump/alainbryden-bitburner-scripts/gangs.js
 * API verified against: bitburner-src/src/NetscriptFunctions/Gang.ts
 */

// ── tuning constants ──────────────────────────────────────────────────────────
const SLEEP_UNAVAIL           = 10_000; // ms — poll cadence when gang unavailable
const SLEEP_TICK              =  5_000; // ms — management loop cadence
const WANTED_PENALTY_FLOOR    =   0.99; // wantedPenalty below this → assign members to vigilante
const ASCEND_MULTI_THRESHOLD  =   1.05; // ascend if any primary stat mult gain ≥ this ratio
const EQUIP_BUDGET_FRACTION   =  0.001; // max fraction of player cash to spend on equipment per tick
const AUG_BUDGET_FRACTION     =  0.050; // larger budget for augmentations (permanent)
const TRAIN_TICKS_AFTER_EVENT =      5; // ticks a freshly recruited/ascended member spends training

// Territory warfare heuristic (decision-gated — see step 5 in main()):
//   • ENGAGE (risky — can kill members) only when win chance against every active
//     rival (territory > 0) is comfortably above a coin-flip.
//   • DISENGAGE (safe — no gate needed) once the worst win chance slips below a
//     lower floor. The gap between the two thresholds is a hysteresis band so we
//     don't flip-flop every tick when a clash chance sits right at the edge.
const WARFARE_WIN_CHANCE_MIN      =  0.65; // engage threshold — "comfortably" above 50%
const WARFARE_DISENGAGE_THRESHOLD =  0.55; // disengage threshold — below this, bail out
const WARFARE_DENY_IMPROVE_MARGIN =  0.05; // after a deny, require this much improvement before re-asking
const WARFARE_DEFER_TICKS         =    12; // ticks a "defer" verdict suppresses re-asking (12 × 5s ≈ 1 min)
const GANG_WARFARE_DECISION_ID    = 'gangWarfare'; // stable id — only ever one gang

// Gang factions ordered by combat power (highest first); NiteSec/TheBlackHand are hacking gangs.
// createGang() returns false if preconditions aren't met, so we safely try each.
const GANG_FACTIONS_ORDERED = [
	'Speakers for the Dead',
	'The Dark Army',
	'The Syndicate',
	'Tetrads',
	'Slum Snakes',
	'The Black Hand',
	'NiteSec',
] as const;

// Task names — verified against bitburner-src/src/Gang/data/tasks.ts
function wantedReductionTask(isHacking: boolean): string {
	return isHacking ? 'Ethical Hacking' : 'Vigilante Justice';
}
function primaryTrainingTask(isHacking: boolean): string {
	return isHacking ? 'Train Hacking' : 'Train Combat';
}

// Crimes ordered safest → highest respect/money (for each gang type)
const HACK_CRIMES = [
	'Ransomware', 'Phishing', 'Identity Theft', 'DDoS Attacks',
	'Plant Virus', 'Fraud & Counterfeiting', 'Money Laundering', 'Cyberterrorism',
];
const COMBAT_CRIMES = [
	'Mug People', 'Deal Drugs', 'Strongarm Civilians', 'Run a Con',
	'Armed Robbery', 'Traffick Illegal Arms', 'Threaten & Blackmail',
	'Human Trafficking', 'Terrorism',
];

// ── loop-persistent state ─────────────────────────────────────────────────────
// Per-member timestamp until which they should train (after recruit or ascend)
const trainUntilMs: Record<string, number> = {};

// ── main ──────────────────────────────────────────────────────────────────────
export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	// ── territory-warfare decision suppression (mirrors player_sequencer's
	// AUG_DECISION_ID pattern: a "denied until state improves" gate plus a
	// "deferred until tick N" cooldown) ──────────────────────────────────────
	let warfareDeniedAtWinChance = -1; // deny → don't re-ask until worst win chance exceeds this + margin
	let warfareDeferUntilTick    =  0; // defer → don't re-ask until this tick
	let lastWorstWinChance       =  0; // most recent assessment, captured for use by a deny verdict
	let tick = 0;

	while (true) {
		tick++;
		const enabled = loadSettings(ns).autoGang;

		// ── availability ───────────────────────────────────────────────────
		let available = false;
		try {
			available = ns.gang.inGang();
			if (!available) {
				// Attempt to create a gang: canCreateGang (called internally) checks
				// SF2 / karma ≤ −54 000 / faction membership. Returns false if not ready.
				for (const faction of GANG_FACTIONS_ORDERED) {
					if (ns.gang.createGang(faction)) { available = true; break; }
				}
			}
		} catch {
			available = false;
		}

		if (!available) {
			saveSubsystem(ns, {
				id: 'gang', available: false, enabled, running: false,
				headline: 'Gang unavailable (need SF2/BN2 + karma −54 000 + faction membership)',
				metrics: {}, ts: Date.now(),
			});
			await ns.sleep(SLEEP_UNAVAIL);
			continue;
		}

		// ── management tick ────────────────────────────────────────────────
		try {
			const gangInfo = ns.gang.getGangInformation();
			const isHacking = gangInfo.isHacking;

			// 1. Recruit all available slots
			while (ns.gang.canRecruitMember()) {
				const name = nextMemberName(ns.gang.getMemberNames());
				if (!ns.gang.recruitMember(name)) break; // name collision unlikely but guard it
				trainUntilMs[name] = Date.now() + TRAIN_TICKS_AFTER_EVENT * SLEEP_TICK;
				ns.print(`INFO gang_manager: recruited "${name}"`);
			}

			const members = ns.gang.getMemberNames();

			// 2. Ascend worthwhile members (before buying gear — cheaper post-ascend)
			for (const name of members) {
				try {
					const result = ns.gang.getAscensionResult(name);
					if (!result) continue;
					const gain = isHacking
						? result.hack
						: Math.max(result.str, result.def, result.dex, result.agi);
					if (gain >= ASCEND_MULTI_THRESHOLD) {
						ns.gang.ascendMember(name);
						trainUntilMs[name] = Date.now() + TRAIN_TICKS_AFTER_EVENT * SLEEP_TICK;
						ns.print(`INFO gang_manager: ascended "${name}" (gain ×${gain.toFixed(2)})`);
					}
				} catch { /* never let a single member error break the tick */ }
			}

			// 3. Buy equipment within budget
			buyEquipment(ns, members, isHacking);

			// 4. Assign tasks (respect/money balance, wanted kept in check)
			assignTasks(ns, members, gangInfo, isHacking);

			// 5. Territory warfare — decision-gated (see WARFARE_* tuning constants
			//    above for the heuristic rationale). Engaging is risky (a lost clash
			//    can kill members) so it needs approval; disengaging is always safe
			//    and is done proactively without a gate.

			// Apply any verdict on a prior warfare ask.
			for (const reply of drainReplies(ns)) {
				if (reply.id !== GANG_WARFARE_DECISION_ID) continue;
				removePending(ns, GANG_WARFARE_DECISION_ID);
				if (reply.verdict === 'approve') {
					try { ns.gang.setTerritoryWarfare(true); } catch { /* ok */ }
					ns.print('INFO gang_manager: territory warfare APPROVED — engaged');
				} else if (reply.verdict === 'deny') {
					warfareDeniedAtWinChance = lastWorstWinChance;
					ns.print(`INFO gang_manager: territory warfare DENIED — suppressed until worst win chance exceeds ${(warfareDeniedAtWinChance + WARFARE_DENY_IMPROVE_MARGIN).toFixed(2)}`);
				} else if (reply.verdict === 'defer') {
					warfareDeferUntilTick = tick + WARFARE_DEFER_TICKS;
					ns.print(`INFO gang_manager: territory warfare DEFERRED — re-asking in ${WARFARE_DEFER_TICKS} ticks`);
				}
			}

			const assessment = assessTerritoryWarfare(ns, gangInfo.faction);
			if (assessment) {
				lastWorstWinChance = assessment.worstWinChance;
				const territoryFull = gangInfo.territory >= 1;

				if (gangInfo.territoryWarfareEngaged) {
					// Safe direction — no approval needed. Bail out once it's no longer
					// worth the risk (win chance dropped) or there's nothing left to gain.
					if (territoryFull || assessment.worstWinChance < WARFARE_DISENGAGE_THRESHOLD) {
						try { ns.gang.setTerritoryWarfare(false); } catch { /* ok */ }
						removePending(ns, GANG_WARFARE_DECISION_ID);
						ns.print(territoryFull
							? 'INFO gang_manager: territory at 100% — warfare disengaged'
							: `INFO gang_manager: worst win chance ${assessment.worstWinChance.toFixed(2)} below floor — warfare disengaged`);
					}
				} else if (!territoryFull && assessment.rivalCount > 0 && assessment.worstWinChance >= WARFARE_WIN_CHANCE_MIN) {
					const suppressed = assessment.worstWinChance <= warfareDeniedAtWinChance + WARFARE_DENY_IMPROVE_MARGIN
						|| tick < warfareDeferUntilTick;
					if (!suppressed) {
						upsertPending(ns, {
							id: GANG_WARFARE_DECISION_ID,
							kind: 'gangWarfare',
							prompt: `Territory warfare looks safe — worst win chance ${(assessment.worstWinChance * 100).toFixed(0)}% `
								+ `vs ${assessment.rivalCount} active rival(s). Engage?`,
							command: 'ns.gang.setTerritoryWarfare(true)',
							context: {
								worstWinChance: assessment.worstWinChance,
								rivalCount:     assessment.rivalCount,
								territory:      gangInfo.territory,
							},
							ts: Date.now(),
						});
					}
				} else {
					// No longer a good idea to engage (or nothing to contest) — drop any stale ask.
					removePending(ns, GANG_WARFARE_DECISION_ID);
				}
			}

			// ── publish ────────────────────────────────────────────────────
			const info2      = ns.gang.getGangInformation();
			const penalty    = info2.wantedPenalty; // 1.0 = no penalty, lower = punished
			const penPct     = ((1 - penalty) * 100).toFixed(2);
			const moneyFmt   = fmtRate(info2.moneyGainRate);
			const respectFmt = fmtRate(info2.respect);

			saveSubsystem(ns, {
				id: 'gang', available: true, enabled, running: true,
				headline: `${gangInfo.faction} — ${members.length} members | $${moneyFmt}/s | respect ${respectFmt} | penalty −${penPct}%`,
				metrics: {
					faction:       gangInfo.faction,
					members:       members.length,
					respect:       Math.round(info2.respect),
					respectGain:   Math.round(info2.respectGainRate * 100) / 100,
					moneyPerSec:   Math.round(info2.moneyGainRate),
					wantedLevel:   Math.round(info2.wantedLevel * 1000) / 1000,
					wantedGain:    Math.round(info2.wantedLevelGainRate * 1e6) / 1e6,
					wantedPenalty: Math.round(penalty * 10000) / 10000,
					power:         Math.round(info2.power),
					territory:     Math.round(info2.territory * 1000) / 1000,
				},
				ts: Date.now(),
			});
		} catch (e) {
			// Suppress — never crash the daemon
			ns.print(`WARN gang_manager tick error: ${e}`);
		}

		await ns.sleep(SLEEP_TICK);
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Generate the first "Member-N" name not already in the roster. */
function nextMemberName(existingMembers: string[]): string {
	let i = 1;
	while (existingMembers.includes(`Member-${i}`)) i++;
	return `Member-${i}`;
}

/**
 * Buy equipment/augmentations for all members within a per-tick budget.
 *
 * Sorted cheapest first so lower-tier gear reaches all members before spending
 * big on expensive upgrades. Off-stat equipment (no primary stat bonus) is skipped.
 */
function buyEquipment(ns: NS, members: string[], isHacking: boolean): void {
	const playerMoney = ns.getPlayer().money;

	// Build equipment list — skip entries with no primary-stat boost.
	// Cast to string[] so map/filter/sort callback params are typed even when @ns isn't resolved.
	const equipNames = ns.gang.getEquipmentNames() as string[];
	type EquipEntry = { name: string; cost: number; type: string; boostsPrimary: boolean };
	const equipList: EquipEntry[] = equipNames.map((name: string) => {
		const stats = ns.gang.getEquipmentStats(name);
		const boosts = isHacking
			? (stats.hack ?? 0) > 0
			: (stats.str ?? 0) > 0 || (stats.def ?? 0) > 0
			  || (stats.dex ?? 0) > 0 || (stats.agi ?? 0) > 0;
		return {
			name,
			cost:          ns.gang.getEquipmentCost(name),
			type:          ns.gang.getEquipmentType(name),
			boostsPrimary: boosts,
		};
	}).filter((e: EquipEntry) => e.boostsPrimary).sort((a: EquipEntry, b: EquipEntry) => a.cost - b.cost);

	let equipSpent = 0;
	let augSpent   = 0;
	const equipBudget = playerMoney * EQUIP_BUDGET_FRACTION;
	const augBudget   = playerMoney * AUG_BUDGET_FRACTION;

	for (const equip of equipList) {
		const isAug = equip.type === 'Augmentation';
		const spent  = isAug ? augSpent  : equipSpent;
		const budget = isAug ? augBudget : equipBudget;
		if (spent + equip.cost > budget) continue; // over budget for this category this tick

		for (const member of members) {
			try {
				const info   = ns.gang.getMemberInformation(member);
				const already = (info.upgrades as string[]).includes(equip.name)
				             || (info.augmentations as string[]).includes(equip.name);
				if (already) continue;
				// Respect per-category budget across all members in this tick
				if (isAug && augSpent + equip.cost > augBudget)  break;
				if (!isAug && equipSpent + equip.cost > equipBudget) break;
				if (ns.gang.purchaseEquipment(member, equip.name)) {
					if (isAug) augSpent += equip.cost; else equipSpent += equip.cost;
				}
			} catch { /* ignore — don't break the loop */ }
		}
	}
}

/**
 * Assign tasks to each member.
 *
 * Strategy (conservative):
 *   • If a member recently joined or ascended → train.
 *   • If wanted penalty has degraded past floor AND wanted is actively rising → vigilante.
 *   • Otherwise → mid-tier crime (2/3 up the crime list = decent income + respect without
 *     extreme wanted generation). This keeps new gangs growing quickly while staying
 *     below the wanted-penalty threshold.
 */
function assignTasks(
	ns: NS,
	members: string[],
	gangInfo: ReturnType<NS['gang']['getGangInformation']>,
	isHacking: boolean,
): void {
	const vigilante = wantedReductionTask(isHacking);
	const training  = primaryTrainingTask(isHacking);
	const crimes    = isHacking ? HACK_CRIMES : COMBAT_CRIMES;

	// Mid-tier crime index: ~2/3 of the way through the ordered list
	const midCrime = crimes[Math.min(Math.floor(crimes.length * 0.67), crimes.length - 1)];

	const penalty    = gangInfo.wantedPenalty;
	const wantedRise = gangInfo.wantedLevelGainRate > 0;
	const penaltyBad = penalty < WANTED_PENALTY_FLOOR && wantedRise;

	const now = Date.now();
	for (const name of members) {
		let task: string;
		if ((trainUntilMs[name] ?? 0) > now) {
			task = training;
		} else if (penaltyBad) {
			// Wanted is rising and penalty is already hurting — dial back
			task = vigilante;
		} else {
			task = midCrime;
		}

		try {
			// Only call setMemberTask if the assignment actually changes (avoid log spam)
			if (ns.gang.getMemberInformation(name).task !== task) {
				ns.gang.setMemberTask(name, task);
			}
		} catch { /* ignore */ }
	}
}

/**
 * Assess whether engaging territory warfare currently looks safe.
 *
 * "Active rival" = any other gang (from getAllGangInformation, which — unlike the
 * deprecated getOtherGangInformation — includes every gang, own included) that
 * holds territory > 0, i.e. one we could actually clash with. worstWinChance is
 * the minimum of getChanceToWinClash() across those rivals — the heuristic cares
 * about the worst case, since any single lost clash can kill a member. Returns
 * null (never engage) if the lookup throws, so callers just skip the tick.
 */
function assessTerritoryWarfare(
	ns: NS,
	ownFaction: string,
): { worstWinChance: number; rivalCount: number } | null {
	try {
		const all = ns.gang.getAllGangInformation();
		let worst = 1;
		let rivalCount = 0;
		for (const [name, info] of Object.entries(all)) {
			if (name === ownFaction || info.territory <= 0) continue;
			rivalCount++;
			const chance = ns.gang.getChanceToWinClash(name);
			if (chance < worst) worst = chance;
		}
		return { worstWinChance: rivalCount > 0 ? worst : 1, rivalCount };
	} catch {
		return null;
	}
}

/** Compact rate formatter: 1.23B / 45.6M / 7.8K / 123 */
function fmtRate(n: number): string {
	if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
	return n.toFixed(0);
}
