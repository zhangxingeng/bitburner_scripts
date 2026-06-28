import { NS } from '@ns';

/**
 * Represents a single stock with all its properties and methods
 */
export class Stock {
    // Core stock properties
    public symbol: string;
    public price: number = 0;
    public ask_price: number = 0;
    public bid_price: number = 0;
    public spread: number = 0;
    public spread_pct: number = 0;
    public maxShares: number = 0;

    // Position information
    public sharesLong: number = 0;
    public boughtPrice: number = 0;
    public sharesShort: number = 0;
    public boughtPriceShort: number = 0;
    public ticksHeld: number = 0;
    public highPrice: number = 0;
    public isShort: boolean = false;
    public purchasePrice?: number;
    public totalCost?: number;

    // Analytics and forecast
    public forecast: number = 0.5;
    public vol: number = 0;
    public volatility: number = 0;
    public priceHistory: number[] = [];
    public nearTermForecast?: number;
    public longTermForecast?: number;
    public initialForecast?: number;
    public lastInversion: number = 0;
    public probStdDev: number = 0;
    public warnedBadPurchase: boolean = false;
    public possibleInversionDetected: boolean = false;
    public lastTickProbability?: number;

    // Debug properties
    public debugLog: string = '';

    /**
     * Constructor
     * @param symbol Stock symbol
     */
    constructor(symbol: string) {
        this.symbol = symbol;
    }

    /**
     * Whether this stock is owned (long or short)
     */
    owned(): boolean {
        return this.ownedShares() > 0;
    }

    /**
     * Total shares owned (long or short)
     */
    ownedShares(): number {
        return this.sharesLong + this.sharesShort;
    }

    /**
     * Whether the stock is bullish (probability > 0.5)
     */
    bullish(): boolean {
        return this.forecast > 0.5;
    }

    /**
     * Whether the stock is bearish (probability < 0.5)
     */
    bearish(): boolean {
        return !this.bullish();
    }

    /**
     * Calculate the value of a long position
     */
    positionValueLong(): number {
        return this.sharesLong * this.bid_price;
    }

    /**
     * Calculate the value of a short position
     */
    positionValueShort(): number {
        return this.sharesShort * (2 * this.boughtPriceShort - this.ask_price);
    }

    /**
     * Calculate the total value of all positions in this stock
     */
    positionValue(): number {
        return this.positionValueLong() + this.positionValueShort();
    }

    /**
     * Calculate expected return based on forecast and volatility
     */
    expectedReturn(): number {
        // To add conservatism to pre-4s estimates, we reduce the probability by 1 standard deviation without crossing the midpoint
        const normalizedProb = (this.forecast - 0.5);
        const conservativeProb = normalizedProb < 0
            ? Math.min(0, normalizedProb + this.probStdDev)
            : Math.max(0, normalizedProb - this.probStdDev);
        return this.volatility * conservativeProb;
    }

    /**
     * Calculate absolute expected return (used for comparing opportunities)
     */
    absReturn(): number {
        return Math.abs(this.expectedReturn());
    }

    /**
     * Calculate time to cover the spread
     * How many stock market ticks must occur at the current expected return before we regain the value lost by the spread
     */
    timeToCoverTheSpread(): number {
        return Math.log(this.ask_price / this.bid_price) / Math.log(1 + this.absReturn());
    }

    /**
     * Calculate blackout window - how many ticks before market cycle we should avoid buying
     */
    blackoutWindow(): number {
        return Math.ceil(this.timeToCoverTheSpread());
    }
} 