import { NS } from '@ns';
import { findAllServers, calculateServerValue } from '../lib/util_normal_ram';
import { FormulaHelper } from './formulas';

/**
 * Manages server targets for batch hacking
 */
export class ServerTargetManager {
    private ns: NS;
    private formulas: FormulaHelper;
    private targetServers: string[] = [];
    private targetValues: Map<string, number> = new Map();
    private preparedServers: Set<string> = new Set();

    /**
     * Create a new server target manager
     * @param ns NetScript API
     */
    constructor(ns: NS) {
        this.ns = ns;
        this.formulas = new FormulaHelper(ns);
        this.refreshTargets();
    }

    /**
     * Refresh the list of potential targets
     */
    refreshTargets(): void {
        const allServers = findAllServers(this.ns);
        const hackLevel = this.ns.getHackingLevel();

        // Filter servers to those that can be hacked
        this.targetServers = allServers.filter(server => {
            // Skip purchased servers and home
            if (server === 'home' || this.ns.getPurchasedServers().includes(server)) {
                return false;
            }

            // Only include rooted servers with money
            if (!this.ns.hasRootAccess(server) || this.ns.getServerMaxMoney(server) <= 0) {
                return false;
            }

            // Only include servers we can hack
            const requiredLevel = this.ns.getServerRequiredHackingLevel(server);
            return requiredLevel <= hackLevel;
        });

        // Calculate values for all targets
        for (const target of this.targetServers) {
            this.targetValues.set(target, calculateServerValue(this.ns, target));
        }

        // Sort by value (descending)
        this.targetServers.sort((a, b) => {
            return (this.targetValues.get(b) || 0) - (this.targetValues.get(a) || 0);
        });

        // Check which servers are prepared
        this.updatePreparedStatus();
    }

    /**
     * Update which servers are prepared (min security, max money)
     */
    updatePreparedStatus(): void {
        this.preparedServers.clear();

        for (const target of this.targetServers) {
            if (this.isServerPrepared(target)) {
                this.preparedServers.add(target);
            }
        }
    }

    /**
     * Check if a server is prepared (min security, max money)
     * @param target Server hostname
     * @returns True if prepared
     */
    isServerPrepared(target: string): boolean {
        const moneyThreshold = 0.9; // 90% of max money
        const securityThreshold = 3; // Within 3 of min security

        const server = this.ns.getServer(target);
        const currentMoney = server.moneyAvailable || 0;
        const maxMoney = server.moneyMax || 1;
        const currentSecurity = server.hackDifficulty || 100;
        const minSecurity = server.minDifficulty || 1;

        return (
            currentMoney >= maxMoney * moneyThreshold &&
            currentSecurity <= minSecurity + securityThreshold
        );
    }

    /**
     * Get the best targets for batch hacking
     * @param count Maximum number of targets to return
     * @param preparedOnly Whether to only include prepared targets
     * @returns Array of target hostnames
     */
    getBestTargets(count: number = 1, preparedOnly: boolean = true): string[] {
        // Update prepared status
        this.updatePreparedStatus();

        let candidates: string[];

        // Filter to prepared servers if requested
        if (preparedOnly) {
            candidates = this.targetServers.filter(server => this.preparedServers.has(server));
        } else {
            candidates = this.targetServers;
        }

        // Return the top N candidates
        return candidates.slice(0, count);
    }

    /**
     * Check if a target has 100% hack chance
     * @param target Server hostname
     * @returns True if hack chance is 100%
     */
    hasMaxHackChance(target: string): boolean {
        const server = this.formulas.getOptimalServer(target);
        const player = this.ns.getPlayer();
        return this.formulas.getHackChance(server, player) >= 1.0;
    }
}
