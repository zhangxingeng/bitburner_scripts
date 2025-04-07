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
        homeRamReserve: 0.15,
        /** Maximum home RAM to reserve in GB */
        maxHomeReserve: 128,
        /** Minimum home RAM to reserve in GB */
        minHomeReserve: 32,
        /** Minimum server RAM required to use */
        minServerRam: 2
    };

    // Execution configuration
    readonly executionConfig = {
        /** Base sleep time between main cycles */
        baseSleepTime: 1000,
        /** Whether to print detailed debug logs */
        debug: false
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
                threshold: 3,
                /** Security decrease per weaken thread */
                weakenAmount: this.securityConstants.weakenSecurityDecrease
            },
            money: {
                /** Target money percentage */
                threshold: 0.9
            },
            debug: this.executionConfig.debug
        };
    }
}
