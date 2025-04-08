import { NS } from '@ns';
import { StockConfig } from './stock_config';
import { StockMarket } from './stock_market';
import { Stock } from './stock';
import { formatMoney } from '../lib/utils';
import { Player } from '@ns';

/**
 * Manages stock trading operations and decision making
 */
export class StockTrader {
    private ns: NS;
    private config: StockConfig;
    private market: StockMarket;

    // Trading state
    private has4SData: boolean = false;
    private tradesMadeTick: number = 0;

    /**
     * Constructor
     * @param ns NetScript API
     * @param config Stock configuration
     * @param market Stock market manager
     */
    constructor(ns: NS, config: StockConfig, market: StockMarket) {
        this.ns = ns;
        this.config = config;
        this.market = market;
    }

    /**
     * Initialize the trader
     */
    async initialize(): Promise<void> {
        // Check for 4S data access
        this.has4SData = this.ns.stock.has4SData();
        this.tradesMadeTick = 0;
    }

    /**
     * Try to purchase stock market API access
     * @param playerMoney Available funds
     * @param reserve Amount to reserve
     * @returns Whether any API was purchased
     */
    async tryPurchaseAPIs(playerMoney: number, reserve: number = 0): Promise<boolean> {
        const availableMoney = playerMoney - reserve;
        let purchased = false;

        // WSE Account
        if (!this.ns.stock.hasWSEAccount() && availableMoney > this.config.apiOptions.wseAccountCost) {
            if (this.ns.stock.purchaseWseAccount()) {
                this.ns.print(`Purchased WSE account for ${formatMoney(this.config.apiOptions.wseAccountCost)}`);
                purchased = true;
            }
        }

        // TIX API
        if (this.ns.stock.hasWSEAccount() && !this.ns.stock.hasTIXAPIAccess() &&
            availableMoney > this.config.apiOptions.tixApiCost) {
            if (this.ns.stock.purchaseTixApi()) {
                this.ns.print(`Purchased TIX API for ${formatMoney(this.config.apiOptions.tixApiCost)}`);
                purchased = true;
            }
        }

        // 4S Market Data
        if (this.ns.stock.hasTIXAPIAccess() && !this.ns.stock.has4SData() &&
            availableMoney > this.config.apiOptions.marketDataCost) {
            if (this.ns.stock.purchase4SMarketData()) {
                this.ns.print(`Purchased 4S Market Data for ${formatMoney(this.config.apiOptions.marketDataCost)}`);
                this.has4SData = true;
                purchased = true;
            }
        }

        // 4S Market Data TIX API
        if (this.ns.stock.has4SData() && !this.ns.stock.has4SDataTIXAPI() &&
            availableMoney > this.config.apiOptions.marketDataTixApiCost) {
            if (this.ns.stock.purchase4SMarketDataTixApi()) {
                this.ns.print(`Purchased 4S Market Data TIX API for ${formatMoney(this.config.apiOptions.marketDataTixApiCost)}`);
                purchased = true;
            }
        }

        return purchased;
    }

    /**
     * Try to purchase 4S API access using portfolio value
     * @param playerStats Player stats
     * @param corpus Total value (money + stocks)
     * @param reserve Amount to reserve
     * @returns Whether 4S API was purchased
     */
    async tryGet4SApi(playerStats: Player, corpus: number, reserve: number = 0): Promise<boolean> {
        if (this.ns.stock.has4SDataTIXAPI()) return false;

        const has4S = this.ns.stock.has4SData();
        const cost4sData = this.config.apiOptions.marketDataCost;
        const cost4sApi = this.config.apiOptions.marketDataTixApiCost;
        const totalCost = (has4S ? 0 : cost4sData) + cost4sApi;

        // Check if we can afford it
        const budget = corpus * this.config.apiOptions.buy4sBudget - reserve;
        if (totalCost > budget) return false;

        // Check if we need to liquidate to afford it
        if (playerStats.money < totalCost) {
            await this.liquidatePositions();
        }

        // Try to purchase 4S data if needed
        if (!has4S) {
            if (this.ns.stock.purchase4SMarketData()) {
                this.ns.print(`Purchased 4S Market Data for ${formatMoney(cost4sData)}`);
                this.has4SData = true;
            } else {
                this.ns.print('ERROR attempting to purchase 4S Market Data!');
                return false;
            }
        }

        // Try to purchase 4S API
        if (this.ns.stock.purchase4SMarketDataTixApi()) {
            this.ns.print(`Purchased 4S Market Data TIX API for ${formatMoney(cost4sApi)}`);
            return true;
        } else {
            this.ns.print('ERROR attempting to purchase 4S Market Data TIX API!');
            return false;
        }
    }

    /**
     * Sell all stock positions
     * @returns Total revenue from liquidation
     */
    async liquidatePositions(): Promise<number> {
        let totalRevenue = 0;
        const myStocks = this.market.getTradeOpportunities().filter(stock => stock.owned());

        for (const stock of myStocks) {
            const revenue = await this.market.sellStock(stock, 'Liquidating positions');
            totalRevenue += revenue;
        }

        return totalRevenue;
    }

    /**
     * Manage existing positions (check for sell conditions)
     * @returns Number of positions sold
     */
    async managePositions(): Promise<number> {
        let sales = 0;

        // Threshold to sell depends on whether we have 4S data
        const thresholdToSell = this.config.getSellThreshold(this.has4SData);
        const pre4sMinHoldTime = this.config.pre4sParams.minimumHoldTime;

        for (const stock of this.market.getTradeOpportunities().filter(s => s.owned())) {
            if (this.shouldSellPosition(stock)) {
                // In pre-4S mode, enforce minimum hold time to avoid rash decisions
                if (!this.has4SData && stock.ticksHeld < pre4sMinHoldTime) {
                    if (!stock.warnedBadPurchase) {
                        this.ns.print(`WARNING: Thinking of selling ${stock.symbol} with ER ${this.market.formatBasisPoints(stock.absReturn())}, ` +
                            `but holding out as it was purchased just ${stock.ticksHeld} ticks ago...`);
                        stock.warnedBadPurchase = true;
                    }
                } else {
                    await this.market.sellStock(stock, this.getSellReason(stock));
                    sales++;
                    stock.warnedBadPurchase = false;
                }
            }
        }

        return sales;
    }

    /**
     * Check if a position should be sold
     * @param stock Stock to check
     * @returns Whether the position should be sold
     */
    private shouldSellPosition(stock: Stock): boolean {
        if (!stock.owned()) return false;

        // Get thresholds
        const sellThreshold = this.config.getSellThreshold(this.has4SData);

        // Check for position type mismatch (bullish but short, or bearish but long)
        if ((stock.bullish() && stock.sharesShort > 0) || (stock.bearish() && stock.sharesLong > 0)) {
            return true;
        }

        // Check for poor expected return
        if (stock.absReturn() <= sellThreshold) {
            return true;
        }

        // Check for sell indicators from position management
        return this.checkPositionManagement(stock);
    }

    /**
     * Check a position for more complex sell indicators
     * @param stock Stock to check
     * @returns Whether the stock should be sold
     */
    private checkPositionManagement(stock: Stock): boolean {
        if (!stock.purchasePrice) return false;

        const currentPrice = stock.isShort ? stock.ask_price : stock.bid_price;
        const profit = stock.isShort ?
            (stock.purchasePrice - currentPrice) / stock.purchasePrice :
            (currentPrice - stock.purchasePrice) / stock.purchasePrice;

        // Update high price for trailing stop
        if (!stock.isShort && currentPrice > (stock.highPrice || 0)) {
            stock.highPrice = currentPrice;
        } else if (stock.isShort && currentPrice < (stock.highPrice || currentPrice)) {
            stock.highPrice = currentPrice;
        }

        // Store the initial forecast for comparison if not already set
        if (!stock.initialForecast) {
            stock.initialForecast = stock.forecast;
        }

        // Check for market cycle reversal
        const { isCycleEnd, cycleProbability } = this.market.detectMarketCycle(stock);

        // Dynamic trailing stop that tightens as profit increases
        let trailingStopPercent: number;
        if (profit < 0.02) {
            trailingStopPercent = 0.025 * (1 + stock.volatility);
        } else if (profit < 0.05) {
            trailingStopPercent = 0.02 * (1 + 0.5 * stock.volatility);
        } else {
            trailingStopPercent = 0.015 * (1 + 0.25 * stock.volatility);
        }

        // Check trailing stop - more aggressive if at potential cycle end
        const adjustedTrailingStop = isCycleEnd ? trailingStopPercent * 0.5 : trailingStopPercent;

        // Check if trailing stop is triggered
        if (!stock.isShort && stock.highPrice && currentPrice < stock.highPrice * (1 - adjustedTrailingStop)) {
            return true;
        } else if (stock.isShort && stock.highPrice && currentPrice > stock.highPrice * (1 + adjustedTrailingStop)) {
            return true;
        }

        // Dynamic profit target based on multiple factors
        const forecastStrength = Math.abs(stock.forecast - 0.5);
        const cycleFactor = isCycleEnd ? 0.8 : 1.0;
        const volatilityFactor = 1 - (stock.volatility * 0.5);
        const timeHeldFactor = Math.min(1.5, 1 + ((stock.ticksHeld || 0) / 25) * 0.5);

        const dynamicTargetProfit = this.config.tradingParams.targetProfit *
            forecastStrength * 2 * cycleFactor * volatilityFactor * timeHeldFactor;

        // Minimum hold time adjustment
        const effectiveMinHoldTime = Math.max(1, this.config.tradingParams.minHoldTime -
            (stock.volatility > 0.05 ? 1 : 0) -
            (forecastStrength > 0.25 ? 1 : 0));

        const shouldConsiderSelling = (stock.ticksHeld || 0) >= effectiveMinHoldTime;

        // Take profit condition
        if (profit >= dynamicTargetProfit && shouldConsiderSelling) {
            return true;
        }

        // Dynamic stop loss
        const dynamicStopLoss = this.config.tradingParams.stopLoss * (1 + stock.volatility * 0.5);

        // Stop loss - don't wait for minimum hold time for stop loss
        if (profit <= -dynamicStopLoss) {
            return true;
        }

        // Check for forecast deterioration
        const forecastThreshold = this.has4SData ? 0.54 : 0.52;
        const forecastChangeFromInitial = Math.abs(stock.forecast - (stock.initialForecast || 0.5));

        const forecastChanged = (
            (stock.isShort && stock.forecast > (1 - forecastThreshold)) ||
            (!stock.isShort && stock.forecast < forecastThreshold)
        ) && forecastChangeFromInitial > this.config.tradingParams.forecastChangeThreshold;

        // Exit on forecast change if we've held long enough
        if (forecastChanged && shouldConsiderSelling) {
            return true;
        }

        // Exit on high probability of market cycle reversal if profitable
        if (isCycleEnd && cycleProbability > 0.8 && profit > 0.02 && shouldConsiderSelling) {
            return true;
        }

        return false;
    }

    /**
     * Get the reason for selling a position
     * @param stock Stock being sold
     * @returns Human-readable reason
     */
    private getSellReason(stock: Stock): string {
        if ((stock.bullish() && stock.sharesShort > 0) || (stock.bearish() && stock.sharesLong > 0)) {
            return 'Position type mismatch';
        }

        if (stock.absReturn() <= this.config.getSellThreshold(this.has4SData)) {
            return 'Low expected return';
        }

        const currentPrice = stock.isShort ? stock.ask_price : stock.bid_price;

        if (!stock.isShort && stock.highPrice &&
            currentPrice < stock.highPrice * (1 - 0.02 * (1 + stock.volatility))) {
            return 'Trailing stop triggered';
        }

        if (stock.isShort && stock.highPrice &&
            currentPrice > stock.highPrice * (1 + 0.02 * (1 + stock.volatility))) {
            return 'Trailing stop triggered';
        }

        if (!stock.purchasePrice) return 'No purchase price available';
        const profit = stock.isShort ?
            (stock.purchasePrice - currentPrice) / stock.purchasePrice :
            (currentPrice - stock.purchasePrice) / stock.purchasePrice;

        if (profit >= this.config.tradingParams.targetProfit) {
            return 'Target profit reached';
        }

        if (profit <= -this.config.tradingParams.stopLoss) {
            return 'Stop loss triggered';
        }

        const { isCycleEnd, cycleProbability } = this.market.detectMarketCycle(stock);
        if (isCycleEnd && cycleProbability > 0.8) {
            return 'Market cycle reversal detected';
        }

        const forecastThreshold = this.has4SData ? 0.54 : 0.52;
        const forecastChangeFromInitial = Math.abs(stock.forecast - (stock.initialForecast || 0.5));

        if (forecastChangeFromInitial > this.config.tradingParams.forecastChangeThreshold) {
            return 'Forecast changed direction';
        }

        return 'Multiple factors';
    }

    /**
     * Find and execute buy opportunities
     * @param playerMoney Available funds
     * @param portfolioValue Total value of current stock holdings
     * @param reserve Amount to reserve
     * @returns Number of trades made
     */
    async executeBuyOpportunities(playerMoney: number, portfolioValue: number, reserve: number = 0): Promise<number> {
        // Reset trades counter if we've hit the max
        if (this.tradesMadeTick >= this.config.tradingParams.maxTradesPerTick) {
            return 0;
        }

        // Calculate corpus and available budget
        const corpus = playerMoney + portfolioValue;
        const maxHoldings = (1 - this.config.tradingParams.cashReserveFactor) * corpus;
        let availableBudget = Math.min(
            playerMoney - reserve,
            maxHoldings - portfolioValue
        );

        // Check if we have enough liquidity
        if (playerMoney / corpus <= this.config.tradingParams.cashReserveFactor) {
            return 0;
        }

        let tradesMade = 0;

        // Get opportunities and execute trades
        const opportunities = this.market.getTradeOpportunities()
            .filter(stock => !stock.owned())
            .slice(0, this.config.tradingParams.maxPositions);

        for (const stock of opportunities) {
            if (tradesMade + this.tradesMadeTick >= this.config.tradingParams.maxTradesPerTick) {
                break;
            }

            // Skip if below buy threshold
            const buyThreshold = this.config.getBuyThreshold(this.has4SData);
            if (stock.absReturn() <= buyThreshold) {
                continue;
            }

            // Skip if disabling shorts and the stock is bearish
            if (!this.config.hasShortSelling && stock.bearish()) {
                continue;
            }

            // If pre-4s, do additional checks
            if (!this.has4SData) {
                // Skip if not enough history or probability is too close to 0.5
                if (stock.priceHistory.length < this.config.pre4sParams.minTickHistory ||
                    Math.abs(stock.forecast - 0.5) < this.config.pre4sParams.buyThresholdProbability) {
                    continue;
                }

                // Skip if inversion was too recent
                if (stock.lastInversion < this.config.pre4sParams.minTickHistory) {
                    continue;
                }
            }

            // Calculate position size
            const positionSize = this.market.calculatePositionSize(stock, availableBudget);

            // Skip if position size is too small
            if (positionSize <= 0) {
                continue;
            }

            // Execute the trade
            const cost = await this.market.buyStock(stock, positionSize);

            if (cost > 0) {
                tradesMade++;
                availableBudget -= cost;
            }
        }

        this.tradesMadeTick += tradesMade;
        return tradesMade;
    }
} 