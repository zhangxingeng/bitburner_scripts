/** Augment @ns with runtime APIs present in-game but absent from NetscriptDefinitions. */

declare module '@ns' {
    interface NS {
        getPurchasedServers(): string[];
        getPurchasedServerCost(ram: number): number;
        getPurchasedServerLimit(): number;
        purchaseServer(hostname: string, ram: number): string;
        deleteServer(host: string): boolean;
        formatNumber(n: number, fmt?: string): string;
    }

    interface Player {
        /** Money earned per second from current work action (crime, job, study). 0 if idle/hacking. */
        workMoneyGainRate?: number;
        /** Reputation earned per second from current work action. */
        workRepGainRate?: number;
    }
}

export {};
