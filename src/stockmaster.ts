import { NS } from '@ns';
import { formatMoney } from './lib/util_normal_ram';
import { StockConfig } from './stock_lib/stock_config';
import { StockMarket } from './stock_lib/stock_market';
import { StockTrader } from './stock_lib/stock_trader';
import { isSingleInstance } from './lib/util_normal_ram';

// For HUD display
interface HudElement extends HTMLElement {
    innerText: string;
}

/**
 * Main entry point for the stock trading script.
 * Implements a comprehensive stock trading strategy with market cycle detection.
 */
export async function main(ns: NS): Promise<void> {
    // Parse command line arguments
    const args = ns.flags([
        ['l', false],
        ['liquidate', false],
        ['mock', false],
        ['reserve', 0],
        ['disable-shorts', false],
        ['disableHud', false]
    ]);

    // Process liquidate flag
    if (args.l || args.liquidate) {
        await liquidateAllPositions(ns);
        return;
    }

    // Ensure only one instance is running
    if (!isSingleInstance(ns)) {
        ns.tprint('ERROR: An instance of the stock script is already running. Use --liquidate to sell all positions first.');
        return;
    }

    // Initialize objects
    const config = new StockConfig(ns);
    const market = new StockMarket(ns, config);
    const trader = new StockTrader(ns, config, market);

    // Disable logs and open tail window
    ns.disableLog('ALL');
    ns.ui.openTail();
    ns.clearLog();

    // Initialize HUD if enabled
    let hudElement: HudElement | null = null;
    if (!args.disableHud) {
        hudElement = initializeHud();
        ns.atExit(() => {
            if (hudElement && hudElement.parentElement && hudElement.parentElement.parentElement) {
                hudElement.parentElement.parentElement.parentElement?.removeChild(hudElement.parentElement.parentElement);
            }
        });
    }

    // Welcome message
    ns.print(`Welcome to the Optimized Stock Trader Script!
Note: Stock purchases will initially show a loss due to commission and spread.
This script is designed to buy stocks that are most likely to turn a profit.
To stop the script and liquidate all positions, run with --liquidate or -l.`);

    // Initialize market and trader
    await market.initialize();
    await trader.initialize();

    // If we don't have TIX API access, try to buy it when we have enough money
    if (!ns.stock.hasTIXAPIAccess()) {
        ns.print('Waiting for enough money to purchase stock market API access...');
        while (!ns.stock.hasTIXAPIAccess()) {
            const playerMoney = ns.getPlayer().money;
            const reserveAmount = args.reserve as number;
            await trader.tryPurchaseAPIs(playerMoney, reserveAmount);
            await ns.sleep(5000);
        }

        // Re-initialize after getting access
        await market.initialize();
        await trader.initialize();
    }

    // Main trading loop
    let tick = 0;
    let lastTickTime = Date.now();

    while (true) {
        try {
            // Check if enough time passed for a potential tick
            const currentTime = Date.now();
            const timeSinceLastTick = currentTime - lastTickTime;
            const tickHappened = timeSinceLastTick > 4000;

            // Get player info
            const player = ns.getPlayer();
            const reserveAmount = args.reserve as number;

            // Buy APIs if possible
            await trader.tryPurchaseAPIs(player.money, reserveAmount);

            // Refresh stock data
            const portfolioValue = await market.refreshStockData();
            const corpus = portfolioValue + player.money;

            // Try to get 4S API if we don't have it yet
            if (!ns.stock.has4SData() && config.apiOptions.autoUnlockApis) {
                await trader.tryGet4SApi(player, corpus, reserveAmount);
            }

            // Check if we have stocks and update HUD
            if (portfolioValue > 0 && hudElement) {
                hudElement.innerText = formatMoney(portfolioValue);
            } else if (hudElement) {
                hudElement.innerText = '$0.000';
            }

            // Sell positions if conditions are met
            const sales = await trader.managePositions();

            // If positions were sold, refresh data
            let updatedPortfolioValue = portfolioValue;
            if (sales > 0) {
                await market.refreshStockData();
                updatedPortfolioValue = market.getTotalPortfolioValue();
            }

            // Buy positions if we have enough liquidity
            await trader.executeBuyOpportunities(player.money, updatedPortfolioValue, reserveAmount);

            // Status update
            if (tick % 10 === 0 || sales > 0) {
                ns.print(`Portfolio: ${formatMoney(updatedPortfolioValue)}, Cash: ${formatMoney(player.money)}`);
            }

            // Update the last tick time if enough time passed and we detected a tick
            if (tickHappened) {
                lastTickTime = currentTime;
            }

            // Sleep
            await ns.sleep(1000);
            tick++;

        } catch (error) {
            ns.print(`ERROR: ${String(error)}`);
            await ns.sleep(5000);
        }
    }
}

/**
 * Liquidate all stock positions
 */
async function liquidateAllPositions(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    // Create objects for liquidation
    const config = new StockConfig(ns);
    const market = new StockMarket(ns, config);
    const trader = new StockTrader(ns, config, market);

    await market.initialize();
    const revenue = await trader.liquidatePositions();

    ns.tprint(`Liquidated all stock positions for ${formatMoney(revenue)}`);
}

/**
 * Initialize the HUD display for stock value
 */
function initializeHud(): HudElement {
    const d = eval('document');
    let htmlDisplay = d.getElementById('stock-display-1') as HudElement;
    if (htmlDisplay !== null) return htmlDisplay;

    // Get the custom display elements in HUD
    const customElements = d.getElementById('overview-extra-hook-0')?.parentElement?.parentElement;
    if (!customElements) return null as unknown as HudElement;

    // Make a clone of the hook for extra hud elements, and move it up under money
    const stockValueTracker = customElements.cloneNode(true) as HTMLElement;

    // Remove any nested elements created by stats.js
    stockValueTracker.querySelectorAll('p > p').forEach(el => el.parentElement?.removeChild(el));

    // Change ids since duplicate id's are invalid
    stockValueTracker.querySelectorAll('p').forEach((el, i) => el.id = 'stock-display-' + i);

    // Get our output element
    htmlDisplay = stockValueTracker.querySelector('#stock-display-1') as HudElement;

    // Display label and default value
    const labelElement = stockValueTracker.querySelectorAll('p')[0];
    if (labelElement) labelElement.innerText = 'Stock';
    if (htmlDisplay) htmlDisplay.innerText = '$0.000';

    // Insert our element right after Money
    customElements.parentElement?.insertBefore(stockValueTracker, customElements.parentElement.childNodes[2]);

    return htmlDisplay;
}
