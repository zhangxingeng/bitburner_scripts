import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { formatMoney } from '../lib/format';

/**
 * Grafting Manager (docs/design/11) — persistent reporter daemon.
 *
 * BN10 / SF10 feature. Grafting spends real money and a multi-minute block of
 * game time and is effectively irreversible, so this round the manager is a
 * REPORTER only: it publishes what is graftable and the cheapest candidate.
 *
 * Availability is detected by calling ns.grafting.getGraftableAugmentations()
 * inside a try/catch — the API throws when grafting is not unlocked. On failure
 * the manager publishes available:false and idles; it does NOT exit so it picks
 * up access automatically after a dev-cheat SF grant.
 *
 * Whether a graft is actively running is detected via ns.singularity.getCurrentWork()
 * (SF4 gated — wrapped in its own try/catch so the manager works without SF4).
 *
 * API surface used:
 *   ns.grafting.getGraftableAugmentations()     → string[]
 *   ns.grafting.getAugmentationGraftPrice(name) → number
 *   ns.singularity.getCurrentWork()             → Task | null  (type 'GRAFTING' + .augmentation)
 */

const SLEEP_MS = 10_000;   // Grafting is slow; 10 s cadence is plenty

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    while (true) {
        const settings = loadSettings(ns);
        const enabled  = settings.autoGrafting;

        // ── Availability guard ──────────────────────────────────────────────
        // ns.grafting.* throws when BN10 / SF10 is absent or Graft access
        // has not been purchased from the city vendor.
        let graftable: string[];
        try {
            graftable = ns.grafting.getGraftableAugmentations();
        } catch {
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

        // TODO(decision): once subsystem decision-routing exists, auto-graft
        // cheapestAug here when settings.autoGrafting is true and the player
        // has enough money and is in New Tokyo.
        //   ns.grafting.graftAugmentation(cheapestAug, false)

        // ── Compose headline + metrics ──────────────────────────────────────
        let headline: string;
        if (currentlyGrafting) {
            headline = `Grafting: active — ${activeAug}`;
        } else if (count === 0) {
            headline = 'Grafting: no new augmentations available';
        } else {
            const costStr = isFinite(cheapestCost) ? ` (${formatMoney(cheapestCost)})` : '';
            headline = `Grafting: ${count} aug${count === 1 ? '' : 's'} available — next: ${cheapestAug}${costStr}`;
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
