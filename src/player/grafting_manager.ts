import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { formatMoney } from '../lib/format';
import { loadPending, upsertPending, removePending, drainReplies } from '../lib/decisions';

/**
 * Grafting Manager (docs/design/11) — auto-graft daemon.
 *
 * BN10 / SF10 feature. Grafting spends real money and a multi-minute block of
 * game time and is effectively irreversible, so acting on it is routed through
 * the shared approve/deny/defer decision queue (lib/decisions.ts) rather than
 * fired unattended — mirrors the aug/reset judgment call in player_sequencer.ts.
 *
 * Availability is detected by calling ns.grafting.getGraftableAugmentations()
 * inside a try/catch — the API throws when grafting is not unlocked. On failure
 * the manager publishes available:false and idles; it does NOT exit so it picks
 * up access automatically after a dev-cheat SF grant.
 *
 * Whether a graft is actively running is detected via ns.singularity.getCurrentWork()
 * (SF4 gated — wrapped in its own try/catch so the manager works without SF4).
 *
 * Grafting itself (ns.grafting.graftAugmentation) is NOT Singularity-gated (it
 * lives under ns.grafting, not ns.singularity), so no ns_dodge/SF4 wrapping is
 * needed for the actual graft call — only the optional "currently grafting?"
 * probe above needs SF4.
 *
 * API surface used:
 *   ns.grafting.getGraftableAugmentations()     → string[]
 *   ns.grafting.getAugmentationGraftPrice(name) → number
 *   ns.grafting.graftAugmentation(name, focus)  → boolean (throws if not in New Tokyo)
 *   ns.singularity.getCurrentWork()             → Task | null  (type 'GRAFTING' + .augmentation)
 */

const SLEEP_MS = 10_000;   // Grafting is slow; 10 s cadence is plenty

/** Stable id for the (single) auto-graft judgment call. */
const GRAFT_DECISION_ID = 'graftCheapest';

/** How many ticks a "Defer" verdict suppresses re-surfacing (≈5 min at 10 s cadence). */
const GRAFT_DEFER_TICKS = 30;

const NEW_TOKYO = 'New Tokyo';

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    let tick = 0;

    // "Deny" suppression: remember which aug was denied — re-surface once the
    // cheapest candidate changes (cheaper aug bought elsewhere, aug list shifts, etc).
    let deniedAug = '';
    // "Defer" suppression: cooldown, independent of which aug is cheapest.
    let deferUntilTick = 0;

    while (true) {
        tick++;

        const settings = loadSettings(ns);
        const enabled  = settings.autoGrafting;

        // ── Apply human/MCP verdicts on the auto-graft decision ─────────────
        // Responders (control console, MCP agent) push to PORT_DECISION_REPLY; we
        // own applying the verdict and clearing the pending entry (lib/decisions.ts).
        // The candidate aug/cost is read back from the pending entry's own context
        // (set when it was surfaced below) rather than trusting the reply payload.
        const repliesReceived = drainReplies(ns);
        if (repliesReceived.length > 0) {
            const pendingNow = loadPending(ns).find(p => p.id === GRAFT_DECISION_ID);
            const ctxAug  = (pendingNow?.context?.['cheapestAug'] as string | undefined)  ?? '';
            const ctxCost = (pendingNow?.context?.['cheapestCost'] as number | undefined) ?? 0;
            for (const reply of repliesReceived) {
                if (reply.id !== GRAFT_DECISION_ID) continue;
                removePending(ns, GRAFT_DECISION_ID);
                if (reply.verdict === 'approve') {
                    if (ctxAug) {
                        const ok = ns.grafting.graftAugmentation(ctxAug, false);
                        ns.print(ok
                            ? `DECISION approved — grafting started: ${ctxAug} (${formatMoney(ctxCost)})`
                            : `WARN: graftAugmentation(${ctxAug}) returned false (too poor / prereqs?)`);
                    } else {
                        ns.print('WARN: approve verdict received but no cached graft candidate — ignored');
                    }
                } else if (reply.verdict === 'deny') {
                    deniedAug = ctxAug;
                    ns.print(`DECISION denied — ${deniedAug || 'aug'} suppressed until candidate changes`);
                } else if (reply.verdict === 'defer') {
                    deferUntilTick = tick + GRAFT_DEFER_TICKS;
                    ns.print(`DECISION deferred — re-surfacing in ${GRAFT_DEFER_TICKS} ticks`);
                }
            }
        }

        // ── Availability guard ──────────────────────────────────────────────
        // ns.grafting.* throws when BN10 / SF10 is absent or Graft access
        // has not been purchased from the city vendor.
        let graftable: string[];
        try {
            graftable = ns.grafting.getGraftableAugmentations();
        } catch {
            removePending(ns, GRAFT_DECISION_ID);
            const status: SubsystemStatus = {
                id:       'grafting',
                available: false,
                enabled,
                running:  false,
                headline: 'Grafting unavailable (need BN10/SF10 + Graft access)',
                metrics:  {},
                ts:       Date.now(),
            };
            saveSubsystem(ns, status);
            await ns.sleep(SLEEP_MS);
            continue;
        }

        // ── Available — build report ────────────────────────────────────────
        const count = graftable.length;

        // Find cheapest graftable aug (the most immediately actionable candidate).
        let cheapestAug  = '';
        let cheapestCost = Infinity;
        for (const aug of graftable) {
            const cost = ns.grafting.getAugmentationGraftPrice(aug);
            if (cost < cheapestCost) {
                cheapestCost = cost;
                cheapestAug  = aug;
            }
        }

        // ── Currently grafting? (requires SF4 singularity; optional) ────────
        let currentlyGrafting = false;
        let activeAug         = '';
        try {
            const work = ns.singularity.getCurrentWork();
            if (work !== null && work.type === 'GRAFTING') {
                currentlyGrafting = true;
                // TypeScript narrows work to GraftingTask after the type check.
                activeAug = work.augmentation;
            }
        } catch {
            // SF4 not available — skip current-work detection
        }

        // ── Auto-graft decision (design/11 §3.4) ─────────────────────────────
        // Surfaced only when: enabled, a graftable aug exists, player is in New
        // Tokyo (grafting throws otherwise), nothing is already grafting, and the
        // player can afford it. Approve/deny/defer replies are drained above.
        const player      = ns.getPlayer();
        const inNewTokyo  = player.city === NEW_TOKYO;
        const affordable  = isFinite(cheapestCost) && player.money >= cheapestCost;
        const actionable  = enabled && cheapestAug !== '' && !currentlyGrafting && inNewTokyo && affordable;

        if (actionable) {
            const suppressed = cheapestAug === deniedAug || tick < deferUntilTick;
            if (!suppressed) {
                upsertPending(ns, {
                    id:      GRAFT_DECISION_ID,
                    kind:    'graft',
                    prompt:  `Graft ${cheapestAug} for ${formatMoney(cheapestCost)}?`,
                    command: `ns.grafting.graftAugmentation("${cheapestAug}", false)`,
                    context: { cheapestAug, cheapestCost },
                    ts:      Date.now(),
                });
            }
        } else {
            // Not currently actionable (disabled, unaffordable, wrong city, or
            // already grafting) — drop any stale pending entry.
            removePending(ns, GRAFT_DECISION_ID);
        }

        // ── Compose headline + metrics ──────────────────────────────────────
        let headline: string;
        if (currentlyGrafting) {
            headline = `Grafting: active — ${activeAug}`;
        } else if (count === 0) {
            headline = 'Grafting: no new augmentations available';
        } else {
            const costStr = isFinite(cheapestCost) ? ` (${formatMoney(cheapestCost)})` : '';
            const cityNote = cheapestAug && !inNewTokyo ? ' [not in New Tokyo]' : '';
            headline = `Grafting: ${count} aug${count === 1 ? '' : 's'} available — next: ${cheapestAug}${costStr}${cityNote}`;
        }

        const metrics: Record<string, number | string> = {
            graftableCount: count,
        };
        if (cheapestAug && isFinite(cheapestCost)) {
            metrics['cheapestAug']  = cheapestAug;
            metrics['cheapestCost'] = formatMoney(cheapestCost);
        }
        if (currentlyGrafting) {
            metrics['activeGraft'] = activeAug;
        }

        const status: SubsystemStatus = {
            id:       'grafting',
            available: true,
            enabled,
            running:  currentlyGrafting,
            headline,
            metrics,
            ts:       Date.now(),
        };
        saveSubsystem(ns, status);

        await ns.sleep(SLEEP_MS);
    }
}
