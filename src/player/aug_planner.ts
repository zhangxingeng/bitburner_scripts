import { NS } from '@ns';
import { executeCommand } from '../lib/ns_dodge';
import { hasSF4, getSFLevel } from '../lib/sf_check';
import { formatMoney, shortNumber } from '../lib/format';
import { PORT_AUGS, pushPort, clearPort } from '../lib/ports';
import { SCRIPT_PATHS } from '../lib/config';
import { upsertPending } from '../lib/decisions';

// ── Cost model ────────────────────────────────────────────────────────────────
// Each augmentation purchased this session multiplies the next aug's price by
// the cascade multiplier below. SF11 reduces this multiplier; without it (or
// at SF11 lvl 0) it's the full 1.9. The reduction factors themselves come
// straight from the game's own SF11 tooltip — [1, 0.96, 0.94, 0.93] for
// levels 0-3+; the index is clamped since a BitNode option override could in
// principle report an SF level outside that range and an unclamped array
// access would silently produce NaN.
const AUG_COST_REDUCTIONS = [1, 0.96, 0.94, 0.93];

function getAugCostMult(ns: NS): number {
    const level = Math.min(Math.max(getSFLevel(ns, 11), 0), AUG_COST_REDUCTIONS.length - 1);
    return 1.9 * AUG_COST_REDUCTIONS[level];
}

// ── Donation cooldown (persisted — aug_planner is one-shot, not a daemon) ─────
// player_sequencer.ts's drainReplies for `augDonate:*` ids is the only thing
// that ever sees a deny/defer verdict (this script never drains replies
// itself); it's expected to write untilTs entries here on deny/defer so a
// FRESH aug_planner invocation doesn't immediately re-surface a decision the
// user just rejected. See this task's final report for the exact contract.
const DONATE_COOLDOWN_FILE = 'status/aug_donate_cooldown.json';

function loadDonateCooldowns(ns: NS): Record<string, number> {
    try {
        const raw = ns.read(DONATE_COOLDOWN_FILE);
        if (!raw || raw.trim() === '') return {};
        const parsed = JSON.parse(raw) as unknown;
        return (parsed && typeof parsed === 'object') ? parsed as Record<string, number> : {};
    } catch {
        return {};
    }
}

function isDonateOnCooldown(cooldowns: Record<string, number>, id: string): boolean {
    const until = cooldowns[id];
    return typeof until === 'number' && Date.now() < until;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AugInfo {
    name:     string;
    price:    number;    // base price (from ns.singularity.getAugmentationPrice)
    repReq:   number;    // rep required
    prereqs:  string[];  // immediate prerequisite augmentation names
    factions: string[];  // joined factions that offer this aug
}

interface PlanEntry {
    name:           string;
    faction:        string;  // best faction to buy from
    basePrice:      number;
    effectivePrice: number;  // basePrice × cascade-mult^position
    repReq:         number;
    repHave:        number;  // rep we have with the chosen faction
    affordable:     boolean; // can buy (rep met AND cumulative cost ≤ budget)
}

/** A rep-gap-blocked aug that could be unlocked by donating to its faction. */
interface DonationCandidate {
    augName: string;
    faction: string;
    repGap:  number; // repReq - repHave
    cost:    number; // ns.formulas.reputation.donationForRep, ceil'd
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Augmentation Planner — compute optimal purchase order accounting for
 * cascading costs (1.9^n), dependency propagation, and cheapest-rep faction.
 *
 * Writes the count of immediately affordable augmentations to PORT_AUGS so
 * cross/phase_detector.ts can trigger the RESET phase.
 *
 * Flags:
 *   --purchase   Actually buy the affordable augmentations (Singularity via ns_dodge).
 *   --install    After a fully-successful purchase, call ns.singularity.installAugmentations
 *                (the actual soft-reset trigger) with brain.js as the post-reset callback
 *                script, so the autonomous loop resumes on its own — no manual `run /brain.js`
 *                needed after reset. Implies --purchase. Skipped if any purchase fails
 *                partway (cascade prices may have drifted) — resetting on an incomplete,
 *                unexpected buy is exactly the kind of avoidable risk to not take blind.
 *                Irreversible for the current BitNode life — see settings.autoReset's own
 *                "point of no return" doc comment (lib/settings.ts). Only ever invoked
 *                automatically when settings.autoBuyAugs AND settings.autoReset are both on
 *                (cross/player_sequencer.ts's RESET handling) — both default false.
 *
 * Usage:
 *   run /player/aug_planner.js             # plan only, publish count
 *   run /player/aug_planner.js --purchase  # plan + buy
 *   run /player/aug_planner.js --install   # plan + buy + reset into a fresh life
 *   run /player/aug_planner.js --donate --faction <f> --augName <a>
 *       Recomputes the rep gap/donation amount fresh (never trusts a cached
 *       figure — favor/rep drift between runs) and donates via Singularity.
 *       Deliberately decoupled from --purchase/--install: this ONLY raises
 *       faction rep. The now-unlocked aug is bought on the NEXT normal
 *       aug_planner run, once it observes the higher getFactionRep().
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();
    ns.ui.setTailTitle('Aug Planner');

    const flags = ns.flags([
        ['purchase', false],
        ['install',  false],
        ['donate',   false],
        ['faction',  ''],
        ['augName',  ''],
    ]) as unknown as {
        purchase: boolean; install: boolean;
        donate: boolean; faction: string; augName: string;
    };
    const doInstall  = flags.install;
    const doPurchase = flags.purchase || doInstall;

    // Guard: Singularity required (SF4).
    if (!hasSF4(ns)) {
        ns.tprint('ERROR: aug_planner requires SF4 (Singularity). Exiting.');
        return;
    }

    if (flags.donate) {
        await runDonate(ns, flags.faction, flags.augName);
        return;
    }

    const augCostMult = getAugCostMult(ns);
    const { augs, factionReps, factionFavors, budget, ownedAugs } = await gatherAugData(ns);
    if (augs.length === 0) {
        ns.print('No unowned augmentations available from joined factions.');
        publishPendingAugs(ns, 0);
        return;
    }

    const plan = computePlan(augs, factionReps, budget, ownedAugs, augCostMult);
    const totalCost = plan.filter(e => e.affordable).reduce((sum, e) => sum + e.effectivePrice, 0);
    const donationCandidates = await computeDonationCandidates(ns, plan, factionFavors);
    surfaceDonationCandidates(ns, donationCandidates, budget - totalCost);

    printPlan(ns, plan, budget, donationCandidates);

    const affordable = plan.filter(e => e.affordable);
    publishPendingAugs(ns, affordable.length);

    if (doPurchase) {
        if (affordable.length === 0) {
            ns.tprint('No affordable augmentations to purchase right now.');
            return;
        }
        const allBought = await purchasePlan(ns, affordable);

        if (doInstall) {
            if (!allBought) {
                ns.tprint('SKIPPING install — not all planned augmentations were purchased '
                    + '(see FAILED line above). Re-run --install once the plan is clean.');
                return;
            }
            ns.tprint(`Installing ${affordable.length} augmentation(s) — resetting into a new life, `
                + `resuming via ${SCRIPT_PATHS.brain}...`);
            await executeCommand(ns, `ns.singularity.installAugmentations("${SCRIPT_PATHS.brain}")`);
        }
    }
}

// ── Donation flow (--donate mode) ─────────────────────────────────────────────

/**
 * Recompute the rep gap for `augName` from `faction` fresh (never trust a
 * stale cached amount — favor/rep may have drifted since the candidate was
 * surfaced) and donate exactly enough to close it. Decoupled from purchase —
 * the caller (player_sequencer, on a follow-up run) is responsible for
 * actually buying the aug once its rep requirement is met.
 */
async function runDonate(ns: NS, faction: string, augName: string): Promise<void> {
    if (!faction || !augName) {
        ns.tprint('ERROR: --donate requires --faction <f> --augName <a>. Exiting.');
        return;
    }

    if (!ns.fileExists('Formulas.exe', 'home')) {
        ns.tprint('ERROR: --donate requires Formulas.exe (donation-cost math). Exiting.');
        return;
    }

    const repReq = await executeCommand<number>(ns, `ns.singularity.getAugmentationRepReq("${augName}")`) ?? 0;
    const repHave = await executeCommand<number>(ns, `ns.singularity.getFactionRep("${faction}")`) ?? 0;
    const repGap = repReq - repHave;
    if (repGap <= 0) {
        ns.tprint(`No donation needed — ${faction} rep (${shortNumber(repHave)}) already meets `
            + `${augName}'s requirement (${shortNumber(repReq)}).`);
        return;
    }

    const favor = await executeCommand<number>(ns, `ns.singularity.getFactionFavor("${faction}")`) ?? 0;
    const favorToDonate = ns.getFavorToDonate();
    if (favor < favorToDonate) {
        ns.tprint(`ERROR: ${faction} favor (${favor}) is below the donation threshold `
            + `(${favorToDonate}) — cannot donate yet. Exiting.`);
        return;
    }

    const amount = Math.ceil(ns.formulas.reputation.donationForRep(repGap, ns.getPlayer()));
    ns.tprint(`Donating ${formatMoney(amount)} to ${faction} to close a ${shortNumber(repGap)} rep gap `
        + `for "${augName}"...`);
    const ok = await executeCommand<boolean>(ns, `ns.singularity.donateToFaction("${faction}", ${amount})`);

    if (ok) {
        ns.tprint(`SUCCESS: Donated ${formatMoney(amount)} to ${faction}.`);
    } else {
        ns.tprint(`FAILED: Donation to ${faction} did not go through.`);
    }
    ns.tprint('NOTE: This only raises faction rep — it does NOT purchase the augmentation. '
        + 'Run aug_planner again (plain or --purchase) once rep has updated to actually buy it.');
}

// ── Data gathering ────────────────────────────────────────────────────────────

/**
 * Collect all unowned augmentation data from joined factions via Singularity.
 * Expands the set to include transitive prerequisites.
 */
async function gatherAugData(ns: NS): Promise<{
    augs:          AugInfo[];
    factionReps:   Map<string, number>;
    factionFavors: Map<string, number>;
    budget:        number;
    ownedAugs:     Set<string>;
}> {
    const player       = ns.getPlayer();
    const joinedFactions = player.factions;
    const budget       = player.money;

    const ownedAugsArr = await executeCommand<string[]>(
        ns, 'ns.singularity.getOwnedAugmentations(true)',
    ) ?? [];
    const ownedAugs = new Set(ownedAugsArr);

    // Map: augName → set of joined factions that offer it
    const augFactionMap  = new Map<string, Set<string>>();
    const factionReps    = new Map<string, number>();
    const factionFavors  = new Map<string, number>();

    for (const faction of joinedFactions) {
        const rep = await executeCommand<number>(
            ns, `ns.singularity.getFactionRep("${faction}")`,
        ) ?? 0;
        factionReps.set(faction, rep);

        const favor = await executeCommand<number>(
            ns, `ns.singularity.getFactionFavor("${faction}")`,
        ) ?? 0;
        factionFavors.set(faction, favor);

        const offered = await executeCommand<string[]>(
            ns, `ns.singularity.getAugmentationsFromFaction("${faction}")`,
        ) ?? [];

        for (const aug of offered) {
            if (ownedAugs.has(aug)) continue;
            if (!augFactionMap.has(aug)) augFactionMap.set(aug, new Set());
            augFactionMap.get(aug)!.add(faction);
        }
    }

    // Gather detailed info for each candidate aug.
    const augInfoMap = new Map<string, AugInfo>();

    async function fetchAugInfo(augName: string): Promise<AugInfo | null> {
        if (ownedAugs.has(augName)) return null; // already owned — prereq satisfied
        const factions = augFactionMap.get(augName);
        if (!factions) return null; // not offered by any joined faction — can't buy

        const price  = await executeCommand<number>(ns, `ns.singularity.getAugmentationPrice("${augName}")`)   ?? 0;
        const repReq = await executeCommand<number>(ns, `ns.singularity.getAugmentationRepReq("${augName}")`)  ?? 0;
        const prereqs = await executeCommand<string[]>(ns, `ns.singularity.getAugmentationPrereq("${augName}")`) ?? [];

        return { name: augName, price, repReq, prereqs, factions: [...factions] };
    }

    // First pass: collect all directly offered augs.
    for (const augName of augFactionMap.keys()) {
        if (augInfoMap.has(augName)) continue;
        const info = await fetchAugInfo(augName);
        if (info) augInfoMap.set(augName, info);
    }

    // Second pass: propagate prerequisites transitively.
    // If an aug needs a prereq that isn't in augInfoMap yet, try to fetch it.
    let changed = true;
    while (changed) {
        changed = false;
        for (const info of [...augInfoMap.values()]) {
            for (const prereq of info.prereqs) {
                if (ownedAugs.has(prereq) || augInfoMap.has(prereq)) continue;
                const prereqInfo = await fetchAugInfo(prereq);
                if (prereqInfo) {
                    augInfoMap.set(prereq, prereqInfo);
                    changed = true;
                }
                // If prereqInfo is null: prereq not available from joined factions.
                // The blocked aug will still appear in the plan but won't be affordable.
            }
        }
    }

    return { augs: [...augInfoMap.values()], factionReps, factionFavors, budget, ownedAugs };
}

// ── Plan computation ──────────────────────────────────────────────────────────

/**
 * Compute the optimal purchase plan:
 * 1. Topological sort respecting prerequisites (DFS, price-desc tie-break).
 * 2. For each aug in order: find best faction (cheapest rep requirement met),
 *    compute effective price (basePrice × 1.9^bought), determine affordability.
 *
 * Only augmentations with sufficient faction rep AND cumulative cost ≤ budget
 * are marked affordable and increment the cascade counter.
 */
function computePlan(
    augs:         AugInfo[],
    factionReps:  Map<string, number>,
    budget:       number,
    ownedAugs:    Set<string>,
    augCostMult:  number,
): PlanEntry[] {
    const sorted = topoSort(augs, ownedAugs);

    const plan:      PlanEntry[] = [];
    let bought       = 0;   // count of affordable augs (drives cascade multiplier)
    let totalCost    = 0;

    for (const aug of sorted) {
        const faction        = chooseFaction(aug, factionReps);
        const repHave        = faction ? (factionReps.get(faction) ?? 0) : 0;
        const hasRep         = faction !== null && repHave >= aug.repReq;
        const effectivePrice = aug.price * Math.pow(augCostMult, bought);
        const canPay         = totalCost + effectivePrice <= budget;
        const affordable     = hasRep && canPay;

        plan.push({
            name:           aug.name,
            faction:        faction ?? '(no faction with sufficient rep)',
            basePrice:      aug.price,
            effectivePrice,
            repReq:         aug.repReq,
            repHave,
            affordable,
        });

        if (affordable) {
            bought++;
            totalCost += effectivePrice;
        }
    }

    return plan;
}

// ── Donation-based rep unlocks ────────────────────────────────────────────────

/**
 * Find PlanEntry candidates blocked specifically by REP (not money) whose
 * faction favor already clears the donation threshold, and price out closing
 * the rep gap via a Formulas.exe-backed donation. Degrades gracefully (empty
 * list) if Formulas.exe isn't owned — donation-cost math needs it.
 *
 * Sorted cost-ascending so the caller can greedily fit as many as possible
 * into remaining budget (cheapest unlocks first).
 */
async function computeDonationCandidates(
    ns:            NS,
    plan:          PlanEntry[],
    factionFavors: Map<string, number>,
): Promise<DonationCandidate[]> {
    if (!ns.fileExists('Formulas.exe', 'home')) return [];

    const favorToDonate = ns.getFavorToDonate();
    const player = ns.getPlayer();

    const candidates: DonationCandidate[] = [];
    for (const entry of plan) {
        if (entry.affordable) continue;
        if (entry.repHave >= entry.repReq) continue; // blocked by money, not rep — not our concern here

        const favor = factionFavors.get(entry.faction) ?? 0;
        if (favor < favorToDonate) continue; // faction not yet donation-eligible

        const repGap = entry.repReq - entry.repHave;
        const cost = Math.ceil(ns.formulas.reputation.donationForRep(repGap, player));
        candidates.push({ augName: entry.name, faction: entry.faction, repGap, cost });
    }

    candidates.sort((a, b) => a.cost - b.cost);
    return candidates;
}

/**
 * Greedily fit donation candidates (cheapest first) into `remainingBudget`
 * (budget minus the ALREADY-accumulated cost of the normal purchase plan —
 * real affordable purchases take priority over speculative donations, so we
 * never double-count money against the raw budget). Each one that fits is
 * surfaced as a 'spend' decision, unless it's still on cooldown from a prior
 * deny/defer verdict (see DONATE_COOLDOWN_FILE doc comment above).
 */
function surfaceDonationCandidates(
    ns:               NS,
    candidates:       DonationCandidate[],
    remainingBudget:  number,
): void {
    if (candidates.length === 0) return;

    const cooldowns = loadDonateCooldowns(ns);
    let remaining = remainingBudget;

    for (const cand of candidates) {
        if (cand.cost > remaining) break; // sorted ascending — nothing cheaper left to try
        remaining -= cand.cost;

        const id = `augDonate:${cand.faction}:${cand.augName}`;
        if (isDonateOnCooldown(cooldowns, id)) continue;

        const added = upsertPending(ns, {
            id,
            kind: 'spend',
            prompt: `Donate ~${formatMoney(cand.cost)} to ${cand.faction} to gain `
                + `${shortNumber(cand.repGap)} rep and unlock "${cand.augName}"?`,
            command: `run ${SCRIPT_PATHS.augPlanner} --donate --faction "${cand.faction}" `
                + `--augName "${cand.augName}"`,
            context: { faction: cand.faction, augName: cand.augName, amount: cand.cost, repGap: cand.repGap },
            ts: Date.now(),
        });
        if (added) {
            ns.print(`DONATION candidate surfaced: ${cand.augName} via ${cand.faction} `
                + `(~${formatMoney(cand.cost)})`);
        }
    }
}

/**
 * Topological sort of augmentations with price-descending tie-breaking.
 * Prereqs are always placed before the aug that depends on them.
 * Augs whose full prereq chain cannot be satisfied (not owned, not in augMap)
 * are still included — they'll be marked non-affordable in computePlan.
 */
function topoSort(augs: AugInfo[], ownedAugs: Set<string>): AugInfo[] {
    const augMap  = new Map(augs.map(a => [a.name, a]));
    const inResult = new Set<string>();
    const result:  AugInfo[] = [];

    function addAug(name: string, depth = 0): void {
        if (depth > 30) return;           // cycle guard (should not occur in game)
        if (inResult.has(name))   return; // already scheduled
        if (ownedAugs.has(name))  return; // already owned — prereq satisfied

        const aug = augMap.get(name);
        if (!aug) return; // not available from joined factions

        // Schedule prereqs first (price-descending so expensive prereqs buy first)
        const sortedPrereqs = [...aug.prereqs]
            .map(p => augMap.get(p))
            .filter((p): p is AugInfo => p !== undefined)
            .sort((a, b) => b.price - a.price);

        for (const prereq of sortedPrereqs) addAug(prereq.name, depth + 1);

        if (!inResult.has(name)) {
            inResult.add(name);
            result.push(aug);
        }
    }

    // Process in price-descending order so expensive augs are prioritised.
    for (const aug of [...augs].sort((a, b) => b.price - a.price)) {
        addAug(aug.name);
    }

    return result;
}

/**
 * Choose the best faction to buy an aug from:
 * 1. First pick a joined faction where we already have enough rep.
 * 2. Among those, prefer the one with the highest rep (closest to having spare rep).
 * 3. If no faction has enough rep, fall back to the one with the most rep.
 *
 * Returns null if no joined faction offers this aug.
 *
 * Donation-based rep unlocks (ns.singularity.donateToFaction) are handled
 * separately by computeDonationCandidates/runDonate — this function only
 * ever considers rep the player has already earned.
 */
function chooseFaction(aug: AugInfo, factionReps: Map<string, number>): string | null {
    if (aug.factions.length === 0) return null;

    // Factions where we already have the required rep.
    const eligible = aug.factions.filter(f => (factionReps.get(f) ?? 0) >= aug.repReq);
    if (eligible.length > 0) {
        // Among eligible, pick the one with most rep (furthest past the threshold).
        return eligible.sort((a, b) => (factionReps.get(b) ?? 0) - (factionReps.get(a) ?? 0))[0];
    }

    // No faction has enough rep yet — pick the one with the most rep (closest to ready).
    return aug.factions.sort((a, b) => (factionReps.get(b) ?? 0) - (factionReps.get(a) ?? 0))[0];
}

// ── Plan display ──────────────────────────────────────────────────────────────

function printPlan(
    ns:                 NS,
    plan:               PlanEntry[],
    budget:             number,
    donationCandidates: DonationCandidate[] = [],
): void {
    const affordable = plan.filter(e => e.affordable);
    const totalCost  = affordable.reduce((sum, e) => sum + e.effectivePrice, 0);

    ns.print(`\n=== Aug Planner: ${affordable.length}/${plan.length} affordable ===`);
    ns.print(`Budget: ${formatMoney(budget)} | Total cost: ${formatMoney(totalCost)}`);
    ns.print('');

    ns.print('AFFORDABLE (buy order, most expensive first):');
    for (const entry of affordable) {
        ns.print(
            `  [BUY] ${entry.name.padEnd(42)} ` +
            `${formatMoney(entry.effectivePrice).padStart(12)} | ` +
            `${entry.faction}`,
        );
    }

    const blocked = plan.filter(e => !e.affordable);
    if (blocked.length > 0) {
        ns.print('\nNOT AFFORDABLE (need more rep or money):');
        for (const entry of blocked) {
            const reason = (entry.repHave < entry.repReq) ? 'REP' : 'MONEY';
            ns.print(
                `  [${reason}] ${entry.name.padEnd(40)} ` +
                `${formatMoney(entry.effectivePrice).padStart(12)} | ` +
                `rep ${shortNumber(entry.repHave)}/${shortNumber(entry.repReq)} ${entry.faction}`,
            );
        }
    }

    if (donationCandidates.length > 0) {
        ns.print('\nDONATION-UNLOCKABLE (favor-eligible, cheapest first):');
        for (const cand of donationCandidates) {
            ns.print(
                `  [DONATE] ${cand.augName.padEnd(40)} ` +
                `${formatMoney(cand.cost).padStart(12)} | ` +
                `+${shortNumber(cand.repGap)} rep via ${cand.faction}`,
            );
        }
    }
}

// ── PORT_AUGS publishing ──────────────────────────────────────────────────────

/**
 * Write the count of affordable/pending augmentations to PORT_AUGS so
 * cross/phase_detector.ts can determine whether to trigger the RESET phase.
 * Port peek is 0 GB — phase_detector reads this without RAM cost.
 */
function publishPendingAugs(ns: NS, count: number): void {
    clearPort(ns, PORT_AUGS);
    pushPort(ns, PORT_AUGS, String(count));
    ns.print(`Published pendingAugs=${count} to PORT_AUGS (${PORT_AUGS})`);
}

// ── Purchase execution ────────────────────────────────────────────────────────

/**
 * Purchase all affordable augmentations in plan order via Singularity + ns_dodge.
 * Must be called with the same ORDER as computePlan to keep cascade pricing correct.
 * Returns true only if every planned entry was successfully purchased.
 */
async function purchasePlan(ns: NS, affordable: PlanEntry[]): Promise<boolean> {
    ns.print(`\nPurchasing ${affordable.length} augmentation(s)...`);
    let allSucceeded = true;

    for (const entry of affordable) {
        ns.print(`  Buying ${entry.name} from ${entry.faction} (${formatMoney(entry.effectivePrice)})`);

        const ok = await executeCommand<boolean>(
            ns,
            `ns.singularity.purchaseAugmentation("${entry.faction}", "${entry.name}")`,
        );

        if (ok) {
            ns.tprint(`SUCCESS: Purchased ${entry.name}`);
        } else {
            ns.tprint(`FAILED: Could not purchase ${entry.name} from ${entry.faction}`);
            ns.tprint('Stopping purchase sequence — cascade prices may have shifted.');
            allSucceeded = false;
            break;
        }

        // Brief pause to avoid overwhelming the game's internal purchase queue.
        await ns.sleep(200);
    }

    ns.tprint('Purchase sequence complete. Run aug_planner again to verify.');
    ns.tprint('REMINDER: Restart faction_manager and re-earn rep before next install cycle.');
    return allSucceeded;
}
