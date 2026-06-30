import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';

/**
 * Corp manager (docs/design/11 §6) — DEFERRED. Intentionally a permanent stub
 * this round: it fills the registry/console slot (so toggling autoCorp is inert
 * and the Subsystems panel shows a "deferred" row) while real corporation
 * automation waits for a focused follow-up round. Keeps the same persistent-daemon
 * shape as the other managers so wiring it up later is a body swap.
 */
export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');
	while (true) {
		saveSubsystem(ns, {
			id: 'corp',
			available: false,
			enabled: true,
			running: false,
			headline: 'Corp — automation deferred',
			metrics: {},
			ts: Date.now(),
		});
		await ns.sleep(10000);
	}
}
