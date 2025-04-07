import { NS } from '@ns';
import { findAllServers } from '../lib/utils';
import { HackingConfig } from './hack_config';

/**
 * RAM management for distributed hacking
 */
export class RamManager {
    private ns: NS;
    private config: HackingConfig;
    private servers: Map<string, { freeRam: number; maxRam: number }> = new Map();

    /**
     * Create a new RAM manager
     * @param ns NetScript API
     * @param config Hacking configuration
     */
    constructor(ns: NS, config: HackingConfig) {
        this.ns = ns;
        this.config = config;
        this.updateRamInfo();
    }

    /**
     * Update RAM information for all servers
     */
    updateRamInfo(): void {
        this.servers.clear();

        const homeReservedRam = Math.max(
            Math.min(
                this.ns.getServerMaxRam('home') * this.config.ramConfig.homeRamReserve,
                this.config.ramConfig.maxHomeReserve
            ),
            this.config.ramConfig.minHomeReserve
        );

        // Add purchased servers
        for (const server of this.ns.getPurchasedServers()) {
            const maxRam = this.ns.getServerMaxRam(server);
            const usedRam = this.ns.getServerUsedRam(server);
            const freeRam = maxRam - usedRam;

            if (freeRam > this.config.ramConfig.minServerRam) {
                this.servers.set(server, { freeRam, maxRam });
            }
        }

        // Add home if enabled
        if (this.config.ramConfig.useHomeRam) {
            const maxRam = this.ns.getServerMaxRam('home');
            const usedRam = this.ns.getServerUsedRam('home');
            const freeRam = Math.max(0, maxRam - usedRam - homeReservedRam);

            if (freeRam > this.config.ramConfig.minServerRam) {
                this.servers.set('home', { freeRam, maxRam });
            }
        }

        // Add all other servers
        const allServers = findAllServers(this.ns);
        for (const server of allServers) {
            // Skip if already added
            if (this.servers.has(server)) continue;

            // Skip home, already handled
            if (server === 'home') continue;

            // Skip purchased servers, already handled
            if (this.ns.getPurchasedServers().includes(server)) continue;

            // Only include rooted servers with enough RAM
            if (this.ns.hasRootAccess(server) &&
                this.ns.getServerMaxRam(server) >= this.config.ramConfig.minServerRam) {
                const maxRam = this.ns.getServerMaxRam(server);
                const usedRam = this.ns.getServerUsedRam(server);
                const freeRam = maxRam - usedRam;

                if (freeRam > 0) {
                    this.servers.set(server, { freeRam, maxRam });
                }
            }
        }
    }

    /**
     * Get total free RAM across all servers
     */
    getTotalFreeRam(): number {
        let total = 0;
        for (const info of this.servers.values()) {
            total += info.freeRam;
        }
        return total;
    }

    /**
     * Get total maximum RAM across all servers
     */
    getTotalMaxRam(): number {
        let total = 0;
        for (const info of this.servers.values()) {
            total += info.maxRam;
        }
        return total;
    }

    /**
     * Get free RAM for a specific server
     */
    getFreeRam(server: string): number {
        return this.servers.get(server)?.freeRam || 0;
    }

    /**
     * Reserve RAM on a specific server
     */
    reserveRam(amount: number, server: string): boolean {
        const info = this.servers.get(server);
        if (!info || info.freeRam < amount) return false;

        info.freeRam -= amount;
        return true;
    }

    /**
     * Get all available servers
     */
    getAvailableServers(): string[] {
        return Array.from(this.servers.keys());
    }

    /**
     * Get servers sorted by free RAM (descending)
     */
    getServersByFreeRam(): string[] {
        return Array.from(this.servers.entries())
            .sort((a, b) => b[1].freeRam - a[1].freeRam)
            .map(entry => entry[0]);
    }

    /**
     * Get allocation map for all servers
     */
    getAllocMap(): number[] {
        const availableServers = this.getAvailableServers();
        return availableServers.map(server => {
            const freeRam = this.getFreeRam(server);
            return Math.floor(freeRam / this.config.scriptRamCost);
        });
    }
}