import { NS } from '@ns';

/**
 * Helper class for estimating stock forecasts and volatility
 * when 4S data is not available
 */
export class ForecastHelper {
    private ns: NS;

    /**
     * Constructor
     * @param ns NetScript API
     */
    constructor(ns: NS) {
        this.ns = ns;
    }

    /**
     * Calculate forecast from price history
     * @param priceHistory Array of historical prices
     * @returns Forecast (0-1)
     */
    calculateHistoricalForecast(priceHistory: number[]): number {
        if (!priceHistory || priceHistory.length < 2) return 0.5;

        let increases = 0;
        for (let i = 0; i < priceHistory.length - 1; i++) {
            if (priceHistory[i] > priceHistory[i + 1]) {
                increases++;
            }
        }

        return increases / (priceHistory.length - 1);
    }

    /**
     * Estimate volatility using historical price data
     * @param symbol Stock symbol
     * @param priceHistory Array of historical prices
     * @returns Estimated volatility
     */
    estimateVolatility(symbol: string, priceHistory?: number[]): number {
        try {
            // If we have enough price history data, calculate historical volatility
            if (priceHistory && priceHistory.length > 5) {
                return this.computeHistoricalVolatility(priceHistory);
            }

            // Fallback to bid-ask spread estimation
            const price = this.ns.stock.getPrice(symbol);
            const askPrice = this.ns.stock.getAskPrice(symbol);
            const bidPrice = this.ns.stock.getBidPrice(symbol);
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
     * Calculate historical volatility using standard deviation of log returns
     * @param priceHistory Array of historical prices
     * @returns Historical volatility
     */
    private computeHistoricalVolatility(priceHistory: number[]): number {
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

    /**
     * Calculate forecast for a stock (best estimate without 4S data)
     * @param symbol Stock symbol
     * @param priceHistory Optional price history
     * @returns Estimated forecast (0-1)
     */
    calculateForecast(symbol: string, priceHistory: number[] = []): number {
        try {
            if (priceHistory && priceHistory.length >= 5) {
                return this.calculateHistoricalForecast(priceHistory);
            }

            const price = this.ns.stock.getPrice(symbol);
            const askPrice = this.ns.stock.getAskPrice(symbol);
            const bidPrice = this.ns.stock.getBidPrice(symbol);
            const spread = (askPrice - bidPrice) / price;

            let forecast = 0.5;
            forecast += (0.01 - spread) * 2;
            forecast += (Math.random() - 0.5) * 0.05;

            return Math.min(0.6, Math.max(0.4, forecast));
        } catch {
            return Math.random() * 0.2 + 0.4;
        }
    }
} 