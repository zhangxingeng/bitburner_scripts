import { NS } from '@ns';
import { Stock } from './stock';
import { StockConfig } from './stock_config';
import { formatMoney, shortNumber } from '../lib/utils';
import { ForecastHelper } from './forecast_helper';

/**
 * Manages the stock market data and operations
 */
export class StockMarket {
    private ns: NS;
    private config: StockConfig;
    private forecastHelper: ForecastHelper;

    // Stock storage
    private allStocks: Stock[] = [];
    private myStocks: Stock[] = [];
    private allSymbols: string[] = [];

    // Status tracking
    private totalProfit: number = 0;
    private lastLog: string = '';
    private lastTick: number = 0;

    // Market analysis
    private marketCycleDetected: boolean = false;
    private detectedCycleTick: number = 0;
    private inversionAgreementThreshold: number = 6;

    // Feature flags
    private has4SData: boolean = false;

    /**
     * Constructor
     * @param ns NetScript API
     * @param config Stock configuration
     */
    constructor(ns: NS, config: StockConfig) {
        this.ns = ns;
        this.config = config;
        this.forecastHelper = new ForecastHelper(ns);
    }

    /**
     * Initialize the stock market
     */
    async initialize(): Promise<void> {
        // Check for 4S data access
        this.has4SData = this.ns.stock.has4SData();

        // Get all stock symbols
        this.allSymbols = this.ns.stock.getSymbols();

        // Initialize stock objects
        await this.initializeStocks();

        // Initialize global variables
        this.totalProfit = 0;
        this.lastLog = '';
        this.marketCycleDetected = false;
        this.detectedCycleTick = 0;
        this.inversionAgreementThreshold = 6;
    }

    /**
     * Initialize stock objects
     */
    private async initializeStocks(): Promise<void> {
        this.allStocks = [];

        for (const symbol of this.allSymbols) {
            const stock = new Stock(symbol);

            // Get max shares (doesn't change)
            stock.maxShares = this.ns.stock.getMaxShares(symbol);

            this.allStocks.push(stock);
        }

        // Do an initial refresh to populate data
        await this.refreshStockData();
    }

    /**
     * Refresh all stock data
     * @returns Total value of holdings
     */
    async refreshStockData(): Promise<number> {
        let holdings = 0;
        this.myStocks = [];

        // Check if market has ticked by checking if any price has changed
        const firstStock = this.allStocks[0];
        const newPrice = this.ns.stock.getAskPrice(firstStock.symbol);
        const ticked = firstStock.ask_price !== newPrice;

        // Update last tick time
        if (ticked) {
            this.lastTick = Date.now();
        }

        // Update each stock's data
        for (const stock of this.allStocks) {
            // Update prices
            stock.ask_price = this.ns.stock.getAskPrice(stock.symbol);
            stock.bid_price = this.ns.stock.getBidPrice(stock.symbol);
            stock.spread = stock.ask_price - stock.bid_price;
            stock.spread_pct = stock.spread / stock.ask_price;
            stock.price = (stock.ask_price + stock.bid_price) / 2;

            // Update volatility and forecast if 4S data is available
            if (this.has4SData) {
                stock.forecast = this.ns.stock.getForecast(stock.symbol);
                stock.volatility = this.ns.stock.getVolatility(stock.symbol);
            } else {
                // Use our forecast helper if 4S data is not available
                stock.volatility = this.forecastHelper.estimateVolatility(stock.symbol, stock.priceHistory);
                // Forecast will be updated after price history is updated
            }

            // Update position
            const [sharesLong, avgPriceLong, sharesShort, avgPriceShort] = this.ns.stock.getPosition(stock.symbol);

            // Track previous position to detect changes
            const prevLong = stock.sharesLong;
            const prevShort = stock.sharesShort;

            // Update position
            stock.sharesLong = sharesLong;
            stock.boughtPrice = avgPriceLong;
            stock.sharesShort = sharesShort;
            stock.boughtPriceShort = avgPriceShort;

            // Calculate holdings value
            holdings += stock.positionValue();

            // Add to myStocks if owned
            if (stock.owned()) {
                this.myStocks.push(stock);
            } else {
                stock.ticksHeld = 0;
            }

            // Update price history and track ticks
            if (ticked) {
                // Update price history
                stock.priceHistory.unshift(stock.price);

                // Limit history length
                if (stock.priceHistory.length > this.config.pre4sParams.maxTickHistory) {
                    stock.priceHistory.splice(this.config.pre4sParams.maxTickHistory);
                }

                // Update ticks held
                if (stock.owned()) {
                    // Reset ticker counter if position type changed
                    const positionChanged = (prevLong > 0 && stock.sharesLong === 0) ||
                        (prevShort > 0 && stock.sharesShort === 0);
                    stock.ticksHeld = positionChanged ? 0 : stock.ticksHeld + 1;
                }
            }
        }

        // If the market ticked, update forecasts
        if (ticked) {
            await this.updateForecasts();
        }

        return holdings;
    }

    /**
     * Update forecasts for all stocks
     */
    private async updateForecasts(): Promise<void> {
        // If we have 4S data, we don't need to calculate forecast from price history
        if (this.has4SData) return;

        // Increment the detected cycle tick
        this.detectedCycleTick = (this.detectedCycleTick + 1) % this.config.pre4sParams.marketCycleLength;

        // Track inversions
        const inversionsDetected: Stock[] = [];

        // Update forecasts for all stocks
        for (const stock of this.allStocks) {
            // Skip if we don't have enough history
            if (stock.priceHistory.length < this.config.tradingParams.minTickHistory) {
                stock.forecast = this.forecastHelper.calculateForecast(stock.symbol);
                continue;
            }

            // Calculate near-term forecast using recent price history
            stock.nearTermForecast = this.forecastHelper.calculateHistoricalForecast(
                stock.priceHistory.slice(0, Math.min(this.config.pre4sParams.nearTermForecastWindow, stock.priceHistory.length))
            );

            // Calculate long-term forecast using all available history
            stock.longTermForecast = this.forecastHelper.calculateHistoricalForecast(
                stock.priceHistory.slice(0, Math.min(this.config.pre4sParams.longTermForecastWindow, stock.priceHistory.length))
            );

            // Check for inversion
            const preNearTermWindowProb = this.forecastHelper.calculateHistoricalForecast(
                stock.priceHistory.slice(
                    this.config.pre4sParams.nearTermForecastWindow,
                    this.config.pre4sParams.nearTermForecastWindow + this.config.pre4sParams.marketCycleLength
                )
            );

            // Detect inversion
            stock.possibleInversionDetected = this.detectInversion(preNearTermWindowProb, stock.nearTermForecast);

            if (stock.possibleInversionDetected) {
                inversionsDetected.push(stock);
            }

            // Increment last inversion counter or reset if inversion detected and trusted
            if (stock.possibleInversionDetected && this.isTrustedInversion()) {
                stock.lastInversion = 0;
            } else {
                stock.lastInversion++;
            }

            // Calculate final probability from long-term and near-term forecasts
            const probWindowLength = Math.min(this.config.pre4sParams.longTermForecastWindow, stock.lastInversion);
            stock.forecast = stock.nearTermForecast !== undefined
                ? (stock.longTermForecast || 0.5) * 0.6 + stock.nearTermForecast * 0.4
                : stock.longTermForecast || 0.5;

            // Calculate standard deviation for confidence
            stock.probStdDev = Math.sqrt((stock.forecast * (1 - stock.forecast)) / probWindowLength);

            // Update forecast based on our market influence
            if (stock.owned()) {
                const influence = this.config.tradingParams.transactionInfluenceFactor * stock.ownedShares();
                if (stock.sharesLong > 0) {
                    stock.forecast = Math.min(1, stock.forecast + influence);
                } else if (stock.sharesShort > 0) {
                    stock.forecast = Math.max(0, stock.forecast - influence);
                }
            }
        }

        // Adjust market cycle detection based on inversions
        if (inversionsDetected.length >= this.inversionAgreementThreshold &&
            (this.has4SData || this.allStocks[0].priceHistory.length >= this.config.pre4sParams.minTickHistory)) {

            const newPredictedCycleTick = this.has4SData ? 0 : this.config.pre4sParams.nearTermForecastWindow;

            if (this.detectedCycleTick !== newPredictedCycleTick) {
                this.log(`Market cycle detection adjustment: ${this.detectedCycleTick} -> ${newPredictedCycleTick}`);
            }

            this.marketCycleDetected = true;
            this.detectedCycleTick = newPredictedCycleTick;
            this.inversionAgreementThreshold = Math.max(14, inversionsDetected.length);
        }
    }

    /**
     * Detect if a probability inversion is trusted (based on timing in the cycle)
     */
    private isTrustedInversion(): boolean {
        if (this.has4SData && this.detectedCycleTick === 0) {
            return true;
        }

        if (!this.has4SData &&
            this.detectedCycleTick >= this.config.pre4sParams.nearTermForecastWindow / 2 &&
            this.detectedCycleTick <= this.config.pre4sParams.nearTermForecastWindow + this.config.pre4sParams.inversionLagTolerance) {
            return true;
        }

        return false;
    }

    /**
     * Detect if a probability inversion has occurred
     * @param p1 First probability
     * @param p2 Second probability
     * @returns Whether an inversion is detected
     */
    private detectInversion(p1: number, p2: number): boolean {
        const tol = this.config.pre4sParams.inversionDetectionTolerance;
        const tol2 = tol / 2;

        return ((p1 >= 0.5 + tol2) && (p2 <= 0.5 - tol2) && p2 <= (1 - p1) + tol) ||
            ((p1 <= 0.5 - tol2) && (p2 >= 0.5 + tol2) && p2 >= (1 - p1) - tol);
    }

    /**
     * Get the best stock trading opportunities
     * @returns Array of stocks sorted by opportunity
     */
    getTradeOpportunities(): Stock[] {
        const ownedStocks = this.myStocks;
        const potentialStocks = this.allStocks.filter(stock => !stock.owned());

        // Sort potential stocks by trading opportunity
        const sortedPotentialStocks = potentialStocks
            .filter(stock => {
                if (!this.isWorthBuying(stock)) {
                    return false;
                }

                const forecastThreshold = this.has4SData ? 0.54 : 0.58;
                const volatilityThreshold = this.has4SData ? 0.95 : 0.75;
                const { cycleProbability } = this.detectMarketCycle(stock);
                const liquidityFactor = stock.price * stock.maxShares > 1e10;

                if (this.config.hasShortSelling) {
                    return (
                        (stock.forecast > forecastThreshold && stock.volatility < volatilityThreshold) ||
                        (stock.forecast < (1 - forecastThreshold) && stock.volatility < volatilityThreshold)
                    ) && cycleProbability < 0.8 && liquidityFactor;
                } else {
                    return stock.forecast > forecastThreshold &&
                        stock.volatility < volatilityThreshold &&
                        cycleProbability < 0.8 &&
                        liquidityFactor;
                }
            })
            .sort(this.purchaseOrder);

        // Return owned stocks first, followed by potential stocks
        return [...ownedStocks, ...sortedPotentialStocks].slice(0, this.config.tradingParams.maxPositions);
    }

    /**
     * Check if a stock is worth buying based on commission and spread
     * @param stock Stock to check
     * @returns Whether it's worth buying
     */
    private isWorthBuying(stock: Stock): boolean {
        const playerMoney = this.ns.getPlayer().money;
        const commission = this.config.tradingParams.commission;
        const affordableShares = Math.min(
            stock.maxShares,
            Math.floor((playerMoney * 0.35) / stock.price)
        );
        const investment = affordableShares * stock.price;
        const commissionPercent = (commission * 2) / investment;

        return stock.forecast > 0.53 && (this.config.tradingParams.targetProfit > commissionPercent * 1.5);
    }

    /**
     * Sort function for purchasing order
     */
    private purchaseOrder = (a: Stock, b: Stock): number => {
        // Primary sort: time to cover the spread (lower is better)
        const timeDiff = Math.ceil(a.timeToCoverTheSpread()) - Math.ceil(b.timeToCoverTheSpread());
        if (timeDiff !== 0) return timeDiff;

        // Secondary sort: expected return (higher is better)
        return b.absReturn() - a.absReturn();
    };

    /**
     * Detect possible market cycle in a stock
     * @param stock Stock to analyze
     * @returns Cycle detection info
     */
    detectMarketCycle(stock: Stock): { isCycleEnd: boolean; cycleProbability: number } {
        if (!stock.priceHistory || stock.priceHistory.length < 5) {
            return { isCycleEnd: false, cycleProbability: 0 };
        }

        let priceDirectionChanges = 0;
        let lastDirection = 0;

        for (let i = 1; i < Math.min(5, stock.priceHistory.length); i++) {
            const priceDiff = stock.priceHistory[i - 1] - stock.priceHistory[i];
            const currentDirection = Math.sign(priceDiff);

            if (lastDirection !== 0 && currentDirection !== 0 && currentDirection !== lastDirection) {
                priceDirectionChanges++;
            }

            if (currentDirection !== 0) {
                lastDirection = currentDirection;
            }
        }

        const recentPriceChange = (stock.priceHistory[0] - stock.priceHistory[Math.min(3, stock.priceHistory.length - 1)]) /
            stock.priceHistory[Math.min(3, stock.priceHistory.length - 1)];

        const isCycleEnd = priceDirectionChanges >= 1 &&
            Math.abs(recentPriceChange) > this.config.tradingParams.cycleDetectionThreshold * 0.8;

        const cycleProbability = Math.min(1, (priceDirectionChanges / 3) +
            Math.abs(recentPriceChange) / 0.12);

        return { isCycleEnd, cycleProbability };
    }

    /**
     * Buy a stock position
     * @param stock Stock to buy
     * @param shares Number of shares to buy
     * @returns Cost of the purchase including commission
     */
    async buyStock(stock: Stock, shares: number): Promise<number> {
        const long = stock.bullish();
        const expectedPrice = long ? stock.ask_price : stock.bid_price;

        if (stock.owned()) {
            this.totalProfit -= this.config.tradingParams.commission;
        }

        this.log(`${long ? 'Buying  ' : 'Shorting'} ${shortNumber(shares).padStart(5)} ` +
            `(${stock.maxShares === shares + stock.ownedShares() ? '@max shares' :
                `${shortNumber(shares + stock.ownedShares()).padStart(5)}/${shortNumber(stock.maxShares).padStart(5)}`}) ` +
            `${stock.symbol.padEnd(5)} @ ${formatMoney(expectedPrice).padStart(9)} for ${formatMoney(shares * expectedPrice).padStart(9)} ` +
            `(Spread:${(stock.spread_pct * 100).toFixed(2)}% ER:${this.formatBasisPoints(stock.absReturn()).padStart(8)}) ` +
            `Ticks to Profit: ${stock.timeToCoverTheSpread().toFixed(2)}`, true);

        // Execute the buy transaction
        let price: number;
        if (long) {
            price = this.ns.stock.buyStock(stock.symbol, shares);
        } else if (this.config.hasShortSelling) {
            price = this.ns.stock.buyShort(stock.symbol, shares);
        } else {
            this.log(`ERROR: Tried to short ${stock.symbol} but shorting is disabled.`, true);
            return 0;
        }

        if (price === 0) {
            const playerMoney = this.ns.getPlayer().money;
            if (playerMoney < shares * expectedPrice) {
                this.log(`Failed to ${long ? 'buy' : 'short'} ${stock.symbol} because money just recently dropped to ` +
                    `${formatMoney(playerMoney)} and we can no longer afford it.`);
            } else {
                this.log(`ERROR: Failed to ${long ? 'buy' : 'short'} ${stock.symbol} @ ${formatMoney(expectedPrice)} ` +
                    `(0 was returned) despite having ${formatMoney(playerMoney)}.`, true);
            }
            return 0;
        }

        if (price !== expectedPrice) {
            this.log(`WARNING: ${long ? 'Bought' : 'Shorted'} ${stock.symbol} @ ${formatMoney(price)} but expected ` +
                `${formatMoney(expectedPrice)} (spread: ${formatMoney(stock.spread)})`, false);

            // Known BitBurner bug: short returns "price" instead of "bid_price"
            price = expectedPrice;
        }

        await this.ns.sleep(this.config.tradingParams.tradeCooldown);

        return shares * price + this.config.tradingParams.commission;
    }

    /**
     * Sell a stock position
     * @param stock Stock to sell
     * @param reason Reason for selling
     * @returns Revenue from the sale
     */
    async sellStock(stock: Stock, reason: string): Promise<number> {
        if (!stock.owned()) return 0;

        const long = stock.sharesLong > 0;
        const shares = long ? stock.sharesLong : stock.sharesShort;
        const expectedPrice = long ? stock.bid_price : stock.ask_price;

        if (long && stock.sharesShort > 0) {
            this.log(`ERROR: Somehow ended up both ${stock.sharesShort} short and ${stock.sharesLong} long on ${stock.symbol}`, true);
        }

        // Execute the sell transaction
        let price: number;
        if (long) {
            price = this.ns.stock.sellStock(stock.symbol, shares);
        } else if (this.config.hasShortSelling) {
            price = this.ns.stock.sellShort(stock.symbol, shares);
        } else {
            this.log(`ERROR: Tried to sell short position for ${stock.symbol} but shorting is disabled.`, true);
            return 0;
        }

        const profit = (long ?
            shares * (price - stock.boughtPrice) :
            shares * (stock.boughtPriceShort - price)) - 2 * this.config.tradingParams.commission;

        this.log(`${profit > 0 ? 'SUCCESS' : 'WARNING'}: Sold all ${shortNumber(shares).padStart(5)} ` +
            `${stock.symbol.padEnd(5)} ${long ? ' long' : 'short'} positions @ ${formatMoney(price).padStart(9)} ` +
            `for a ${profit > 0 ? `PROFIT of ${formatMoney(profit).padStart(9)}` : ` LOSS  of ${formatMoney(-profit).padStart(9)}`} ` +
            `after ${stock.ticksHeld} ticks - ${reason}`, true);

        if (price === 0) {
            this.log(`ERROR: Failed to sell ${shares} ${stock.symbol} ${long ? 'shares' : 'shorts'} @ ` +
                `${formatMoney(expectedPrice)} - 0 was returned.`, true);
            return 0;
        }

        if (price !== expectedPrice) {
            this.log(`WARNING: Sold ${stock.symbol} ${long ? 'shares' : 'shorts'} @ ${formatMoney(price)} ` +
                `but expected ${formatMoney(expectedPrice)} (spread: ${formatMoney(stock.spread)})`, false);

            // Known BitBurner bug: sellShort returns "price" instead of "ask_price"
            price = expectedPrice;
        }

        this.totalProfit += profit;

        await this.ns.sleep(this.config.tradingParams.tradeCooldown);

        return price * shares - this.config.tradingParams.commission;
    }

    /**
     * Calculate position size for a stock
     * @param stock Stock to buy
     * @param budget Available budget
     * @returns Number of shares to buy
     */
    calculatePositionSize(stock: Stock, budget: number): number {
        const isShort = this.config.hasShortSelling && stock.forecast < 0.5;
        const price = isShort ? stock.bid_price : stock.ask_price;

        // Get current portfolio metrics
        const totalPortfolioValue = this.getTotalPortfolioValue();
        const playerMoney = this.ns.getPlayer().money;
        const totalNetWorth = playerMoney + totalPortfolioValue;

        // Adjust position sizing based on net worth stage
        let portfolioPercent = this.config.tradingParams.portfolioLimit;
        if (totalNetWorth > 1e12) {
            portfolioPercent = 0.55;
        } else if (totalNetWorth > 1e9) {
            portfolioPercent = 0.50;
        }

        // Basic affordability calculation
        let affordableShares = Math.floor(
            (budget * portfolioPercent - this.config.tradingParams.commission) / price
        );
        affordableShares = Math.min(stock.maxShares - stock.ownedShares(), affordableShares);

        // Calculate forecast confidence
        const forecastDeviation = Math.abs(stock.forecast - 0.5);
        let confidence = Math.min(1, Math.max(0, forecastDeviation / 0.15));
        confidence = Math.pow(confidence, 1.1);

        // Apply various factors to position size
        const { cycleProbability } = this.detectMarketCycle(stock);
        const marketTimingFactor = 1 - (cycleProbability * 0.4);
        const volatilityFactor = Math.max(0.6, 1 - (stock.volatility / 0.6));
        const dataConfidence = this.has4SData ? 1.0 : 0.9;

        // Calculate spread as a percentage
        const spreadPercent = (stock.ask_price - stock.bid_price) / price;
        const spreadFactor = Math.max(0.8, 1 - (spreadPercent * 15));

        // Count existing positions for diversification
        const currentPositionCount = this.myStocks.length;
        const diversificationFactor = Math.max(
            0.6,
            1 - (currentPositionCount / this.config.tradingParams.maxPositions) * 0.4
        );

        // Final position size calculation with all factors
        let positionSize = Math.floor(
            affordableShares *
            confidence *
            volatilityFactor *
            dataConfidence *
            marketTimingFactor *
            spreadFactor *
            diversificationFactor
        );

        // Apply minimum transaction size
        if (positionSize > 0 && positionSize * price < this.config.tradingParams.minTransactionSize) {
            positionSize = Math.min(
                stock.maxShares - stock.ownedShares(),
                Math.floor(this.config.tradingParams.minTransactionSize / price)
            );
        }

        // Cap size based on stock liquidity
        const liquidityBasedMax = Math.floor(stock.maxShares * 0.25);
        positionSize = Math.min(positionSize, liquidityBasedMax);

        return positionSize;
    }

    /**
     * Get the total value of all stock positions
     * @returns Total portfolio value
     */
    getTotalPortfolioValue(): number {
        return this.myStocks.reduce((sum, stock) => sum + stock.positionValue(), 0);
    }

    /**
     * Format basis points for display
     * @param fraction Fraction to format
     * @returns Formatted string
     */
    formatBasisPoints(fraction: number): string {
        return (fraction * 100 * 100).toFixed(2) + ' BP';
    }

    /**
     * Logger function with deduplication
     * @param message Message to log
     * @param important Whether the message is important enough to tprint
     */
    private log(message: string, important: boolean = false): void {
        if (message === this.lastLog) return;

        this.ns.print(message);
        if (important) this.ns.tprint(message);

        this.lastLog = message;
    }
} 