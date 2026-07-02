import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { upsertPending, removePending, drainReplies } from '../lib/decisions';
import { notify } from '../cross/notification';

/**
 * Bladeburner manager daemon (docs/design/11).
 *
 * Persistent loop; player_sequencer keeps this alive when settings.autoBladeburner is ON.
 *
 * Availability: SF6/7 or BN6/7. Guarded via try/catch on ns.bladeburner.inBladeburner().
 * When unavailable: publishes available:false and idles at 10 s — does NOT exit, so it
 * picks up availability automatically after a dev-cheat SF grant.
 *
 * Automates (SAFE — all reversible):
 *   - Joining the Bladeburner division (once combat stats ≥ 100)
 *   - Joining the Bladeburner faction (once rank ≥ 25)
 *   - City selection: highest population within chaos threshold
 *   - Skill point spending: buys lowest adjusted-cost skill each loop
 *   - Action selection priority:
 *       1. Stamina regen  (Field Analysis / Diplomacy when stamina < 50%)
 *       2. Chaos control  (Stealth Retirement / Diplomacy when chaos > 50)
 *       3. Best operation with count > 0 and minChance ≥ 99%
 *       4. Best contract  with count > 0 and minChance ≥ 99%
 *       5. Training       (when success chances are below threshold; capped)
 *       6. Field Analysis (safe default — earns rank + improves pop estimate)
 *
 * Judgment call (irreversible / high-risk — routed through lib/decisions.ts):
 *   - Black Ops  — surfaced as a 'bladeOp' PendingDecision once rank + success
 *     chance clear the bar; startAction() only fires on an 'approve' verdict.
 *     See handleBlackOps() below for the approve/deny/defer wiring.
 *
 * Reference: example_code_dump/alainbryden-bitburner-scripts/bladeburner.js
 */

// ── Local type aliases (defined here to avoid cascading 'unknown' errors when
//    the worktree @ns phantom causes NS to become unknown at compile time). ───
//    Values are the string literals the Bladeburner API expects; kept in sync
//    with BladeburnerActionType / BladeburnerActionName / CityName / BladeburnerSkillName
//    from NetscriptDefinitions.d.ts.
type BBType  = 'General' | 'Contracts' | 'Operations' | 'Black Operations';
type BBName  = string;   // BladeburnerActionName union — too wide to inline safely
type BBCity  = string;   // CityName: "Sector-12" | "Aevum" | "Volhaven" | "Chongqing" | "New Tokyo" | "Ishima"
type BBSkill = string;   // BladeburnerSkillName

// Branded API param types (the real NetscriptDefinitions types) used only for
// casts at ns.bladeburner call sites; the loose aliases above stay for internal data.
type ApiCity       = Parameters<NS['bladeburner']['getCityChaos']>[0];
type ApiActionName = Parameters<NS['bladeburner']['getActionTime']>[1];
type ApiSkill      = Parameters<NS['bladeburner']['upgradeSkill']>[0];

// All six cities.
const CITIES: readonly BBCity[] = [
    'Sector-12', 'Aevum', 'Volhaven', 'Chongqing', 'New Tokyo', 'Ishima',
];

// ── Tuning constants. ─────────────────────────────────────────────────────────
const STAMINA_LOW        = 0.50;  // trigger regen below this fraction
const STAMINA_HIGH       = 0.60;  // resume normal ops above this fraction
const SUCCESS_THRESHOLD  = 0.99;  // min-chance required to attempt an action
const CHAOS_THRESHOLD    = 50;    // chaos level that triggers anti-chaos mode
const TRAINING_LIMIT     = 50;    // cap on Training dispatches (earns no rank)
const LOOP_SLEEP_MS      = 2_000; // main loop cadence (actions complete in seconds)

// Black Op decision suppression (a failed Black Op can permanently cost rank/
// reputation, so re-prompting every 2 s the moment a verdict lands would be
// spammy and, for "deny", would ignore the player's answer entirely):
//   - "deny"  is a considered veto on THIS op — don't re-ask until rank has
//     grown enough that the situation materially changed (success chance and
//     team-casualty risk both scale with rank).
//   - "defer" is "ask me again later" — a plain tick cooldown, long enough
//     (~5 min at LOOP_SLEEP_MS) to not spam but short enough to revisit soon.
const BLACKOP_DEFER_TICKS     = 150;  // 150 × 2 s ≈ 5 min
const BLACKOP_DENY_RANK_DELTA = 100;  // re-offer a denied op once rank + 100

// Skill priority weights: higher number = lower priority = bought later.
const SKILL_COST_ADJ: Partial<Record<string, number>> = {
    'Overclock':         0.8,  // speeds up all actions — high value early
    'Reaper':            1.2,  // combat boost — paltry until stats are high
    'Evasive Systems':   1.2,  // same reasoning as Reaper
    'Cloak':             1.5,  // stealth already boosted elsewhere
    'Hyperdrive':        2.0,  // improves stat gain, not rank — lower priority
    'Tracer':            2.0,  // only boosts contract chance; contracts are easy
    "Cyber's Edge":      5.0,  // stamina boost — counts are the real bottleneck
    'Hands of Midas':   10.0,  // money gain — BB is not the main income source
};

// ──────────────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    let lowStaminaTriggered = false;
    let timesTrained        = 0;    // accumulated Training dispatches
    let currentTaskEndTime  = 0;    // epoch ms; don't interrupt before this
    let tick                = 0;    // loop counter, for defer-cooldown bookkeeping

    // ── Black Op decision state (persists across ticks; see handleBlackOps). ────
    let blackOpActive: BBName | null = null; // approved op currently running
    let blackOpDeniedName: BBName | null = null;
    let blackOpDeniedAtRank   = 0;
    let blackOpDeferUntilTick = 0;

    while (true) {
        tick++;
        const settings = loadSettings(ns);
        const enabled  = settings.autoBladeburner;

        // ── Availability check — never throws. ───────────────────────────────
        let isAvailable = false;
        let isInBB      = false;
        try {
            isInBB      = ns.bladeburner.inBladeburner();
            isAvailable = true;
        } catch {
            // API inaccessible: SF6/7 not unlocked, or BN8 (BB disabled there).
        }

        if (!isAvailable) {
            saveSubsystem(ns, {
                id: 'bladeburner', available: false, enabled, running: false,
                headline: 'Bladeburner unavailable (need SF6/7)',
                metrics: {}, ts: Date.now(),
            });
            await ns.sleep(10_000);
            continue;
        }

        // ── Join division if available but not yet joined. ───────────────────
        if (!isInBB) {
            let joined = false;
            try { joined = ns.bladeburner.joinBladeburnerDivision(); } catch { /* ok */ }
            if (!joined) {
                // joinBladeburnerDivision returns false when combat stats < 100.
                saveSubsystem(ns, {
                    id: 'bladeburner', available: true, enabled, running: false,
                    headline: 'Waiting to join (need all combat stats ≥ 100)',
                    metrics: {}, ts: Date.now(),
                });
                await ns.sleep(10_000);
                continue;
            }
            ns.print('INFO bladeburner: joined Bladeburner division.');
        }

        // ── Main management body (wrapped; errors are logged, not fatal). ────
        try {
            const rank            = ns.bladeburner.getRank();
            const [stamCur, stamMax] = ns.bladeburner.getStamina();
            const staminaPct      = stamCur / stamMax;
            const currentCity     = ns.bladeburner.getCity();
            const chaos           = ns.bladeburner.getCityChaos(currentCity);

            // Collect per-city data for city selection.
            const cityPop:   Record<string, number> = {};
            const cityChaos: Record<string, number> = {};
            for (const city of CITIES) {
                cityPop[city]   = ns.bladeburner.getCityEstimatedPopulation(city as ApiCity);
                cityChaos[city] = ns.bladeburner.getCityChaos(city as ApiCity);
            }

            // Join the Bladeburner faction once we have enough rank.
            if (rank >= 25) {
                try { ns.bladeburner.joinBladeburnerFaction(); } catch { /* ok */ }
            }

            // Spend available skill points.
            spendSkillPoints(ns);

            // Relocate to best city (only between actions).
            const bestCity = chooseBestCity(cityChaos, cityPop);
            if (bestCity !== currentCity && Date.now() >= currentTaskEndTime) {
                try { ns.bladeburner.switchCity(bestCity as ApiCity); } catch { /* ok */ }
            }

            // Update stamina trigger.
            lowStaminaTriggered =
                staminaPct < STAMINA_LOW ||
                (lowStaminaTriggered && staminaPct < STAMINA_HIGH);

            // Black Ops — irreversible; gated behind the approve/deny/defer decision
            // queue (lib/decisions.ts). Evaluated BEFORE chooseAction() so an approved
            // op preempts the routine priority list, and — once started — keeps being
            // reselected every tick (via the same needSwitch check below) so chooseAction()
            // can't preempt it mid-flight.
            const blackOp = handleBlackOps(
                ns, rank, tick,
                blackOpActive, blackOpDeniedName, blackOpDeniedAtRank, blackOpDeferUntilTick,
            );
            blackOpActive        = blackOp.active;
            blackOpDeniedName    = blackOp.deniedName;
            blackOpDeniedAtRank  = blackOp.deniedAtRank;
            blackOpDeferUntilTick = blackOp.deferUntilTick;

            // Determine best action.
            const choice = blackOp.choice ?? chooseAction(ns, lowStaminaTriggered, chaos, staminaPct, timesTrained);

            if (choice) {
                if (choice.name === 'Training') {
                    timesTrained += LOOP_SLEEP_MS / 30_000; // training ~30 s each
                }

                const current    = ns.bladeburner.getCurrentAction();
                const needSwitch =
                    Date.now() >= currentTaskEndTime ||
                    !current ||
                    current.name !== choice.name;

                if (needSwitch) {
                    try {
                        const ok = ns.bladeburner.startAction(choice.type, choice.name as ApiActionName);
                        if (ok) {
                            const dur = ns.bladeburner.getActionTime(choice.type, choice.name as ApiActionName);
                            currentTaskEndTime = Date.now() + dur + 50;
                            ns.print(`INFO bladeburner: → ${choice.type} "${choice.name}" (${choice.reason}), ETA ${(dur / 1000).toFixed(1)}s`);
                        }
                    } catch { /* ok */ }
                }
            }

            // ── Publish live status. ─────────────────────────────────────────
            const curAction  = ns.bladeburner.getCurrentAction();
            const nextBO     = (() => { try { return ns.bladeburner.getNextBlackOp(); } catch { return null; } })();
            const skillPts   = ns.bladeburner.getSkillPoints();

            saveSubsystem(ns, {
                id: 'bladeburner', available: true, enabled, running: true,
                headline: `BB rank ${rank.toFixed(0)} | ${(staminaPct * 100).toFixed(0)}% stamina | ${curAction?.name ?? '—'}`,
                metrics: {
                    rank:           rank.toFixed(1),
                    stamina:        `${stamCur.toFixed(0)}/${stamMax.toFixed(0)} (${(staminaPct * 100).toFixed(0)}%)`,
                    city:           currentCity,
                    chaos:          chaos.toFixed(1),
                    skillPoints:    skillPts,
                    currentAction:  curAction ? `${curAction.type}: ${curAction.name}` : '—',
                    nextBlackOp:    nextBO ? `${nextBO.name} (need rank ${nextBO.rank})` : 'all complete',
                },
                ts: Date.now(),
            });

        } catch (err) {
            ns.print(`WARNING bladeburner: loop error (suppressed): ${err}`);
            // Publish a degraded status so the UI shows something.
            saveSubsystem(ns, {
                id: 'bladeburner', available: true, enabled, running: false,
                headline: 'Bladeburner — loop error (see logs)',
                metrics: {}, ts: Date.now(),
            });
        }

        await ns.sleep(LOOP_SLEEP_MS);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Spend all available skill points, always buying the highest-priority affordable
 * skill (lowest adjusted cost).  Loops until out of points or no affordable skill.
 */
function spendSkillPoints(ns: NS): void {
    try {
        const skills = ns.bladeburner.getSkillNames();
        for (;;) {
            const sp = ns.bladeburner.getSkillPoints();
            if (sp === 0) break;

            let best: BBSkill | null = null;
            let bestAdj = Number.MAX_SAFE_INTEGER;
            for (const skill of skills) {
                const cost = ns.bladeburner.getSkillUpgradeCost(skill);
                if (!isFinite(cost) || cost > sp) continue;
                // "Overclock" is capped at level 90 in some builds; guard against cost=0 edge case.
                if (cost === 0) continue;
                const adj = cost * (SKILL_COST_ADJ[skill] ?? 1.0);
                if (adj < bestAdj) { bestAdj = adj; best = skill; }
            }
            if (!best) break;
            if (!ns.bladeburner.upgradeSkill(best as ApiSkill)) break;
        }
    } catch { /* ok */ }
}

/**
 * Return the best city to operate in: highest population among cities whose chaos
 * is at or below CHAOS_THRESHOLD.  Falls back to all cities when all are chaotic.
 */
function chooseBestCity(
    chaos: Record<string, number>,
    pop:   Record<string, number>,
): BBCity {
    const acceptable = CITIES.filter(c => (chaos[c] ?? 0) <= CHAOS_THRESHOLD);
    const pool       = acceptable.length > 0 ? acceptable : [...CITIES];
    return pool.reduce((best, c) => (pop[c] ?? 0) > (pop[best] ?? 0) ? c : best, pool[0]);
}

/**
 * Choose the best action to take right now.
 *
 * Priority order:
 *   1. Stamina regen      — Field Analysis (or Diplomacy if chaos is high)
 *   2. Chaos control      — Stealth Retirement Operation / Diplomacy
 *   3. Best operation     — highest-tier op with count>0 and minChance ≥ threshold
 *   4. Best contract      — highest-tier contract with count>0 and minChance ≥ threshold
 *   5. Training           — when success is still below threshold; capped at TRAINING_LIMIT
 *   6. Field Analysis     — safe default
 *
 * Black Ops are intentionally excluded from this priority list — they're a separate,
 * higher-priority judgment call handled by handleBlackOps() in the main loop, gated
 * behind an explicit 'approve' verdict (lib/decisions.ts). This function is never
 * consulted while an approved Black Op is running or being decided.
 */
function chooseAction(
    ns:           NS,
    lowStamina:   boolean,
    chaos:        number,
    staminaPct:   number,
    timesTrained: number,
): { type: BBType; name: BBName; reason: string } | null {

    // 1. Stamina recovery.
    if (lowStamina) {
        const name: BBName = chaos > CHAOS_THRESHOLD ? 'Diplomacy' : 'Field Analysis';
        return {
            type: 'General', name,
            reason: `stamina ${(staminaPct * 100).toFixed(0)}% below regen threshold (${(STAMINA_LOW * 100).toFixed(0)}%)`,
        };
    }

    // 2. Chaos reduction.
    if (chaos > CHAOS_THRESHOLD) {
        try {
            const cnt    = ns.bladeburner.getActionCountRemaining('Operations', 'Stealth Retirement Operation');
            const [minC] = ns.bladeburner.getActionEstimatedSuccessChance('Operations', 'Stealth Retirement Operation');
            if (cnt >= 1 && minC >= SUCCESS_THRESHOLD) {
                return {
                    type: 'Operations', name: 'Stealth Retirement Operation',
                    reason: `chaos ${chaos.toFixed(1)} > ${CHAOS_THRESHOLD}`,
                };
            }
        } catch { /* fall through */ }
        return {
            type: 'General', name: 'Diplomacy',
            reason: `chaos ${chaos.toFixed(1)} > ${CHAOS_THRESHOLD}, no Stealth Retirement available`,
        };
    }

    // 3. Best operation (getOperationNames returns ascending tier; reverse for highest-first).
    const ops = [...ns.bladeburner.getOperationNames()].reverse();
    for (const name of ops) {
        try {
            if (ns.bladeburner.getActionCountRemaining('Operations', name) < 1) continue;
            const [minC] = ns.bladeburner.getActionEstimatedSuccessChance('Operations', name);
            if (minC >= SUCCESS_THRESHOLD) {
                return { type: 'Operations', name, reason: `min success ${(minC * 100).toFixed(0)}%` };
            }
        } catch { /* skip */ }
    }

    // 4. Best contract (highest-tier first).
    const contracts = [...ns.bladeburner.getContractNames()].reverse();
    for (const name of contracts) {
        try {
            if (ns.bladeburner.getActionCountRemaining('Contracts', name) < 1) continue;
            const [minC] = ns.bladeburner.getActionEstimatedSuccessChance('Contracts', name);
            if (minC >= SUCCESS_THRESHOLD) {
                return { type: 'Contracts', name, reason: `min success ${(minC * 100).toFixed(0)}%` };
            }
        } catch { /* skip */ }
    }

    // 5. Training — only if stats can still improve (maxChance < threshold) and we
    //    haven't hit the cap (training earns no rank; better to Field-Analyze long-term).
    let someSubThreshold = false;
    for (const name of ops) {
        try {
            if (ns.bladeburner.getActionCountRemaining('Operations', name) < 1) continue;
            const [, maxC] = ns.bladeburner.getActionEstimatedSuccessChance('Operations', name);
            if (maxC < SUCCESS_THRESHOLD) { someSubThreshold = true; break; }
        } catch { /* skip */ }
    }
    if (!someSubThreshold) {
        for (const name of contracts) {
            try {
                if (ns.bladeburner.getActionCountRemaining('Contracts', name) < 1) continue;
                const [, maxC] = ns.bladeburner.getActionEstimatedSuccessChance('Contracts', name);
                if (maxC < SUCCESS_THRESHOLD) { someSubThreshold = true; break; }
            } catch { /* skip */ }
        }
    }
    if (someSubThreshold && staminaPct > STAMINA_HIGH && timesTrained < TRAINING_LIMIT) {
        return {
            type: 'General', name: 'Training',
            reason: `building stats — success below threshold (${timesTrained.toFixed(0)}/${TRAINING_LIMIT} trains)`,
        };
    }

    // 6. Default: Field Analysis (earns small rank, improves population estimate).
    return { type: 'General', name: 'Field Analysis', reason: 'nothing better to do' };
}

/**
 * Pure query: is the next Black Op eligible to be offered as a decision?
 * Requires rank ≥ requirement AND estimated (min) success chance ≥ SUCCESS_THRESHOLD
 * — same success-chance idiom used for Operations/Contracts above, since a failed
 * Black Op is a real, sometimes-permanent setback (rank/reputation loss).
 */
function evaluateBlackOp(
    ns:   NS,
    rank: number,
): { name: BBName; reqRank: number; chance: number } | null {
    try {
        const next = ns.bladeburner.getNextBlackOp();
        if (!next || rank < next.rank) return null;
        if (ns.bladeburner.getActionCountRemaining('Black Operations', next.name) < 1) return null;
        const [minChance] = ns.bladeburner.getActionEstimatedSuccessChance('Black Operations', next.name);
        if (minChance < SUCCESS_THRESHOLD) return null;
        return { name: next.name, reqRank: next.rank, chance: minChance };
    } catch {
        return null;
    }
}

/**
 * Drive the Black Op decision state machine for one tick — the irreversible
 * counterpart to chooseAction(). Black Ops are one-shot (each is done at most
 * once ever) and a failure can permanently cost rank/reputation, so they are
 * NEVER started without an explicit 'approve' verdict via lib/decisions.ts:
 *
 *   1. Drain any reply for the current pending Black Op decision and update
 *      the active/denied/deferred state accordingly.
 *   2. If an approved op is still bladeburner's current action, keep selecting
 *      it as `choice` so chooseAction() can't preempt it mid-run (it never even
 *      runs while `choice` is non-null — see the call site in main()).
 *   3. Otherwise, once it resolves (success or failure — either way bladeburner
 *      moves off it), require a fresh approval before trying again; a failure
 *      already spent the one-shot risk this tick was gating.
 *   4. If nothing is active, evaluate the next Black Op and — unless a prior
 *      'deny' or 'defer' is still suppressing it — upsert a pending decision.
 *
 * Suppression reasoning: 'deny' is a considered veto on *this* op, so it stays
 * suppressed until rank has grown enough (BLACKOP_DENY_RANK_DELTA) that the
 * situation has materially changed; 'defer' is just "ask again later", so it's
 * a plain tick cooldown (BLACKOP_DEFER_TICKS).
 */
function handleBlackOps(
    ns:             NS,
    rank:           number,
    tick:           number,
    active:         BBName | null,
    deniedName:     BBName | null,
    deniedAtRank:   number,
    deferUntilTick: number,
): {
    active:         BBName | null;
    deniedName:     BBName | null;
    deniedAtRank:   number;
    deferUntilTick: number;
    choice:         { type: BBType; name: BBName; reason: string } | null;
} {
    // ── Apply any human/MCP verdict on a pending Black Op decision. ──────────
    for (const reply of drainReplies(ns, id => id.startsWith('bladeOp:'))) {
        const opName = reply.id.slice('bladeOp:'.length);
        removePending(ns, reply.id);
        if (reply.verdict === 'approve') {
            active = opName;
            ns.print(`INFO bladeburner: Black Op "${opName}" approved — starting.`);
        } else if (reply.verdict === 'deny') {
            deniedName   = opName;
            deniedAtRank = rank;
            ns.print(`INFO bladeburner: Black Op "${opName}" denied — suppressed until rank ≥ ${(rank + BLACKOP_DENY_RANK_DELTA).toFixed(0)}.`);
        } else if (reply.verdict === 'defer') {
            deferUntilTick = tick + BLACKOP_DEFER_TICKS;
            ns.print(`INFO bladeburner: Black Op "${opName}" deferred (~${((BLACKOP_DEFER_TICKS * LOOP_SLEEP_MS) / 60_000).toFixed(0)} min).`);
        }
    }

    // ── An approved op is running — keep selecting it until it resolves. ────
    if (active) {
        try {
            const current = ns.bladeburner.getCurrentAction();
            if (current && current.name === active) {
                return {
                    active, deniedName, deniedAtRank, deferUntilTick,
                    choice: { type: 'Black Operations', name: active, reason: 'approved Black Op in progress' },
                };
            }
        } catch { /* fall through — treat as resolved */ }
        ns.print(`INFO bladeburner: Black Op "${active}" resolved.`);
        active = null;
    }

    // ── Evaluate whether to surface a fresh decision. ────────────────────────
    const next = evaluateBlackOp(ns, rank);
    if (!next) return { active, deniedName, deniedAtRank, deferUntilTick, choice: null };

    const suppressedByDeny  = next.name === deniedName && rank < deniedAtRank + BLACKOP_DENY_RANK_DELTA;
    const suppressedByDefer = tick < deferUntilTick;
    if (suppressedByDeny || suppressedByDefer) {
        return { active, deniedName, deniedAtRank, deferUntilTick, choice: null };
    }

    const id    = `bladeOp:${next.name}`;
    const added = upsertPending(ns, {
        id, kind: 'bladeOp',
        prompt: `Black Op "${next.name}" available (rank ${rank.toFixed(0)}/${next.reqRank}, ` +
                `${(next.chance * 100).toFixed(0)}% est. success) — attempt it?`,
        context: { name: next.name, reqRank: next.reqRank, currentRank: rank, chance: next.chance },
        ts: Date.now(),
    });
    if (added) {
        notify(
            ns,
            `Black Op "${next.name}" available — ${(next.chance * 100).toFixed(0)}% estimated success. Attempt it?`,
            'Approve to start now; a failed Black Op can permanently cost rank/reputation.',
            { name: next.name, reqRank: next.reqRank, currentRank: rank, chance: next.chance },
        );
    }

    return { active, deniedName, deniedAtRank, deferUntilTick, choice: null };
}
