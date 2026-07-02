import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { formatMoney } from '../lib/format';
import { upsertPending, removePending, drainReplies } from '../lib/decisions';

/**
 * Corp manager (docs/design/11 §6) — v1 implementation.
 *
 * SCOPE (deliberately narrow): ONE corporation, ONE division (Agriculture — the
 * cheapest materials-only industry: no product-design loop needed at all), ONE
 * city (Sector-12), ONE office and ONE warehouse (both left at their initial
 * size). Office/warehouse upgrades, AdVert, research, exports, a second
 * division/city, and investor/IPO mechanics (acceptInvestmentOffer/goPublic/
 * issueDividends/bribe) are all explicitly OUT of scope for this build.
 *
 * Contract: same PERSISTENT-daemon shape as gang_manager.ts/grafting_manager.ts —
 * gate on loadSettings(ns).autoCorp each tick, self-guard on API availability
 * (publish available:false and idle, never throw/exit), publish a
 * SubsystemStatus every tick, and route the one big irreversible spend
 * (founding the corp) through lib/decisions.ts's approve/deny/defer queue
 * (kind 'corpInvest', id 'corpFound') rather than auto-spending.
 *
 * ── Two footguns worth flagging up front for future debugging sessions ──────
 *
 * 1. RAM footprint: this daemon's static RAM cost is unusually large
 *    (~200-230 GB — see the sum of every ns.corporation.* RAM cost used below:
 *    createCorporation 20, hasUnlock 10, getUnlockCost 10, purchaseUnlock 20,
 *    expandIndustry 20, expandCity 20, purchaseWarehouse 20, setSmartSupply 20,
 *    sellMaterial 20, hireEmployee 20, getOffice 10, getCorporation 10,
 *    getDivision 10, getWarehouse 10 — hasCorporation/canCreateCorporation/
 *    getConstants are all 0 GB). This is INHERENT to the corp feature (it
 *    requires real access to many distinct API functions at once) — it is NOT
 *    a bug. A save realistically can't even afford to found a corp (see #2)
 *    without $324b+ liquid net worth, which implies home RAM is already
 *    massively reinvested from the compute layer by that point. Do not chase
 *    this as a regression.
 *
 * 2. The $150e9 self-fund cost (SELF_FUND_COST below), the Agriculture division
 *    cost (AGRICULTURE_STARTING_COST), and the three unlock prices
 *    (UNLOCK_COSTS) are all HARDCODED because no NS getter exposes any of them
 *    before a corporation exists (ns.corporation.getUnlockCost/getIndustryData
 *    both throw "Must own a corporation" pre-founding; ns.corporation.
 *    getConstants() is the one 0 GB, no-corp-required call, and IS used live
 *    below for officeInitialCost/warehouseInitialCost). Values were read
 *    verbatim from a sibling checkout at ../bitburner-src:
 *      - Corporation/helpers.ts::costOfCreatingCorporation(false)  → 150e9
 *      - Corporation/data/IndustryData.ts (Agriculture.startingCost) → 40e9
 *      - Corporation/data/CorporationUnlocks.ts (Office API/Warehouse API/
 *        Smart Supply prices) → 50e9 / 50e9 / 25e9
 *    Re-verify against ../bitburner-src if the game version changes.
 */

const SLEEP_UNAVAIL = 10_000; // ms — poll cadence when corp (SF3) unavailable
const SLEEP_TICK    =  5_000; // ms — management loop cadence otherwise

const CORP_NAME     = 'AutoCorp';
const DIVISION_NAME = 'Agriculture';
const INDUSTRY_TYPE = 'Agriculture'; // CorpIndustryName — literal, contextually typed at call sites

// ── hardcoded costs (see header comment #2 for why + re-verification note) ──
const SELF_FUND_COST            = 150e9; // bitburner-src Corporation/helpers.ts::costOfCreatingCorporation(false)
const AGRICULTURE_STARTING_COST =  40e9; // bitburner-src Corporation/data/IndustryData.ts
const UNLOCK_COSTS: Record<string, number> = {
	'Office API':    50e9,
	'Warehouse API': 50e9,
	'Smart Supply':  25e9,
}; // bitburner-src Corporation/data/CorporationUnlocks.ts — fallback estimate for the
   // pre-founding decision gate only; once the corp exists, getUnlockCost(name) is used live.

const UNLOCK_NAMES = ['Office API', 'Warehouse API', 'Smart Supply'] as const;
const SELL_MATERIALS = ['Plants', 'Food'] as const;
const HIRE_POSITIONS = ['Operations', 'Engineer', 'Business', 'Management'] as const;

const CORP_FOUND_DECISION_ID = 'corpFound';
const CORP_DEFER_TICKS       = 12;   // ticks a "defer" verdict suppresses re-asking
const CORP_DENY_MONEY_MARGIN = 0.10; // after a deny, require player money to grow 10% past the denied value

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	let tick = 0;
	let deniedAtMoney  = -1; // "deny" suppression — don't re-ask until money exceeds this + margin
	let deferUntilTick =  0; // "defer" suppression — don't re-ask until this tick

	while (true) {
		tick++;
		const enabled = loadSettings(ns).autoCorp;

		try {
			// ── Not yet founded: availability + bootstrap decision ─────────────
			if (!ns.corporation.hasCorporation()) {
				const checkResult = ns.corporation.canCreateCorporation(true);

				if (checkResult === 'NoSf3OrDisabled') {
					removePending(ns, CORP_FOUND_DECISION_ID);
					saveSubsystem(ns, {
						id: 'corp', available: false, enabled, running: false,
						headline: 'Corp unavailable (need SF3/BN3)',
						metrics: {}, ts: Date.now(),
					});
					await ns.sleep(SLEEP_UNAVAIL);
					continue;
				}

				// Apply any verdict on the founding decision.
				for (const reply of drainReplies(ns, id => id === CORP_FOUND_DECISION_ID)) {
					removePending(ns, CORP_FOUND_DECISION_ID);
					if (reply.verdict === 'approve') {
						runBootstrap(ns);
					} else if (reply.verdict === 'deny') {
						deniedAtMoney = ns.getPlayer().money;
						ns.print(`INFO corp_manager: founding DENIED — suppressed until money exceeds ${formatMoney(deniedAtMoney * (1 + CORP_DENY_MONEY_MARGIN))}`);
					} else if (reply.verdict === 'defer') {
						deferUntilTick = tick + CORP_DEFER_TICKS;
						ns.print(`INFO corp_manager: founding DEFERRED — re-asking in ${CORP_DEFER_TICKS} ticks`);
					}
				}

				// Founding may have just happened via an 'approve' verdict above.
				if (!ns.corporation.hasCorporation()) {
					const constants = ns.corporation.getConstants(); // 0 GB, no corp required
					const totalCost = SELF_FUND_COST + AGRICULTURE_STARTING_COST
						+ constants.officeInitialCost + constants.warehouseInitialCost
						+ UNLOCK_COSTS['Office API'] + UNLOCK_COSTS['Warehouse API'] + UNLOCK_COSTS['Smart Supply'];
					const money = ns.getPlayer().money;
					const canAfford = checkResult === 'Success' && money >= totalCost;

					if (canAfford) {
						const suppressed = money <= deniedAtMoney * (1 + CORP_DENY_MONEY_MARGIN) || tick < deferUntilTick;
						if (!suppressed) {
							upsertPending(ns, {
								id:      CORP_FOUND_DECISION_ID,
								kind:    'corpInvest',
								prompt:  `Found "${CORP_NAME}" (self-funded, ${formatMoney(SELF_FUND_COST)}) and bootstrap one `
									+ `Agriculture division in Sector-12 for a combined ~${formatMoney(totalCost)}? `
									+ `Large, effectively irreversible spend.`,
								command: `ns.corporation.createCorporation("${CORP_NAME}", true)`,
								context: { totalCost, corpName: CORP_NAME, divisionName: DIVISION_NAME },
								ts: Date.now(),
							});
						}
					} else {
						removePending(ns, CORP_FOUND_DECISION_ID);
					}

					saveSubsystem(ns, {
						id: 'corp', available: true, enabled, running: false,
						headline: canAfford
							? `Corp — awaiting founding decision (~${formatMoney(totalCost)})`
							: `Corp — not yet founded (need ~${formatMoney(totalCost)}, have ${formatMoney(money)})`,
						metrics: { totalCost, playerMoney: money },
						ts: Date.now(),
					});
					await ns.sleep(SLEEP_UNAVAIL);
					continue;
				}
			}

			// ── Founded: resume any unfinished bootstrap steps (idempotent — see
			// header comment; a partial prior failure just resumes here) then manage. ──
			runBootstrap(ns);
			hireRoundRobin(ns);

			const corpInfo   = ns.corporation.getCorporation();
			const division   = ns.corporation.getDivision(DIVISION_NAME);
			const office     = safeGetOffice(ns);
			const employees  = office?.numEmployees ?? 0;
			const officeSize = office?.size ?? 0;

			saveSubsystem(ns, {
				id: 'corp', available: true, enabled, running: true,
				headline: `${corpInfo.name} — ${division.industry} @ Sector-12 | funds ${formatMoney(corpInfo.funds)} `
					+ `| rev ${formatMoney(corpInfo.revenue)}/s | exp ${formatMoney(corpInfo.expenses)}/s `
					+ `| ${employees}/${officeSize} employees`,
				metrics: {
					funds:          Math.round(corpInfo.funds),
					revenuePerSec:  Math.round(corpInfo.revenue),
					expensesPerSec: Math.round(corpInfo.expenses),
					employees,
					officeSize,
					divisionName:   DIVISION_NAME,
				},
				ts: Date.now(),
			});
		} catch (e) {
			ns.print(`WARN corp_manager tick error: ${e}`);
			saveSubsystem(ns, {
				id: 'corp', available: false, enabled, running: false,
				headline: 'Corp — unavailable or not yet founded',
				metrics: {}, ts: Date.now(),
			});
			await ns.sleep(SLEEP_UNAVAIL);
			continue;
		}

		await ns.sleep(SLEEP_TICK);
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Run (or resume) the founding + division/office/warehouse/unlock/sell-order
 * bootstrap sequence. Every step is idempotent and independently try/catch'd —
 * none of this is transactional, so a partial failure on one tick just means
 * the next call resumes from whichever step hasn't completed yet (see header
 * comment #1/#2). Called once from the 'approve' verdict handler AND every
 * tick thereafter while founded (cheap no-ops once everything is in place).
 */
function runBootstrap(ns: NS): void {
	// 1. Found the corporation (only reached via an approved decision when
	//    !hasCorporation() — safe to guard again here since this fn also runs
	//    every tick post-founding, when this branch is simply skipped).
	try {
		if (!ns.corporation.hasCorporation()) {
			ns.corporation.createCorporation(CORP_NAME, true);
		}
	} catch (e) { ns.print(`WARN corp_manager bootstrap: createCorporation failed: ${e}`); }

	if (!ns.corporation.hasCorporation()) return; // nothing more possible this tick

	const city = ns.enums.CityName.Sector12;

	// 2. Unlocks — Office API / Warehouse API / Smart Supply (order matters:
	//    Smart Supply's setup in step 6 depends on the unlock landing first).
	for (const unlock of UNLOCK_NAMES) {
		try {
			if (!ns.corporation.hasUnlock(unlock)) {
				const cost = ns.corporation.getUnlockCost(unlock); // live, correctness > 10 GB
				if (ns.corporation.getCorporation().funds >= cost) {
					ns.corporation.purchaseUnlock(unlock);
				}
			}
		} catch (e) { ns.print(`WARN corp_manager bootstrap: unlock '${unlock}' failed: ${e}`); }
	}

	// 3. Division — expandIndustry IS division creation, there is no separate
	//    createDivision call.
	try {
		if (!ns.corporation.getCorporation().divisions.includes(DIVISION_NAME)) {
			ns.corporation.expandIndustry(INDUSTRY_TYPE, DIVISION_NAME);
		}
	} catch (e) { ns.print(`WARN corp_manager bootstrap: expandIndustry failed: ${e}`); }

	// 4. Office — expandCity ALSO buys the office; a fresh division has none
	//    until this is called.
	try {
		const division = ns.corporation.getDivision(DIVISION_NAME);
		if (!division.cities.includes(city)) {
			ns.corporation.expandCity(DIVISION_NAME, city);
		}
	} catch (e) { ns.print(`WARN corp_manager bootstrap: expandCity failed: ${e}`); }

	// 5. Warehouse
	try {
		ns.corporation.getWarehouse(DIVISION_NAME, city);
	} catch {
		try { ns.corporation.purchaseWarehouse(DIVISION_NAME, city); }
		catch (e) { ns.print(`WARN corp_manager bootstrap: purchaseWarehouse failed: ${e}`); }
	}

	// 6. Smart Supply — requires the unlock from step 2; re-verified every tick
	//    in case a save-reload reset it (per spec: "re-apply once if reset").
	try {
		if (ns.corporation.hasUnlock('Smart Supply')) {
			const wh = ns.corporation.getWarehouse(DIVISION_NAME, city);
			if (!wh.smartSupplyEnabled) ns.corporation.setSmartSupply(DIVISION_NAME, city, true);
		}
	} catch (e) { ns.print(`WARN corp_manager bootstrap: setSmartSupply failed: ${e}`); }

	// 7. Sell orders for both produced materials — idempotent, safe to re-call.
	for (const material of SELL_MATERIALS) {
		try { ns.corporation.sellMaterial(DIVISION_NAME, city, material, 'MAX', 'MP'); }
		catch (e) { ns.print(`WARN corp_manager bootstrap: sellMaterial(${material}) failed: ${e}`); }
	}
}

/** getOffice throws if the division hasn't expanded to Sector-12 yet — swallow and return null. */
function safeGetOffice(ns: NS) {
	try { return ns.corporation.getOffice(DIVISION_NAME, ns.enums.CityName.Sector12); }
	catch { return null; }
}

/**
 * Hire directly into a fixed round-robin of core positions (no setJobAssignment
 * needed for v1 — 'Research & Development'/'Intern'/'Unassigned' are skipped).
 */
function hireRoundRobin(ns: NS): void {
	try {
		const city = ns.enums.CityName.Sector12;
		const office = ns.corporation.getOffice(DIVISION_NAME, city);
		let numEmployees = office.numEmployees;
		while (numEmployees < office.size) {
			const position = HIRE_POSITIONS[numEmployees % HIRE_POSITIONS.length];
			if (!ns.corporation.hireEmployee(DIVISION_NAME, city, position)) break;
			numEmployees++;
		}
	} catch (e) { ns.print(`WARN corp_manager: hireRoundRobin failed: ${e}`); }
}
