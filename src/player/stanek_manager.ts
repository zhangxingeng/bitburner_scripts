import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { upsertPending, removePending, drainReplies, loadPending } from '../lib/decisions';

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
 * Placement (this round — MVP, see findPlacementCandidate()): a deliberately
 * minimal decision-queue integration, NOT a layout optimizer. Every
 * PLACEMENT_SCAN_INTERVAL_TICKS the daemon considers non-booster fragments not
 * already at their board limit, ranked by `power` (highest first), and
 * brute-force scans (x, y, rotation) via canPlaceFragment for the first spot
 * that fits the first candidate that fits anywhere. A fit surfaces ONE
 * 'stanekPlacement' pending decision (lib/decisions.ts) — placeFragment() is
 * only ever called after an explicit 'approve' verdict.
 *
 * NOT automated this round:
 *   - Board clear / re-layout      (irreversible, placement-optimizer needed)
 *   - Multi-threaded charge blitz  (requires spawning a helper script)
 *   - Booster-fragment placement / adjacency planning (layout-optimizer territory)
 *
 * Metrics published each loop:
 *   fragmentCount    — total active fragments on the board
 *   nonBoosterCount  — chargeable (non-booster) fragment count
 *   minCharge        — lowest numCharge among chargeable fragments
 *   avgCharge        — mean numCharge across chargeable fragments
 *   totalCharges     — sum of numCharge across chargeable fragments
 *
 * RAM footprint: ~11.7 GB (activeFragments 5 + chargeFragment 0.4 +
 * giftWidth 0.4 + giftHeight 0.4 + canPlaceFragment 0.5 + placeFragment 5;
 * fragmentDefinitions is 0 GB).
 *
 * Reference: example_code_dump/alainbryden-bitburner-scripts/stanek.js
 */

// ── Timing constants ────────────────────────────────────────────────────────

/** Sleep between full charge passes when the gift is available and active. */
const LOOP_SLEEP_MS = 1_000;

/** Sleep when unavailable (no SF13 / gift not accepted) or disabled. */
const IDLE_SLEEP_MS = 10_000;

/** Rescan for a new placement candidate every N active-loop ticks (~45 s at
 * LOOP_SLEEP_MS = 1 s/tick). The scan brute-forces canPlaceFragment across the
 * whole board per candidate, so it's kept infrequent — canPlaceFragment has no
 * per-call RAM cost, but there's no reason to burn CPU scanning every tick. */
const PLACEMENT_SCAN_INTERVAL_TICKS = 45;

/** How long a "Defer" verdict suppresses re-surfacing a given fragment id
 * (120 ticks × 1 s ≈ 2 min — long enough not to spam, short enough to retry). */
const PLACEMENT_DEFER_TICKS = 120;

/** Stable id prefix for a per-fragment placement decision: `${PREFIX}${fragmentId}`. */
const STANEK_DECISION_PREFIX = 'stanekPlace:';

// ── Local structural types (mirror ActiveFragment / Fragment from @ns) ──────
// Avoids referencing the ambient names so this file type-checks even in
// worktrees where NetscriptDefinitions.d.ts is not resolved.
type StanekFrag = { id: number; x: number; y: number; numCharge: number; highestCharge: number };
type StanekFragDef = { id: number; type: number; power: number; limit: number };

/** A found (fragment, position) placement candidate, ready to surface as a decision. */
interface PlacementCandidate {
	fragmentId:   number;
	fragmentType: number;
	power:        number;
	x:            number;
	y:            number;
	rotation:     number;
}

/**
 * MVP fragment-selection + placement search (deliberately simple — NOT a
 * layout optimizer). Candidates: non-booster fragments (id < 100, matching
 * the charge loop's convention) not yet at their board `limit`, excluding any
 * denied/deferred id, ranked by `power` descending. For each candidate (best
 * first) brute-force scans every (x, y, rotation) via canPlaceFragment and
 * returns the first fit found (first-fit, not best-fit). Returns null if no
 * candidate fits anywhere.
 */
function findPlacementCandidate(
	ns: NS,
	activeFragments: StanekFrag[],
	deniedFragmentIds: Set<number>,
	deferUntilTick: Map<number, number>,
	tick: number,
): PlacementCandidate | null {
	let defs: StanekFragDef[];
	try {
		defs = ns.stanek.fragmentDefinitions() as StanekFragDef[];
	} catch {
		return null;
	}

	const activeCounts = new Map<number, number>();
	for (const f of activeFragments) activeCounts.set(f.id, (activeCounts.get(f.id) ?? 0) + 1);

	const candidates = defs
		.filter(f => f.id < 100)
		.filter(f => (activeCounts.get(f.id) ?? 0) < f.limit)
		.filter(f => !deniedFragmentIds.has(f.id))
		.filter(f => (deferUntilTick.get(f.id) ?? 0) <= tick)
		.sort((a, b) => b.power - a.power);

	if (candidates.length === 0) return null;

	const width  = ns.stanek.giftWidth();
	const height = ns.stanek.giftHeight();

	for (const frag of candidates) {
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				for (let rotation = 0; rotation < 4; rotation++) {
					if (ns.stanek.canPlaceFragment(x, y, rotation, frag.id)) {
						return { fragmentId: frag.id, fragmentType: frag.type, power: frag.power, x, y, rotation };
					}
				}
			}
		}
	}
	return null;
}

/** Drop any outstanding stanekPlacement decision (unavailable/disabled — stale). */
function clearStanekPending(ns: NS): void {
	for (const p of loadPending(ns)) {
		if (p.kind === 'stanekPlacement') removePending(ns, p.id);
	}
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	// ── Placement decision-queue state (persists across loop iterations) ─────
	let tick = 0;                                    // increments once per active-loop pass
	const deniedFragmentIds = new Set<number>();      // deny → suppress until board changes
	const deferUntilTick    = new Map<number, number>(); // defer → suppress until this tick
	let lastBoardFragmentCount = -1;                  // board fingerprint (clears denies on change)

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
			clearStanekPending(ns);
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
			clearStanekPending(ns);
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

		// ── Placement decision-queue (MVP — see findPlacementCandidate doc) ───
		tick++;

		// Board fingerprint changed (a placement/removal happened, by us or
		// otherwise) → any prior denials were about a now-stale layout, so
		// drop them and let candidates be reconsidered.
		if (fragments.length !== lastBoardFragmentCount) {
			if (lastBoardFragmentCount !== -1) deniedFragmentIds.clear();
			lastBoardFragmentCount = fragments.length;
		}

		// Apply any human/MCP verdicts on outstanding placement decisions.
		const pendingBeforeReplies = loadPending(ns);
		for (const reply of drainReplies(ns)) {
			if (!reply.id.startsWith(STANEK_DECISION_PREFIX)) continue;
			const entry = pendingBeforeReplies.find(p => p.id === reply.id);
			removePending(ns, reply.id);
			if (!entry) continue;
			const ctx = entry.context as { fragmentId: number; x: number; y: number; rotation: number } | undefined;
			if (!ctx) continue;
			if (reply.verdict === 'approve') {
				try {
					const placed = ns.stanek.placeFragment(ctx.x, ctx.y, ctx.rotation, ctx.fragmentId);
					ns.print(placed
						? `DECISION approved — placed fragment ${ctx.fragmentId} at (${ctx.x},${ctx.y}) rot ${ctx.rotation}`
						: `WARN: placeFragment(${ctx.fragmentId}) returned false — spot may no longer be valid`);
				} catch (err) {
					ns.print(`WARN: placeFragment(${ctx.fragmentId}) failed — ${err}`);
				}
			} else if (reply.verdict === 'deny') {
				deniedFragmentIds.add(ctx.fragmentId);
				ns.print(`DECISION denied — fragment ${ctx.fragmentId} placement suppressed until board changes`);
			} else if (reply.verdict === 'defer') {
				deferUntilTick.set(ctx.fragmentId, tick + PLACEMENT_DEFER_TICKS);
				ns.print(`DECISION deferred — fragment ${ctx.fragmentId} re-surfacing in ${PLACEMENT_DEFER_TICKS} ticks`);
			}
		}

		// Only scan for a new candidate when nothing is already pending, and
		// only at a slow cadence — the scan brute-forces canPlaceFragment
		// across the whole board per candidate (see constant doc above).
		const hasPendingPlacement = loadPending(ns).some(p => p.kind === 'stanekPlacement');
		if (!hasPendingPlacement && (tick === 1 || tick % PLACEMENT_SCAN_INTERVAL_TICKS === 0)) {
			const candidate = findPlacementCandidate(ns, fragments, deniedFragmentIds, deferUntilTick, tick);
			if (candidate) {
				const id = `${STANEK_DECISION_PREFIX}${candidate.fragmentId}`;
				const added = upsertPending(ns, {
					id,
					kind: 'stanekPlacement',
					prompt: `Place fragment ${candidate.fragmentId} (type ${candidate.fragmentType}, power ${candidate.power}) at (${candidate.x}, ${candidate.y}) rot ${candidate.rotation}?`,
					command: 'run /player/stanek_manager.js (approve via decision queue)',
					context: {
						fragmentId:   candidate.fragmentId,
						fragmentType: candidate.fragmentType,
						power:        candidate.power,
						x:            candidate.x,
						y:            candidate.y,
						rotation:     candidate.rotation,
					},
					ts: Date.now(),
				});
				if (added) ns.print(`Stanek: surfaced placement decision for fragment ${candidate.fragmentId}`);
			}
		}

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
