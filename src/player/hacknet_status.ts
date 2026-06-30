import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { formatMoney, formatRam, shortNumber } from '../lib/format';

/**
 * Hacknet status shim (docs/design/11 §3.2).
 *
 * STATUS SHIM — does NOT buy/upgrade nodes. Reports on the bootstrap-launched
 * hacknet engine (/compute/hacknet_manager.js) by publishing a SubsystemStatus
 * every ~5 s. The real engine manages upgrades; this shim just surfaces metrics
 * for the control console's Subsystems panel.
 *
 * id: 'hacknet'  |  available: always true  |  running: true
 * headline: "6 nodes · $1.2k/s"   (or "6 nodes · 4.20 H/s" in hash-mode)
 * metrics: nodes, prod/s, totalProduced, hashes/hashCap/hashFill% (hash-mode only),
 *          avgLevel, totalRam, avgCores
 */
export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	while (true) {
		let status: SubsystemStatus;

		try {
			const settings   = loadSettings(ns);
			const numNodes   = ns.hacknet.numNodes();

			let productionPerSec = 0;
			let totalProduced    = 0;
			let totalLevels      = 0;
			let totalRam         = 0;
			let totalCores       = 0;

			for (let i = 0; i < numNodes; i++) {
				try {
					const stats      = ns.hacknet.getNodeStats(i);
					productionPerSec += stats.production;
					totalProduced    += stats.totalProduction;
					totalLevels      += stats.level;
					totalRam         += stats.ram;
					totalCores       += stats.cores;
				} catch {
					// node unavailable — skip
				}
			}

			// Detect hash mode (hacknet servers rather than money-producing nodes)
			let hashes:   number | undefined;
			let hashCap:  number | undefined;
			let isHashMode = false;
			try {
				hashCap = ns.hacknet.hashCapacity();
				if (hashCap !== undefined && hashCap > 0) {
					isHashMode = true;
					hashes     = ns.hacknet.numHashes();
				}
			} catch {
				// traditional nodes — not hash mode
			}

			const prodLabel = isHashMode
				? `${shortNumber(productionPerSec)} H/s`
				: `${formatMoney(productionPerSec)}/s`;

			const headline = numNodes === 0
				? 'No hacknet nodes'
				: `${numNodes} nodes · ${prodLabel}`;

			const metrics: Record<string, number | string> = {
				nodes:         numNodes,
				'prod/s':      prodLabel,
				totalProduced: isHashMode
					? `${shortNumber(totalProduced)} H`
					: formatMoney(totalProduced),
			};

			if (isHashMode && hashes !== undefined && hashCap !== undefined) {
				metrics['hashes']    = shortNumber(hashes);
				metrics['hashCap']   = shortNumber(hashCap);
				metrics['hashFill%'] = hashCap > 0
					? `${((hashes / hashCap) * 100).toFixed(1)}%`
					: '0%';
			}

			if (numNodes > 0) {
				metrics['avgLevel']  = (totalLevels / numNodes).toFixed(0);
				metrics['totalRam']  = formatRam(totalRam);
				metrics['avgCores']  = (totalCores / numNodes).toFixed(1);
			}

			status = {
				id:        'hacknet',
				available: true,
				enabled:   settings.autoHacknet,
				running:   true,
				headline,
				metrics,
				ts:        Date.now(),
			};
		} catch (err) {
			// Guard any unexpected ns failure — still publish so console sees us
			status = {
				id:        'hacknet',
				available: true,
				enabled:   false,
				running:   false,
				headline:  `Hacknet error: ${String(err)}`,
				metrics:   {},
				ts:        Date.now(),
			};
		}

		saveSubsystem(ns, status);
		await ns.sleep(5000);
	}
}
