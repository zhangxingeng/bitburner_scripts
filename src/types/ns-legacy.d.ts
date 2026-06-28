/** Augment the @ns module with legacy runtime APIs that exist but are missing from the current typedefs. */

declare module '@ns' {
    interface NS {
        /** Legacy purchased-server API — exists at runtime. */
        getPurchasedServers(): string[];
        /** Legacy purchased-server API. */
        getPurchasedServerCost(ram: number): number;
        /** Legacy purchased-server API. */
        getPurchasedServerLimit(): number;
        /** Legacy purchased-server API (top-level, not cloud). */
        purchaseServer(hostname: string, ram: number): string;
        /** Legacy purchased-server API (top-level, not cloud). */
        deleteServer(host: string): boolean;
        /** Legacy number formatter — exists at runtime. */
        formatNumber(n: number, fmt?: string): string;
    }
}

export {};
