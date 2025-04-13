import { NS } from '@ns';

/**
 * Script paths configuration
 */
export interface ScriptPaths {
    /** Path to hack script */
    hack: string;
    /** Path to weaken script */
    weaken: string;
    /** Path to grow script */
    grow: string;
    /** Path to weaken after hack script */
    weaken1: string;
    /** Path to weaken after grow script */
    weaken2: string;
    /** Path to auto-grow script */
    autoGrow: string;
    /** Path to share script */
    share: string;
}

/**
 * Batch hacking configuration
 */
export class HackingConfig {
    // Script paths
    readonly scriptPaths: ScriptPaths = {
        hack: '/remote/hack.js',
        weaken: '/remote/weaken.js',
        weaken1: '/remote/weaken.js',
        weaken2: '/remote/weaken.js',
        grow: '/remote/grow.js',
        autoGrow: '/remote/auto_grow.js',
        share: '/remote/share.js'
    };

    // Script RAM costs
    readonly scriptRamCost = 1.75;

    // Batch operation configuration
    readonly batchConfig = {
        /** Time between operations within a batch in ms */
        stepTime: 20,
        /** Gap between batches (typically stepTime * 4) */
        batchGap: 80,
        /** Maximum parallel batches per target */
        maxConcurrency: -1,
        /** Maximum hack threads per batch, -1 for auto */
        maxHackPerBatch: -1,
        /** Whether to use two weaken operations */
        twoWeakenOps: true
    };

    // Security impact constants
    readonly securityConstants = {
        /** Security increase per hack thread */
        hackSecurityIncrease: 0.002,
        /** Security increase per grow thread */
        growSecurityIncrease: 0.004,
        /** Security decrease per weaken thread */
        weakenSecurityDecrease: 0.05
    };

    // RAM management configuration
    readonly ramConfig = {
        /** Whether to use home RAM */
        useHomeRam: true,
        /** Percentage of home RAM to reserve */
        homeRamReservePercent: 0.25,
        /** Maximum home RAM to reserve in GB */
        maxHomeReserve: 128,
        /** Minimum home RAM to reserve in GB */
        minHomeReserve: 100,
        /** Minimum server RAM required to use */
        minServerRam: 2
    };

    // Execution configuration
    readonly executionConfig = {
        /** Base sleep time between main cycles */
        baseSleepTime: 1000,
        /** Whether to print detailed debug logs */
        debug: false,
        /** Whether to avoid printing toast messages for misfires */
        silentMisfires: true,
        /** Interval (in ticks) between status updates */
        statusUpdateInterval: 30,
        /** Interval (in ticks) between RAM and target updates */
        refreshInterval: 10,
        /** Interval (in seconds) to re-scan and nuke servers */
        nukeInterval: 50
    };

    // Targeting configuration
    readonly targetingConfig = {
        /** Maximum number of targets to hack simultaneously */
        maxTargets: 4,
        /** Money threshold (0-1) for considering a server prepared */
        moneyThreshold: 0.9,
        /** Security threshold for considering a server prepared */
        securityThreshold: 3
    };

    /**
     * Constructor
     * @param ns NetScript API
     */
    constructor(private ns: NS) { }

    /**
     * Get script RAM usage
     */
    getScriptRam(script: string): number {
        return this.ns.getScriptRam(script);
    }

    /**
     * Get auto grow configuration
     */
    getAutoGrowConfig() {
        return {
            security: {
                /** Target security level above minimum to tolerate */
                threshold: this.targetingConfig.securityThreshold,
                /** Security decrease per weaken thread */
                weakenAmount: this.securityConstants.weakenSecurityDecrease
            },
            money: {
                /** Target money percentage */
                threshold: this.targetingConfig.moneyThreshold
            },
            debug: this.executionConfig.debug
        };
    }

    /**
     * Get actual home RAM reservation based on configured percentages and limits
     */
    getHomeRamReservation(ns: NS): number {
        const homeMaxRam = ns.getServerMaxRam('home');
        // Calculate based on percentage with min/max constraints
        return Math.max(
            Math.min(
                homeMaxRam * this.ramConfig.homeRamReservePercent,
                this.ramConfig.maxHomeReserve
            ),
            this.ramConfig.minHomeReserve
        );
    }

    /**
     * Check if home RAM reservation is being violated
     */
    isHomeRamReservationViolated(ns: NS): boolean {
        const homeMaxRam = ns.getServerMaxRam('home');
        const homeUsedRam = ns.getServerUsedRam('home');
        const homeFreeRam = homeMaxRam - homeUsedRam;
        const homeReserved = this.getHomeRamReservation(ns);

        return homeFreeRam < homeReserved;
    }
}
