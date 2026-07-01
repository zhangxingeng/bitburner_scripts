import { NS } from '@ns';
import { formatMoney } from '../lib/format';
import { StockConfig } from './config';
import { StockMarket } from './market';
import { StockTrader } from './trader';
import { isSingleInstance } from '../lib/servers';
import { PORT_STOCK, pushPort, clearPort } from '../lib/ports';

// For HUD display
interface HudElement extends HTMLElement {
    innerText: string;
}

// ── Position-publishing types ──────────────────────────────────────────────────

/** Per-symbol report written to PORT_STOCK each cycle.
 *  Coordinator reads this to bias grow→longs and hack→shorts (stock↔hack coupling).
 *  Matches Zharay port-16 schema: zharay.md §"Stock Trading" → reportStocks().
 */
interface StockPosition {
    sym:             string;
    long:            boolean;
    short:           boolean;
    /** profitPotential = volatility * (forecast - 0.5); Zharay formula (unadjusted).
     *  Positive = bullish (grow the underlying), negative = bearish (hack it). */
    profitPotential: number;
    /** Change in profitPotential since position was opened.
     *  TODO(design): track purchaseProfitPotential in Stock when a buy executes so
     *  the coordinator can detect momentum decay (>-25% = sell long; >+25% = sell short). */
    profitChange:    number;
}

/**
 * Publish current long/short positions to PORT_STOCK.
 * Port writes are 0 GB.  Coordinator (and future batcher) drain this to decide
 * whether to bias grow or hack toward each underlying server.
 */
function reportPositions(ns: NS, market: StockMarket): void {
    const owned = market.getOwnedStocks();
    if (owned.length === 0) {
        clearPort(ns, PORT_STOCK);
        return;
    }

    const report: StockPosition[] = owned.map(stock => ({
        sym:             stock.symbol,
        long:            stock.sharesLong > 0,
        short:           stock.sharesShort > 0,
        profitPotential: stock.profitPotential(),
        profitChange:    0, // TODO(design): see StockPosition.profitChange above
    }));

    clearPort(ns, PORT_STOCK);
    pushPort(ns, PORT_STOCK, JSON.stringify(report));
}

/**
 * Main entry point for the stock trading daemon.
 *
 * Moved from contracts/stock.ts (Phase 4).  Key changes vs the old entry:
 *   - Hard exit guard on APIs replaced by a wait-and-buy loop so the daemon
 *     can be launched by the coordinator before WSE/TIX are purchased.
 *   - Publishes positions to PORT_STOCK each cycle (stock↔hack coupling, cheap half).
 *   - Phase-gated launch: coordinator starts this at EARLY+; the daemon itself is
 *     agnostic to phase and simply runs while APIs are available.
 */
export async function main(ns: NS): Promise<void> {
    const args = ns.flags([
        ['l', false],
        ['liquidate', false],
        ['mock', false],
        ['reserve', 0],
        ['disable-shorts', false],
        ['disableHud', false],
    ]);

    // Liquidate flag: sell everything and exit (no API guard needed for listing positions)
    if (args.l || args.liquidate) {
        await liquidateAllPositions(ns);
        return;
    }

    if (!isSingleInstance(ns)) return;

    ns.disableLog('ALL');
    ns.enableLog('print');

    // ── Wait until TIX API is available, purchasing along the way ────────────
    // The coordinator launches this at EARLY phase; money to buy WSE ($200M) and
    // TIX API ($5B) may not be available immediately — loop until they are.
    while (!ns.stock.hasTixApiAccess()) {
        const money = ns.getPlayer().money;
        if (!ns.stock.hasWseAccount() && money > 200e6) {
            if (ns.stock.purchaseWseAccount()) {
                ns.print('Stock: purchased WSE account');
            }
        } else if (ns.stock.hasWseAccount() && money > 5e9) {
            if (ns.stock.purchaseTixApi()) {
                ns.print('Stock: purchased TIX API');
                break;
            }
        }
        await ns.sleep(10_000);
    }

    // Initialize objects
    const config = new StockConfig(ns);
    const market = new StockMarket(ns, config);
    const trader  = new StockTrader(ns, config, market);

    ns.ui.openTail();
    ns.clearLog();

    // HUD setup
    let hudElement: HudElement | null = null;
    if (!args.disableHud) {
        hudElement = initializeHud();
        ns.atExit(() => {
            if (hudElement?.parentElement?.parentElement) {
                hudElement.parentElement.parentElement.parentElement
                    ?.removeChild(hudElement.parentElement.parentElement);
            }
            clearPort(ns, PORT_STOCK);
        });
    }

    ns.print(`Stock engine running. TIX: ${ns.stock.hasTixApiAccess()}, 4S: ${ns.stock.has4SData()}`);

    await market.initialize();
    await trader.initialize();

    let tick         = 0;
    let lastTickTime = Date.now();

    while (true) {
        try {
            const now            = Date.now();
            const timeSinceTick  = now - lastTickTime;
            const tickHappened   = timeSinceTick > 4000;

            const player        = ns.getPlayer();
            const reserveAmount = args.reserve as number;

            // Auto-purchase remaining stock APIs (WSE → TIX → 4S data → 4S TIX API)
            await trader.tryPurchaseAPIs(player.money, reserveAmount);

            // Refresh market data
            const portfolioValue = await market.refreshStockData();
            const corpus         = portfolioValue + player.money;

            // Try to upgrade to 4S API once corpus allows (liquidates if needed)
            if (!ns.stock.has4SData() && config.apiOptions.autoUnlockApis) {
                await trader.tryGet4SApi(player, corpus, reserveAmount);
            }

            // HUD update
            if (hudElement) {
                hudElement.innerText = portfolioValue > 0 ? formatMoney(portfolioValue) : '$0.000';
            }

            // Sell positions first, then refresh, then buy
            const sales = await trader.managePositions();
            let updatedPortfolioValue = portfolioValue;
            if (sales > 0) {
                await market.refreshStockData();
                updatedPortfolioValue = market.getTotalPortfolioValue();
            }
            await trader.executeBuyOpportunities(player.money, updatedPortfolioValue, reserveAmount);

            // Publish positions to PORT_STOCK every cycle for coordinator coupling
            reportPositions(ns, market);

            // Periodic status log
            if (tick % 10 === 0 || sales > 0) {
                ns.print(`Portfolio: ${formatMoney(updatedPortfolioValue)}  Cash: ${formatMoney(player.money)}` +
                         `  4S: ${ns.stock.has4SData()}`);
            }

            if (tickHappened) lastTickTime = now;

            await ns.sleep(1000);
            tick++;
        } catch (error) {
            ns.print(`ERROR: ${String(error)}`);
            await ns.sleep(5000);
        }
    }
}

/**
 * Liquidate all stock positions and exit.
 */
async function liquidateAllPositions(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    if (!ns.stock.hasTixApiAccess()) {
        ns.tprint('Stock: no TIX API — nothing to liquidate');
        return;
    }
    const config = new StockConfig(ns);
    const market  = new StockMarket(ns, config);
    const trader  = new StockTrader(ns, config, market);
    await market.initialize();
    const revenue = await trader.liquidatePositions();
    clearPort(ns, PORT_STOCK);
    ns.tprint(`Stock: liquidated all positions for ${formatMoney(revenue)}`);
}

/**
 * Initialize the HUD display element for stock portfolio value.
 */
function initializeHud(): HudElement {
    const d = eval('docu'+'ment');
    let htmlDisplay = d.getElementById('stock-display-1') as HudElement;
    if (htmlDisplay !== null) return htmlDisplay;

    const customElements = d.getElementById('overview-extra-hook-0')?.parentElement?.parentElement;
    if (!customElements) return null as unknown as HudElement;

    const stockValueTracker = customElements.cloneNode(true) as HTMLElement;
    stockValueTracker.querySelectorAll('p > p').forEach((el: Element) =>
        el.parentElement?.removeChild(el));
    stockValueTracker.querySelectorAll('p').forEach((el: Element, i: number) =>
        ((el as HTMLElement).id = 'stock-display-' + i));

    htmlDisplay = stockValueTracker.querySelector('#stock-display-1') as HudElement;

    const labelElement = stockValueTracker.querySelectorAll('p')[0] as HTMLElement;
    if (labelElement) labelElement.innerText = 'Stock';
    if (htmlDisplay)  htmlDisplay.innerText  = '$0.000';

    customElements.parentElement?.insertBefore(
        stockValueTracker, customElements.parentElement.childNodes[2]);

    return htmlDisplay;
}
