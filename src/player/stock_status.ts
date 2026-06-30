import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { formatMoney } from '../lib/format';

/**
 * Stock status shim (docs/design/11 §3.2).
 *
 * STATUS SHIM — does NOT place trades. Reports on the bootstrap-launched stock
 * engine (/stock/main.js) by publishing a SubsystemStatus every ~5 s. The stock
 * engine writes only to PORT_STOCK (coordinator coupling) and HUD — it emits no
 * status file — so we read portfolio state directly via ns.stock.*.
 *
 * availability gate: ns.stock.hasTixApiAccess() — false/throw → available:false
 *
 * id: 'stock'  |  running: true (when available)
 * headline: "Portfolio $4.50m · +$300.00k"
 * metrics: positions, totalValue, totalProfit (longs + shorts combined)
 *
 * Long  P/L: sharesLong  * (getBidPrice − avgLongPrice)   (bid = what market pays us)
 * Short P/L: sharesShort * (avgShortPrice − getPrice)      (price fell = profit)
 */
export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');

	while (true) {
		let status: SubsystemStatus;

		try {
			const settings = loadSettings(ns);

			// ── Availability gate ────────────────────────────────────────────
			let hasApi = false;
			try {
				hasApi = ns.stock.hasTixApiAccess();
			} catch {
				hasApi = false;
			}

			if (!hasApi) {
				status = {
					id:        'stock',
					available: false,
					enabled:   settings.autoStock,
					running:   false,
					headline:  'Stock API not purchased',
					metrics:   {},
					ts:        Date.now(),
				};
				saveSubsystem(ns, status);
				await ns.sleep(5000);
				continue;
			}

			// ── Portfolio scan ───────────────────────────────────────────────
			const symbols = ns.stock.getSymbols();

			let totalValue  = 0;
			let totalProfit = 0;
			let positionsHeld = 0;

			for (const sym of symbols) {
				try {
					const [sharesLong, avgLongPrice, sharesShort, avgShortPrice] =
						ns.stock.getPosition(sym);

					if (sharesLong > 0) {
						const bid       = ns.stock.getBidPrice(sym);
						const value     = sharesLong * bid;
						const profit    = sharesLong * (bid - avgLongPrice);
						totalValue      += value;
						totalProfit     += profit;
						positionsHeld++;
					}

					if (sharesShort > 0) {
						// Short value is the locked-in collateral (avgShortPrice * shares).
						// Unrealized P/L = shares * (avgShortPrice − currentPrice).
						const price     = ns.stock.getPrice(sym);
						const value     = sharesShort * avgShortPrice;
						const profit    = sharesShort * (avgShortPrice - price);
						totalValue      += value;
						totalProfit     += profit;
						positionsHeld++;
					}
				} catch {
					// symbol unavailable — skip
				}
			}

			const profitLabel = totalProfit >= 0
				? `+${formatMoney(totalProfit)}`
				: `-${formatMoney(Math.abs(totalProfit))}`;

			const headline = positionsHeld === 0
				? 'No open positions'
				: `Portfolio ${formatMoney(totalValue)} · ${profitLabel}`;

			status = {
				id:        'stock',
				available: true,
				enabled:   settings.autoStock,
				running:   true,
				headline,
				metrics: {
					positions:   positionsHeld,
					totalValue:  formatMoney(totalValue),
					totalProfit: profitLabel,
				},
				ts:        Date.now(),
			};
		} catch (err) {
			// Guard unexpected ns failure — still publish so console sees us
			status = {
				id:        'stock',
				available: false,
				enabled:   false,
				running:   false,
				headline:  `Stock error: ${String(err)}`,
				metrics:   {},
				ts:        Date.now(),
			};
		}

		saveSubsystem(ns, status);
		await ns.sleep(5000);
	}
}
