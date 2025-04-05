import { NS } from '@ns';
import {
    findAllServers,
    getHackableServers,
    calculateServerValue
} from '../utils';
import { AutoGrowManager } from './auto_grow';

/**
 * Configuration for the ServerTargetManager
 */
export interface TargetManagerConfig {
    /** Maximum number of targets to process per cycle */
    maxTargetsPerCycle: number;
    /** Whether to prioritize high-value servers */
    prioritizeHighValue: boolean;
    /** Minimum required hacking level for targeting a server */
    minHackingLevelOffset?: number;
    /** Debug logging */
    debug: boolean;
}

/**
 * Target server information with metadata
 */
export interface TargetServerInfo {
    /** Server hostname */
    hostname: string;
    /** Server max money */
    maxMoney: number;
    /** Server growth rate */
    growthRate: number;
    /** Server minimum security level */
    minSecurityLevel: number;
    /** Required hacking level */
    requiredHackingLevel: number;
    /** Calculated server value/score */
    value: number;
    /** Whether the server is prepared for hacking */
    isPrepared: boolean;
}

/**
 * Manages server targets for hacking in a tick-based manner
 * 
 * This class is responsible for:
 * - Finding all viable server targets
 * - Evaluating and scoring servers based on various metrics
 * - Filtering and prioritizing targets
 * - Tracking server preparation state
 */
export class ServerTargetManager {
    private ns: NS;
    private config: TargetManagerConfig;
    private prepManager?: AutoGrowManager;
    private serverInfoCache: Map<string, TargetServerInfo> = new Map();
    private lastFullScan: number = 0;
    private scanInterval: number = 30000; // 30 seconds

    /**
     * Creates a new instance of the ServerTargetManager
     * 
     * @param ns - NetScript API
     * @param config - Configuration options
     * @param prepManager - Optional AutoGrowManager for server preparation status
     */
    constructor(
        ns: NS,
        config: TargetManagerConfig,
        prepManager?: AutoGrowManager
    ) {
        this.ns = ns;
        this.config = {
            maxTargetsPerCycle: 8,
            prioritizeHighValue: true,
            debug: false,
            ...config
        };
        this.prepManager = prepManager;
    }

    /**
     * Process a single tick, refreshing target data as needed
     */
    tick(): void {
        // Periodically refresh server data
        if (Date.now() - this.lastFullScan > this.scanInterval) {
            this.refreshServerData();
        }
    }

    /**
     * Refresh all server data
     */
    refreshServerData(): void {
        // Get all hackable servers
        const hackableServers = getHackableServers(this.ns);

        // Update server info for each target
        for (const hostname of hackableServers) {
            this.updateServerInfo(hostname);
        }

        // Clean up any servers that no longer exist
        for (const hostname of this.serverInfoCache.keys()) {
            if (!hackableServers.includes(hostname)) {
                this.serverInfoCache.delete(hostname);
            }
        }

        this.lastFullScan = Date.now();

        if (this.config.debug) {
            this.ns.print(`ServerTargetManager: Refreshed data for ${hackableServers.length} servers`);
        }
    }

    /**
     * Update info for a specific server
     */
    private updateServerInfo(hostname: string): void {
        if (!this.ns.serverExists(hostname)) return;

        const maxMoney = this.ns.getServerMaxMoney(hostname);
        const growthRate = this.ns.getServerGrowth(hostname);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(hostname);
        const requiredHackingLevel = this.ns.getServerRequiredHackingLevel(hostname);
        const value = calculateServerValue(this.ns, hostname);

        // Check if server is prepared if we have a prep manager
        const isPrepared = this.prepManager
            ? this.prepManager.isServerPrepared(hostname)
            : this.checkServerPreparation(hostname);

        const serverInfo: TargetServerInfo = {
            hostname,
            maxMoney,
            growthRate,
            minSecurityLevel,
            requiredHackingLevel,
            value,
            isPrepared
        };

        this.serverInfoCache.set(hostname, serverInfo);
    }

    /**
     * Basic check if a server is prepared (if no prepManager is available)
     */
    private checkServerPreparation(hostname: string): boolean {
        const securityThreshold = 5; // Default threshold
        const moneyThreshold = 0.7; // Default threshold (70% of max money)

        const currentSecurity = this.ns.getServerSecurityLevel(hostname);
        const minSecurity = this.ns.getServerMinSecurityLevel(hostname);
        const currentMoney = this.ns.getServerMoneyAvailable(hostname);
        const maxMoney = this.ns.getServerMaxMoney(hostname);

        const securityReady = currentSecurity <= minSecurity + securityThreshold;
        const moneyReady = currentMoney >= maxMoney * moneyThreshold;

        return securityReady && moneyReady;
    }

    /**
     * Get prepared targets sorted by priority
     * 
     * @param limit - Maximum number of targets to return
     * @returns Array of target hostnames
     */
    getPreparedTargets(limit?: number): string[] {
        // Start with all servers from the cache
        const targets = Array.from(this.serverInfoCache.values())
            .filter(info => info.isPrepared)
            .sort((a, b) => {
                if (this.config.prioritizeHighValue) {
                    // Sort by value (descending)
                    return b.value - a.value;
                } else {
                    // Sort by required hacking level (ascending)
                    return a.requiredHackingLevel - b.requiredHackingLevel;
                }
            })
            .map(info => info.hostname);

        // Apply limit if provided
        return limit ? targets.slice(0, limit) : targets;
    }

    /**
     * Get unprepared targets sorted by priority
     * 
     * @param limit - Maximum number of targets to return
     * @returns Array of target hostnames
     */
    getUnpreparedTargets(limit?: number): string[] {
        // Get all servers that need preparation
        const targets = Array.from(this.serverInfoCache.values())
            .filter(info => !info.isPrepared)
            .sort((a, b) => {
                if (this.config.prioritizeHighValue) {
                    // Sort by value (descending)
                    return b.value - a.value;
                } else {
                    // Sort by required hacking level (ascending)
                    return a.requiredHackingLevel - b.requiredHackingLevel;
                }
            })
            .map(info => info.hostname);

        // Apply limit if provided
        return limit ? targets.slice(0, limit) : targets;
    }

    /**
     * Get all targets sorted by priority (prepared first, then unprepared)
     * 
     * @param limit - Maximum number of targets to return
     * @returns Array of target hostnames
     */
    getAllTargets(limit?: number): string[] {
        const prepared = this.getPreparedTargets();
        const unprepared = this.getUnpreparedTargets();

        // Combine prepared and unprepared targets
        const allTargets = [...prepared, ...unprepared];

        // Apply limit if provided
        return limit ? allTargets.slice(0, limit) : allTargets;
    }

    /**
     * Get targets for the current cycle
     * This is the main method to use each tick to get targets
     * 
     * @param preparedOnly - Whether to only include prepared targets
     * @returns Array of target hostnames
     */
    getTargetsForCycle(preparedOnly: boolean = false): string[] {
        if (preparedOnly) {
            return this.getPreparedTargets(this.config.maxTargetsPerCycle);
        } else {
            return this.getAllTargets(this.config.maxTargetsPerCycle);
        }
    }

    /**
     * Check if a server is prepared
     * 
     * @param hostname - Server hostname
     * @returns Whether the server is prepared
     */
    isServerPrepared(hostname: string): boolean {
        // First check cache
        const cachedInfo = this.serverInfoCache.get(hostname);
        if (cachedInfo) {
            return cachedInfo.isPrepared;
        }

        // If not in cache, update and check
        this.updateServerInfo(hostname);
        return this.serverInfoCache.get(hostname)?.isPrepared || false;
    }

    /**
     * Get detailed info for a server
     * 
     * @param hostname - Server hostname
     * @returns Server info or undefined if not found
     */
    getServerInfo(hostname: string): TargetServerInfo | undefined {
        // Ensure data is up to date
        if (!this.serverInfoCache.has(hostname)) {
            this.updateServerInfo(hostname);
        }

        return this.serverInfoCache.get(hostname);
    }

    /**
     * Print status of all targets
     */
    printStatus(): void {
        const prepared = this.getPreparedTargets();
        const unprepared = this.getUnpreparedTargets();

        this.ns.tprint('===== SERVER TARGETS STATUS =====');
        this.ns.tprint(`Total targets: ${this.serverInfoCache.size} (${prepared.length} prepared, ${unprepared.length} unprepared)`);

        if (prepared.length > 0) {
            this.ns.tprint('\nTop 5 prepared targets:');
            for (let i = 0; i < Math.min(5, prepared.length); i++) {
                const info = this.serverInfoCache.get(prepared[i])!;
                this.ns.tprint(`  ${info.hostname}: $${this.ns.formatNumber(info.maxMoney)} (value: ${info.value.toFixed(2)})`);
            }
        }

        if (unprepared.length > 0) {
            this.ns.tprint('\nTop 5 unprepared targets:');
            for (let i = 0; i < Math.min(5, unprepared.length); i++) {
                const info = this.serverInfoCache.get(unprepared[i])!;
                this.ns.tprint(`  ${info.hostname}: $${this.ns.formatNumber(info.maxMoney)} (value: ${info.value.toFixed(2)})`);
            }
        }
    }
}
