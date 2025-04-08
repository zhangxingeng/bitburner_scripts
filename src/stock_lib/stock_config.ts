import { NS } from '@ns';
import { checkOwnSF } from '../lib/utils';

/**
 * Configuration for stock trading operations
 */
export class StockConfig {
    // Core trading parameters
    readonly tradingParams = {
        /** Minimum number of ticks to hold a position */
        minHoldTime: 4,
        /** Target profit percentage before considering selling */
        targetProfit: 0.05,
        /** Stop loss percentage */
        stopLoss: 0.03,
        /** Maximum number of positions to hold simultaneously */
        maxPositions: 20,
        /** Maximum percentage of portfolio to allocate to stocks */
        portfolioLimit: 0.45,
        /** Additional diversification factor */
        diversificationFactor: 0.6,
        /** Commission cost for buying/selling */
        commission: 100000,
        /** Minimum transaction size to avoid micro-trades */
        minTransactionSize: 5e5,
        /** Percentage of total net worth to keep in cash */
        cashReserveFactor: 0.10,
        /** Maximum trades to make per market tick */
        maxTradesPerTick: 30,
        /** Milliseconds to cool down between trade operations */
        tradeCooldown: 100,
        /** Forecast change threshold for position evaluation */
        forecastChangeThreshold: 0.015,
        /** Minimum tick history before making predictions */
        minTickHistory: 5,
        /** Transaction influence factor on forecast */
        transactionInfluenceFactor: 0.00008,
        /** Threshold for market cycle detection */
        cycleDetectionThreshold: 0.03
    };

    // Pre-4S configuration (for trades before 4S API access)
    readonly pre4sParams = {
        /** Minimum tick history required before trading */
        minTickHistory: 21,
        /** Window length for long-term forecast */
        longTermForecastWindow: 51,
        /** Window length for near-term forecast */
        nearTermForecastWindow: 10,
        /** Market cycle length in ticks */
        marketCycleLength: 75,
        /** Maximum history to keep */
        maxTickHistory: 151,
        /** Tolerance for inversion detection */
        inversionDetectionTolerance: 0.10,
        /** Lag tolerance for inversion detection */
        inversionLagTolerance: 5,
        /** Buy threshold probability distance from 0.5 */
        buyThresholdProbability: 0.15,
        /** Buy threshold return */
        buyThresholdReturn: 0.0015,
        /** Sell threshold return */
        sellThresholdReturn: 0.0005,
        /** Minimum blackout window before market cycle */
        minBlackoutWindow: 10,
        /** Minimum hold time for fresh positions */
        minimumHoldTime: 10,
    };

    // Feature flags
    /** Whether shorting stocks is enabled */
    readonly hasShortSelling: boolean;

    // Stock market API options
    readonly apiOptions = {
        /** Cost of WSE account */
        wseAccountCost: 200e6,
        /** Cost of TIX API */
        tixApiCost: 5e9,
        /** Cost of 4S Market Data */
        marketDataCost: 1e9,
        /** Cost of 4S Market Data TIX API */
        marketDataTixApiCost: 25e9,
        /** Whether to automatically purchase APIs */
        autoUnlockApis: true,
        /** Maximum percentage of corpus to spend on 4S API */
        buy4sBudget: 0.8
    };

    /**
     * Constructor
     * @param ns NetScript API
     */
    constructor(private ns: NS) {
        // Check if short selling is available (SF8.2)
        this.hasShortSelling = checkOwnSF(ns, 8, 2);
    }

    /**
     * Get threshold to buy stocks, accounts for 4S data availability
     */
    getBuyThreshold(has4sData: boolean): number {
        return has4sData ? 0.0001 : this.pre4sParams.buyThresholdReturn;
    }

    /**
     * Get threshold to sell stocks, accounts for 4S data availability
     */
    getSellThreshold(has4sData: boolean): number {
        return has4sData ? 0 : this.pre4sParams.sellThresholdReturn;
    }
} 