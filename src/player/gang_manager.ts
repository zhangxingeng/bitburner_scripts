import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';

/**
 * Gang manager (docs/design/11) — STUB. Wave 1 replaces the body.
 *
 * Contract: a PERSISTENT daemon. Each loop, check feature availability; if absent
 * publish { available:false } and idle (DO NOT exit — the sequencer keeps it
 * alive so it picks up availability after a dev-cheat SF grant). When available,
 * do the management work, publish live metrics, and surface irreversible/scarce
 * spends as decisions (lib/decisions.ts) rather than auto-spending.
 *
 * Reference: ref example_code_dump/alainbryden-bitburner-scripts/gangs.js.
 */
export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');
	while (true) {
		saveSubsystem(ns, {
			id: 'gang',
			available: false,
			enabled: true,
			running: false,
			headline: 'Gang — pending Wave 1',
			metrics: {},
			ts: Date.now(),
		});
		await ns.sleep(10000);
	}
}
