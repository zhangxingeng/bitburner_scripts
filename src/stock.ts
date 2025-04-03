import { NS } from '@ns';
import { formatMoney } from './utils';

// =============================================
// INTERFACES & TYPES
// =============================================

/**
 * Stock interface representing a single stock with all its properties
 */
interface Stock {
    symbol: string;
    price: number;
    forecast: number;
    volatility: number;
    shares: number;
    highPrice: number;
    purchasePrice?: number;
    ticksHeld?: number;
    sharesShort?: number;
    isShort?: boolean;
    totalCost?: number;
    initialForecast?: number;
    priceHistory: number[];
    nearTermForecast?: number;
    longTermForecast?: number;
    lastInversion?: number;
}

/**
 * Type for storing stock price history between script runs
 */
interface StockHistoryData {
    [symbol: string]: {
        priceHistory: number[];
    };
}

// Make TypeScript aware of our "global" variable
declare global {
    // eslint-disable-next-line no-var
    var stocksData: StockHistoryData | undefined;
}

// =============================================
// CONSTANTS & CONFIGURATION
// =============================================

// Core trading parameters
const MIN_HOLD_TIME = 4;
const TARGET_PROFIT = 0.05;
const STOP_LOSS = 0.03;
const MAX_POSITIONS = 20;
const PORTFOLIO_LIMIT = 0.45;
const COMMISSION = 100000;
const MAX_TRADES_PER_TICK = 30;
const TRADE_COOLDOWN = 100;
const FORECAST_CHANGE_THRESHOLD = 0.015;
const DIVERSIFICATION_FACTOR = 0.6;
const MIN_TICK_HISTORY = 5;
const CASH_RESERVE_FACTOR = 0.10;
const TRANSACTION_INFLUENCE_FACTOR = 0.00008;
const MIN_TRANSACTION_SIZE = 5e5;
const CYCLE_DETECTION_THRESHOLD = 0.03;

// =============================================
// GLOBALS
// =============================================

// Feature flags
let has4SData = false;
const hasShortSelling = false;

// Initialize global stock history storage if needed
if (!globalThis.stocksData) {
    globalThis.stocksData = {};
}


// Function to purchase APIs if we have enough money
async function tryPurchaseAPIs(ns: NS): Promise<void> {
    const money = ns.getPlayer().money;
    if (!ns.stock.hasWSEAccount() && money > 2e9) {
        ns.stock.purchaseWseAccount();
    }
    if (!ns.stock.hasTIXAPIAccess() && money > 5e9) {
        ns.stock.purchaseTixApi();
    }
    if (ns.stock.hasTIXAPIAccess() && !ns.stock.has4SData() && money > 1e10) {
        ns.stock.purchase4SMarketData();
    }
    if (ns.stock.has4SData() && !ns.stock.has4SDataTIXAPI() && money > 2.5e10) {
        ns.stock.purchase4SMarketDataTixApi();
    }
}

// Calculate forecast from price history
function calculateHistoricalForecast(priceHistory: number[]): number {
    if (!priceHistory || priceHistory.length < 2) return 0.5;

    let increases = 0;
    for (let i = 0; i < priceHistory.length - 1; i++) {
        if (priceHistory[i] > priceHistory[i + 1]) {
            increases++;
        }
    }

    return increases / (priceHistory.length - 1);
}

// Enhanced forecast estimation when 4S data is not available
function _calculateForecast(ns: NS, symbol: string, priceHistory: number[] = []): number {
    try {
        if (priceHistory && priceHistory.length >= MIN_TICK_HISTORY) {
            return calculateHistoricalForecast(priceHistory);
        }
        const price = ns.stock.getPrice(symbol);
        const askPrice = ns.stock.getAskPrice(symbol);
        const bidPrice = ns.stock.getBidPrice(symbol);
        const spread = (askPrice - bidPrice) / price;

        let forecast = 0.5;
        forecast += (0.01 - spread) * 2;
        forecast += (Math.random() - 0.5) * 0.05;

        return Math.min(0.6, Math.max(0.4, forecast));
    } catch {
        return Math.random() * 0.2 + 0.4;
    }
}

// =============================================
// MAIN FUNCTION & PRIMARY LOGIC
// =============================================

/**
 * Main entry point for the stock trading script.
 * Attempts to purchase APIs, then enters main trading loop
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();
    ns.clearLog();

    await tryPurchaseAPIs(ns);
    has4SData = ns.stock.has4SData();

    // Main trading loop
    for (let tick = 1; ; tick++) {
        try {
            await _scanAndUpdateStocks(ns);
            await _executeTrades(ns);

            // Display simple status
            const portfolioValue = getTotalPortfolioValue(ns);
            ns.print(`Portfolio: ${formatMoney(portfolioValue)}, Cash: ${formatMoney(ns.getPlayer().money)}`);

            await ns.sleep(1000);
        } catch (error) {
            ns.print(`ERROR: ${String(error)}`);
            await ns.sleep(5000);
        }
    }
}

/**
 * Scans the market to update stock data and forecasts, preserving
 * price history between ticks.
 */
async function _scanAndUpdateStocks(ns: NS): Promise<void> {
    const stocks = await _getStockData(ns);

    // Save price history to global storage for future ticks
    for (const stock of stocks) {
        if (!globalThis.stocksData![stock.symbol]) {
            globalThis.stocksData![stock.symbol] = { priceHistory: [] };
        }
        globalThis.stocksData![stock.symbol].priceHistory = stock.priceHistory;
    }

    _updateHistoricalForecasts(stocks);
    _updateForecastsFromTransactions(stocks);
}

/**
 * Analyzes trading opportunities and executes buy/sell decisions
 */
async function _executeTrades(ns: NS): Promise<void> {
    const stocks = await _getStockData(ns);
    const opportunities = _getTopOpportunities(ns, stocks);
    const budget = ns.getPlayer().money - calculateReserve(ns);
    let tradesThisTick = 0;

    for (const stock of opportunities) {
        if (tradesThisTick >= MAX_TRADES_PER_TICK) break;

        if (stock.shares > 0) {
            await _managePosition(ns, stock);
        } else if (budget > COMMISSION * 2) {
            tradesThisTick = await _executeTrade(ns, stock, budget, tradesThisTick);
        }
    }
}


function calculateReserve(ns: NS): number {
    const totalNetWorth = ns.getPlayer().money + getTotalPortfolioValue(ns);
    return Math.max(1e9, totalNetWorth * CASH_RESERVE_FACTOR);
}

function getTotalPortfolioValue(ns: NS): number {
    let totalValue = 0;
    try {
        const symbols = ns.stock.getSymbols();
        for (const symbol of symbols) {
            const [shares, avgPrice] = ns.stock.getPosition(symbol);
            if (shares > 0) {
                totalValue += shares * ns.stock.getBidPrice(symbol);
            }

            if (hasShortSelling) {
                const [, , sharesShort, avgPriceShort] = ns.stock.getPosition(symbol);
                if (sharesShort > 0) {
                    totalValue += sharesShort * (2 * avgPriceShort - ns.stock.getAskPrice(symbol));
                }
            }
        }
    } catch (e) {
        // Ignore errors
    }
    return totalValue;
}

// =============================================
// STOCK DATA RETRIEVAL
// =============================================

/**
 * Gets data for all stocks in the market
 */
async function _getStockData(ns: NS): Promise<Stock[]> {
    const symbols = await _getStockSymbols(ns);
    const stockPromises = symbols.map(symbol => _getSingleStockData(ns, symbol));
    return Promise.all(stockPromises);
}

/**
 * Gets data for a single stock, including current price, 
 * forecast, volatility, and existing position details
 */
async function _getSingleStockData(ns: NS, symbol: string): Promise<Stock> {
    const [longShares, longPrice, shortShares, shortPrice] = ns.stock.getPosition(symbol);
    const price = ns.stock.getPrice(symbol);

    // Look up existing price history
    const existingStockData = globalThis.stocksData?.[symbol];
    let priceHistory: number[] = [];

    if (existingStockData?.priceHistory) {
        priceHistory = [...existingStockData.priceHistory];
        // Add current price to the history
        priceHistory.unshift(price);
        // Limit history length
        if (priceHistory.length > 151) {
            priceHistory.splice(151);
        }
    } else {
        priceHistory = [price];
    }

    // Create the stock object with basic properties
    const stock: Stock = {
        symbol,
        price,
        shares: longShares,
        highPrice: price,
        sharesShort: shortShares,
        isShort: false,
        priceHistory,
        lastInversion: 0,
        forecast: has4SData ?
            ns.stock.getForecast(symbol) :
            _calculateForecast(ns, symbol, priceHistory),
        volatility: has4SData ?
            ns.stock.getVolatility(symbol) :
            _estimateVolatility(ns, symbol, priceHistory)
    };

    if (longShares > 0) {
        stock.purchasePrice = longPrice;
        stock.ticksHeld = stock.ticksHeld || MIN_HOLD_TIME;
        stock.totalCost = longShares * longPrice + COMMISSION;
    } else if (hasShortSelling && shortShares > 0) {
        stock.shares = shortShares;
        stock.isShort = true;
        stock.purchasePrice = shortPrice;
        stock.ticksHeld = stock.ticksHeld || MIN_HOLD_TIME;
        stock.totalCost = shortShares * shortPrice + COMMISSION;
    }

    return stock;
}

/**
 * Gets a list of all stock symbols
 */
const _getStockSymbols = async (ns: NS): Promise<string[]> => {
    try { return ns.stock.getSymbols(); } catch { return []; }
};

// =============================================
// POSITION MANAGEMENT
// =============================================

/**
 * Manages existing positions - checks stops, targets, and updates
 * trailing stops as prices change
 */
async function _managePosition(ns: NS, stock: Stock): Promise<void> {
    try {
        if (!stock.purchasePrice) return;
        if (!stock.shares || stock.shares <= 0) return;

        const currentPrice = stock.isShort ? ns.stock.getAskPrice(stock.symbol) : ns.stock.getBidPrice(stock.symbol);
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
        const { isCycleEnd, cycleProbability } = detectMarketCycle(stock);

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

        if (!stock.isShort && stock.highPrice && currentPrice < stock.highPrice * (1 - adjustedTrailingStop)) {
            await _sellPosition(ns, stock, 'Trailing stop triggered');
            return;
        } else if (stock.isShort && stock.highPrice && currentPrice > stock.highPrice * (1 + adjustedTrailingStop)) {
            await _sellPosition(ns, stock, 'Trailing stop triggered');
            return;
        }

        // Dynamic profit target based on multiple factors
        const forecastStrength = Math.abs(stock.forecast - 0.5);
        const cycleFactor = isCycleEnd ? 0.8 : 1.0;
        const volatilityFactor = 1 - (stock.volatility * 0.5);
        const timeHeldFactor = Math.min(1.5, 1 + ((stock.ticksHeld || 0) / 25) * 0.5);

        const dynamicTargetProfit = TARGET_PROFIT * forecastStrength * 2 * cycleFactor * volatilityFactor * timeHeldFactor;

        // Minimum hold time adjustment
        const effectiveMinHoldTime = Math.max(1, MIN_HOLD_TIME -
            (stock.volatility > 0.05 ? 1 : 0) -
            (forecastStrength > 0.25 ? 1 : 0));

        const shouldConsiderSelling = (stock.ticksHeld || 0) >= effectiveMinHoldTime;

        // Take profit
        if (profit >= dynamicTargetProfit && shouldConsiderSelling) {
            await _sellPosition(ns, stock, 'Target profit reached');
            return;
        }

        // Dynamic stop loss
        const dynamicStopLoss = STOP_LOSS * (1 + stock.volatility * 0.5);

        // Stop loss - don't wait for minimum hold time for stop loss
        if (profit <= -dynamicStopLoss) {
            await _sellPosition(ns, stock, 'Stop loss triggered');
            return;
        }

        // Check for forecast deterioration
        const forecastThreshold = has4SData ? 0.54 : 0.52;
        const forecastChangeFromInitial = Math.abs(stock.forecast - (stock.initialForecast || 0.5));

        const forecastChanged = (
            (stock.isShort && stock.forecast > (1 - forecastThreshold)) ||
            (!stock.isShort && stock.forecast < forecastThreshold)
        ) && forecastChangeFromInitial > FORECAST_CHANGE_THRESHOLD;

        // Exit on forecast change if we've held long enough
        if (forecastChanged && shouldConsiderSelling) {
            await _sellPosition(ns, stock, 'Forecast changed direction');
            return;
        }

        // Exit on high probability of market cycle reversal if profitable
        if (isCycleEnd && cycleProbability > 0.8 && profit > 0.02 && shouldConsiderSelling) {
            await _sellPosition(ns, stock, 'Market cycle reversal detected');
            return;
        }
    } catch (e) {
        ns.print(`Error managing position for ${stock.symbol}: ${e}`);
    }
}

/**
 * Sells a stock position - handles both long and short positions
 */
async function _sellPosition(ns: NS, stock: Stock, reason: string): Promise<void> {
    try {
        if (!stock.shares || stock.shares <= 0) return;

        // Save stock details before selling
        const shares = stock.shares;
        const symbol = stock.symbol;
        const isShort = stock.isShort || false;
        const purchasePrice = stock.purchasePrice || 0;

        // Execute the sell transaction
        let salePricePerShare = 0;
        try {
            if (isShort) {
                salePricePerShare = ns.stock.sellShort(symbol, shares);
            } else {
                salePricePerShare = ns.stock.sellStock(symbol, shares);
            }
        } catch (sellError) {
            ns.print(`ERROR selling ${symbol}: ${sellError}`);
            return;
        }

        if (salePricePerShare > 0) {
            ns.print(`Sold ${shares} ${symbol} @ ${formatMoney(salePricePerShare)} - ${reason}`);
        }

        // Reset stock state
        stock.shares = 0;
        stock.purchasePrice = undefined;
        stock.totalCost = undefined;
        stock.ticksHeld = 0;
        stock.isShort = false;
        stock.initialForecast = undefined;
    } catch (e) {
        ns.print(`ERROR selling ${stock.symbol}: ${e}`);

        // Reset the stock state as a last resort
        stock.shares = 0;
        stock.purchasePrice = undefined;
        stock.totalCost = undefined;
        stock.ticksHeld = 0;
        stock.isShort = false;
        stock.initialForecast = undefined;
    }
}

function detectMarketCycle(stock: Stock): { isCycleEnd: boolean; cycleProbability: number } {
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

    const recentPriceChange = (stock.priceHistory[0] - stock.priceHistory[Math.min(3, stock.priceHistory.length - 1)])
        / stock.priceHistory[Math.min(3, stock.priceHistory.length - 1)];

    const isCycleEnd = priceDirectionChanges >= 1 && Math.abs(recentPriceChange) > CYCLE_DETECTION_THRESHOLD * 0.8;
    const cycleProbability = Math.min(1, (priceDirectionChanges / 3) + Math.abs(recentPriceChange) / 0.12);

    return { isCycleEnd, cycleProbability };
}

/**
 * Executes a buy trade for a stock based on calculated position size
 */
async function _executeTrade(ns: NS, stock: Stock, budget: number, tradesThisTick: number): Promise<number> {
    if (tradesThisTick >= MAX_TRADES_PER_TICK) {
        return tradesThisTick;
    }

    await ns.sleep(TRADE_COOLDOWN);

    const shouldShort = hasShortSelling && stock.forecast < 0.47;
    const newTradesThisTick = tradesThisTick + 1;

    const price = shouldShort ? ns.stock.getBidPrice(stock.symbol) : ns.stock.getAskPrice(stock.symbol);
    const maxShares = ns.stock.getMaxShares(stock.symbol) - stock.shares;
    const positionSize = _calculatePositionSize(ns, stock, budget, maxShares);

    if (positionSize > 0) {
        try {
            let cost;
            if (shouldShort) {
                cost = ns.stock.buyShort(stock.symbol, positionSize);
                stock.isShort = true;
            } else {
                cost = ns.stock.buyStock(stock.symbol, positionSize);
                stock.isShort = false;
            }

            if (cost > 0) {
                stock.totalCost = (stock.totalCost || 0) + cost + COMMISSION;
                if (stock.shares > 0) {
                    const totalShares = stock.shares + positionSize;
                    const totalCost = (stock.purchasePrice || 0) * stock.shares + cost;
                    stock.purchasePrice = totalCost / totalShares;
                } else {
                    stock.purchasePrice = price;
                }
                stock.shares += positionSize;
                stock.highPrice = price;
                stock.ticksHeld = 0;

                ns.print(`${shouldShort ? 'Shorted' : 'Bought'} ${positionSize} ${stock.symbol} @ ${formatMoney(price)}`);
            }
        } catch (e) {
            ns.print(`Error ${shouldShort ? 'shorting' : 'buying'} ${stock.symbol}: ${e}`);
        }
    }

    return newTradesThisTick;
}

/**
 * Calculates the optimal position size for a stock based on multiple factors
 */
function _calculatePositionSize(ns: NS, stock: Stock, budget: number, maxShares: number): number {
    const isShort = hasShortSelling && stock.forecast < 0.5;
    const price = isShort ? ns.stock.getBidPrice(stock.symbol) : ns.stock.getAskPrice(stock.symbol);

    // Get current portfolio metrics
    const totalPortfolioValue = getTotalPortfolioValue(ns);
    const playerMoney = ns.getPlayer().money;
    const totalNetWorth = playerMoney + totalPortfolioValue;

    // Adjust position sizing based on net worth stage
    let portfolioPercent = PORTFOLIO_LIMIT;
    if (totalNetWorth > 1e12) {
        portfolioPercent = 0.55;
    } else if (totalNetWorth > 1e9) {
        portfolioPercent = 0.50;
    }

    // Basic affordability calculation
    let affordableShares = Math.floor((budget * portfolioPercent - COMMISSION) / price);
    affordableShares = Math.min(maxShares, affordableShares);

    // Calculate forecast confidence 
    const forecastDeviation = Math.abs(stock.forecast - 0.5);
    let confidence = Math.min(1, Math.max(0, forecastDeviation / 0.15));
    confidence = Math.pow(confidence, 1.1);

    // Apply various factors to position size
    const { cycleProbability } = detectMarketCycle(stock);
    const marketTimingFactor = 1 - (cycleProbability * 0.4);
    const volatilityFactor = Math.max(0.6, 1 - (stock.volatility / 0.6));
    const dataConfidence = has4SData ? 1.0 : 0.9;

    // Calculate spread as a percentage 
    const spreadPercent = (ns.stock.getAskPrice(stock.symbol) - ns.stock.getBidPrice(stock.symbol)) / price;
    const spreadFactor = Math.max(0.8, 1 - (spreadPercent * 15));

    // Count existing positions for diversification
    const currentPositionCount = ns.stock.getSymbols().filter(sym => {
        const [longShares, , shortShares] = ns.stock.getPosition(sym);
        return longShares > 0 || shortShares > 0;
    }).length;

    const diversificationFactor = Math.max(0.6, 1 - (currentPositionCount / MAX_POSITIONS) * 0.4);

    // Final position size calculation with all factors
    let positionSize = Math.floor(affordableShares *
        confidence *
        volatilityFactor *
        dataConfidence *
        marketTimingFactor *
        spreadFactor *
        diversificationFactor);

    // Apply minimum transaction size
    if (positionSize > 0 && positionSize * price < MIN_TRANSACTION_SIZE) {
        positionSize = Math.min(maxShares, Math.floor(MIN_TRANSACTION_SIZE / price));
    }

    // Cap size based on stock liquidity
    const maxStockShares = ns.stock.getMaxShares(stock.symbol);
    const liquidityBasedMax = Math.floor(maxStockShares * 0.25);
    positionSize = Math.min(positionSize, liquidityBasedMax);

    return positionSize;
}

/**
 * Identifies and ranks trading opportunities based on forecast, volatility, and other factors
 */
function _getTopOpportunities(ns: NS, stocks: Stock[]): Stock[] {
    const ownedStocks = stocks.filter(stock => stock.shares > 0);
    const potentialStocks = stocks.filter(stock => stock.shares === 0);

    const sortedPotentialStocks = potentialStocks
        .filter(stock => {
            if (!_isWorthBuying(ns, stock.symbol, stock.forecast, ns.getPlayer().money)) {
                return false;
            }

            const forecastThreshold = has4SData ? 0.54 : 0.58;
            const volatilityThreshold = has4SData ? 0.95 : 0.75;
            const { cycleProbability } = detectMarketCycle(stock);
            const liquidityFactor = stock.price * ns.stock.getMaxShares(stock.symbol) > 1e10;

            if (hasShortSelling) {
                return (
                    (stock.forecast > forecastThreshold && stock.volatility < volatilityThreshold) ||
                    (stock.forecast < (1 - forecastThreshold) && stock.volatility < volatilityThreshold)
                ) &&
                    cycleProbability < 0.8 &&
                    liquidityFactor;
            } else {
                return stock.forecast > forecastThreshold &&
                    stock.volatility < volatilityThreshold &&
                    cycleProbability < 0.8 &&
                    liquidityFactor;
            }
        })
        .sort((a, b) => {
            // Multi-factor scoring model
            const getScore = (stock: Stock): number => {
                const forecastScore = Math.pow(Math.abs(stock.forecast - 0.5) * 2, 1.5);
                const volatilityScore = 1 - Math.abs(stock.volatility - 0.04) / 0.1;
                const momentum = stock.priceHistory && stock.priceHistory.length >= 3
                    ? (stock.priceHistory[0] / stock.priceHistory[2] - 1) : 0;
                const momentumScore = Math.sign(stock.forecast - 0.5) === Math.sign(momentum) ? 1.2 : 0.8;
                const sizeScore = Math.min(1, Math.log10(stock.price * ns.stock.getMaxShares(stock.symbol)) / 12);

                return forecastScore * 0.5 +
                    volatilityScore * 0.2 +
                    momentumScore * 0.2 +
                    sizeScore * 0.1;
            };

            return getScore(b) - getScore(a);
        });

    return [...ownedStocks, ...sortedPotentialStocks].slice(0, MAX_POSITIONS);
}

// =============================================
// MARKET ANALYSIS & FORECASTING
// =============================================

/**
 * Updates forecast values based on historical price data
 */
function _updateHistoricalForecasts(stocks: Stock[]): void {
    for (const stock of stocks) {
        if (stock.priceHistory && stock.priceHistory.length >= MIN_TICK_HISTORY) {
            // Calculate long-term forecast using full history
            stock.longTermForecast = calculateHistoricalForecast(stock.priceHistory);

            // Calculate near-term forecast using recent history only
            stock.nearTermForecast = calculateHistoricalForecast(
                stock.priceHistory.slice(0, Math.min(10, stock.priceHistory.length))
            );

            // Combined forecast with more weight on recent price action
            stock.forecast = stock.nearTermForecast ?
                (stock.longTermForecast * 0.6) + (stock.nearTermForecast * 0.4) :
                stock.longTermForecast || 0.5;
        }
    }
}

/**
 * Updates forecasts based on our market influence from transactions
 */
function _updateForecastsFromTransactions(stocks: Stock[]): void {
    for (const stock of stocks) {
        if (stock.shares > 0) {
            const influence = TRANSACTION_INFLUENCE_FACTOR * stock.shares;
            stock.forecast = Math.min(1, (stock.forecast || 0.5) + influence);
        } else if (stock.sharesShort && stock.sharesShort > 0) {
            const influence = TRANSACTION_INFLUENCE_FACTOR * stock.sharesShort;
            stock.forecast = Math.max(0, (stock.forecast || 0.5) - influence);
        }
    }
}

/**
 * Estimates volatility using historical price data or spread
 */
function _estimateVolatility(ns: NS, symbol: string, priceHistory?: number[]): number {
    try {
        // If we have enough price history data, calculate historical volatility
        if (priceHistory && priceHistory.length > 5) {
            return _computeHistoricalVolatility(priceHistory);
        }

        // Fallback to bid-ask spread estimation
        const price = ns.stock.getPrice(symbol);
        const askPrice = ns.stock.getAskPrice(symbol);
        const bidPrice = ns.stock.getBidPrice(symbol);
        const spread = (askPrice - bidPrice) / price;

        // Wider spreads generally indicate higher volatility
        const spreadVolatility = Math.min(0.5, Math.max(0.001, spread * 10));

        // Return estimated volatility with some randomness
        return spreadVolatility * (0.8 + Math.random() * 0.4);
    } catch {
        return 0.05; // Fallback to moderate volatility
    }
}

/**
 * Calculates historical volatility using standard deviation of log returns
 */
function _computeHistoricalVolatility(priceHistory: number[]): number {
    if (priceHistory.length < 3) return 0.05;

    // Calculate log returns
    const logReturns = [];
    for (let i = 1; i < priceHistory.length; i++) {
        if (priceHistory[i] === 0 || priceHistory[i - 1] === 0) continue;
        const ret = Math.log(priceHistory[i] / priceHistory[i - 1]);
        logReturns.push(ret);
    }

    if (logReturns.length === 0) return 0.05;

    // Calculate average (mean) of log returns
    const avg = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;

    // Calculate variance
    const variance = logReturns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / logReturns.length;

    // Standard deviation = sqrt(variance)
    const stdDev = Math.sqrt(variance);

    // Annualize the volatility (multiply by sqrt of # of periods in a year)
    // For stock market ticks, we'll use a scaling factor of 10
    const annualizingFactor = Math.sqrt(10);
    const annualizedVolatility = stdDev * annualizingFactor;

    // Clamp to reasonable values (0.001 to 0.5)
    return Math.min(0.5, Math.max(0.001, annualizedVolatility));
}

// =============================================
// UTILITY FUNCTIONS
// =============================================

/**
 * Determines if a stock is worth buying based on transaction costs
 */
function _isWorthBuying(ns: NS, stockSymbol: string, forecast: number, playerMoney: number): boolean {
    const stockPrice = ns.stock.getPrice(stockSymbol);
    const commission = ns.stock.getConstants().StockMarketCommission || COMMISSION;
    const maxShares = ns.stock.getMaxShares(stockSymbol);
    const affordableShares = Math.min(
        maxShares,
        Math.floor((playerMoney * 0.35) / stockPrice)
    );
    const investment = affordableShares * stockPrice;
    const commissionPercent = (commission * 2) / investment;

    return forecast > 0.53 && (TARGET_PROFIT > commissionPercent * 1.5);
}
