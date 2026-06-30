import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';

/**
 * stanek_manager.ts — persistent daemon for Stanek's Gift (docs/design/11).
 *
 * Availability: BN13 / SF13 + gift accepted. Checked each loop via try/catch
 * around ns.stanek.activeFragments(). Never exits on unavailability — idles
 * so the sequencer can revive it after a dev-cheat SF grant.
 *
 * Strategy (SAFE round): charge every placed non-booster fragment (id < 100)
 * once per pass. Booster fragments (id ≥ 100) absorb no charge — skipped.
 * Each chargeFragment() call uses the script's own RAM allocation; with a
 * single-threaded daemon this is modest but still grows fragments over time.
 *
 * NOT automated this round:
 *   - Board clear / re-layout     (irreversible, placement-optimizer needed)
 *   - Multi-threaded charge blitz  (requires spawning a helper script)
 *   // TODO(decision): optimal fragment placement via a safe placement planner.
 *
 * Metrics published each loop:
 *   fragmentCount    — total active fragments on the board
 *   nonBoosterCount  — chargeable (non-booster) fragment count
 *   minCharge        — lowest numCharge among chargeable fragments
 *   avgCharge        — mean numCharge across chargeable fragments
 *   totalCharges     — sum of numCharge across chargeable fragments
 *
 * RAM footprint: ~5.4 GB (activeFragments 5 GB + chargeFragment 0.4 GB).
 *
 * Reference: example_code_dump/alainbryden-bitburner-scripts/stanek.js
 */

// ── Timing constants ────────────────────────────────────────────────────────

/** Sleep between full charge passes when the gift is available and active. */
const LOOP_SLEEP_MS = 1_000;

/** Sleep when unavailable (no SF13 / gift not accepted) or disabled. */
const IDLE_SLEEP_MS = 10_000;

// ── Local structural type (mirrors ActiveFragment from @ns) ─────────────────
// Avoids referencing the ambient `ActiveFragment` name so this file type-checks
// even in worktrees where NetscriptDefinitions.d.ts is not resolved.
type StanekFrag = { id: number; x: number; y: number; numCharge: number; highestCharge: number };

// ── Entry point ─────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	while (true) {
		const settings = loadSettings(ns);
		const enabled  = settings.autoStanek;

		// ── Availability check ────────────────────────────────────────────────
		// activeFragments() throws if Stanek's Gift is not installed (no SF13 /
		// gift not yet accepted).  We use it directly as the availability probe
		// since we need the fragment list anyway and it costs the same RAM either way.
		let available = false;
		let fragments: StanekFrag[] = [];
		try {
			fragments = ns.stanek.activeFragments() as StanekFrag[];
			available = true;
		} catch {
			available = false;
		}

		// ── Unavailable branch ────────────────────────────────────────────────
		if (!available) {
			const status: SubsystemStatus = {
				id:       'stanek',
				available: false,
				enabled,
				running:  false,
				headline: "Stanek's Gift unavailable (need BN13/SF13 + accepted gift)",
				metrics:  {},
				ts:       Date.now(),
			};
			saveSubsystem(ns, status);
			await ns.sleep(IDLE_SLEEP_MS);
			continue;
		}

		// ── Disabled branch ───────────────────────────────────────────────────
		if (!enabled) {
			const status: SubsystemStatus = {
				id:       'stanek',
				available: true,
				enabled:  false,
				running:  false,
				headline: "Stanek's Gift available — autoStanek disabled",
				metrics:  {
					fragmentCount: fragments.length,
				},
				ts: Date.now(),
			};
			saveSubsystem(ns, status);
			await ns.sleep(IDLE_SLEEP_MS);
			continue;
		}

		// ── Active branch: compute metrics ────────────────────────────────────
		// Booster fragments (id ≥ 100) cannot be charged; skip them.
		const chargeable = fragments.filter(f => f.id < 100);

		let totalCharge = 0;
		let minCharge   = Infinity;
		for (const frag of chargeable) {
			totalCharge += frag.numCharge;
			if (frag.numCharge < minCharge) minCharge = frag.numCharge;
		}
		const avgCharge = chargeable.length > 0 ? totalCharge / chargeable.length : 0;
		const minChargeOut = chargeable.length > 0 ? +minCharge.toFixed(2) : 0;

		const headline = chargeable.length === 0
			? "Stanek's Gift: board empty — place fragments to begin charging"
			: `Stanek: charging ${chargeable.length} fragment(s), avg ${avgCharge.toFixed(1)} charges`;

		const status: SubsystemStatus = {
			id:       'stanek',
			available: true,
			enabled:  true,
			running:  chargeable.length > 0,
			headline,
			metrics: {
				fragmentCount:   fragments.length,
				nonBoosterCount: chargeable.length,
				minCharge:       minChargeOut,
				avgCharge:       +avgCharge.toFixed(2),
				totalCharges:    +totalCharge.toFixed(0),
			},
			ts: Date.now(),
		};
		saveSubsystem(ns, status);

		// ── Charge each non-booster fragment ─────────────────────────────────
		for (const frag of chargeable) {
			try {
				// chargeFragment(rootX, rootY) — async, uses script RAM per call.
				// More threads → stronger charge; single-thread is safe minimum.
				await ns.stanek.chargeFragment(frag.x, frag.y);
			} catch {
				// Fragment may have been removed from the board mid-loop; skip.
			}
		}

		await ns.sleep(LOOP_SLEEP_MS);
	}
}
