import { NS } from '@ns';
import { findAllServers } from '../lib/util_normal_ram';
import { HackingConfig } from './hack_config';

/**
 * RAM management for distributed hacking
 */
export class RamManager {
    private ns: NS;
    private config: HackingConfig;
    private servers: Map<string, { freeRam: number; maxRam: number }> = new Map();
    private homeReservedRam: number = 0;

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

        // Calculate home RAM reservation
        this.homeReservedRam = Math.max(
            Math.min(
                this.ns.getServerMaxRam('home') * this.config.ramConfig.homeRamReservePercent,
                this.config.ramConfig.maxHomeReserve
            ),
            this.config.ramConfig.minHomeReserve
        );

        // Get current RAM stats
        const homeMaxRam = this.ns.getServerMaxRam('home');
        const homeUsedRam = this.ns.getServerUsedRam('home');
        const homeFreeRam = homeMaxRam - homeUsedRam;

        // Check if our reservation is being violated
        const reservationViolated = homeFreeRam < this.homeReservedRam;

        // Create a compact debug message for RAM reservations
        const debugInfo = [
            '┌─── RAM RESERVATION INFO ───┐',
            `│ Home Reservation: ${this.homeReservedRam.toFixed(2).padEnd(8)} GB │`,
            `│ Max RAM: ${homeMaxRam.toFixed(2).padEnd(10)} GB │`,
            `│ Used RAM: ${homeUsedRam.toFixed(2).padEnd(10)} GB │`,
            `│ Free RAM: ${homeFreeRam.toFixed(2).padEnd(10)} GB │`,
            `│ Available RAM: ${Math.max(0, homeFreeRam - this.homeReservedRam).toFixed(2).padEnd(7)} GB │`,
            `│ Status: ${reservationViolated ? 'VIOLATED ⚠️' : 'OK       ✓'} │`,
            '└──────────────────────────┘'
        ].join('\n');

        this.ns.print(debugInfo);

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

            // Ensure we always subtract the reserved RAM
            const freeRam = Math.max(0, maxRam - usedRam - this.homeReservedRam);

            if (freeRam > this.config.ramConfig.minServerRam) {
                this.servers.set('home', { freeRam, maxRam: maxRam - this.homeReservedRam });
            } else {
                this.ns.print(`Home has insufficient free RAM after reservation: ${freeRam.toFixed(2)}GB available of ${maxRam.toFixed(2)}GB total (${this.homeReservedRam.toFixed(2)}GB reserved)`);
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
        for (const [server, info] of this.servers.entries()) {
            // For home, recompute the free RAM to respect reservation
            if (server === 'home') {
                total += this.getFreeRam(server);
            } else {
                total += info.freeRam;
            }
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
     * Check if home RAM reservation is being violated
     * @returns Whether reservation is violated (true) or respected (false)
     */
    isHomeReservationViolated(): boolean {
        const homeMaxRam = this.ns.getServerMaxRam('home');
        const homeUsedRam = this.ns.getServerUsedRam('home');
        const homeFreeRam = homeMaxRam - homeUsedRam;

        // Consider it violated if free RAM is less than reserved + a small buffer
        // This helps catch potential issues before they happen
        const reservationBuffer = 5; // 5GB buffer to catch potential issues early
        return homeFreeRam < (this.homeReservedRam + reservationBuffer);
    }

    /**
     * Get available RAM for scripts after respecting home reservation 
     * @returns Available RAM in GB
     */
    getHomeAvailableRam(): number {
        const homeMaxRam = this.ns.getServerMaxRam('home');
        const homeUsedRam = this.ns.getServerUsedRam('home');
        const homeFreeRam = homeMaxRam - homeUsedRam;

        return Math.max(0, homeFreeRam - this.homeReservedRam);
    }

    /**
     * Get free RAM for a specific server
     */
    getFreeRam(server: string): number {
        // For home, we need to ensure the reservation is honored
        if (server === 'home') {
            // Recalculate the free RAM to ensure reservation is always honored
            const maxRam = this.ns.getServerMaxRam('home');
            const usedRam = this.ns.getServerUsedRam('home');
            const actualFreeRam = Math.max(0, maxRam - usedRam - this.homeReservedRam);

            // Return the actual free RAM, not the cached value
            return actualFreeRam;
        }

        return this.servers.get(server)?.freeRam || 0;
    }

    /**
     * Reserve RAM on a specific server
     */
    reserveRam(amount: number, server: string): boolean {
        const info = this.servers.get(server);
        if (!info) return false;

        // Add a 5% safety margin to RAM reservations
        const amountWithMargin = amount * 1.05;

        // For home, double-check actual free RAM considering the reservation
        if (server === 'home') {
            const actualFreeRam = this.getFreeRam(server);

            if (actualFreeRam < amountWithMargin) {
                this.ns.print(`HOME RAM RESERVATION ENFORCED: Cannot allocate ${amountWithMargin.toFixed(2)}GB (only ${actualFreeRam.toFixed(2)}GB available)`);
                return false;
            }
        } else if (info.freeRam < amountWithMargin) {
            return false;
        }

        // Update the stored free RAM value
        info.freeRam -= amountWithMargin;

        // Log significant reservations
        if (amountWithMargin > 10) {
            this.ns.print(`Reserved ${amountWithMargin.toFixed(2)}GB on ${server} (${info.freeRam.toFixed(2)}GB remaining)`);
        }

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
        // Create a temporary array for sorting
        const serversWithRam = Array.from(this.servers.keys()).map(server => {
            return {
                name: server,
                // For home, recalculate free RAM to honor reservation
                freeRam: this.getFreeRam(server)
            };
        });

        return serversWithRam
            .sort((a, b) => b.freeRam - a.freeRam)
            .map(entry => entry.name);
    }

    /**
     * Get allocation map for all servers
     */
    getAllocMap(): number[] {
        const availableServers = this.getAvailableServers();
        return availableServers.map(server => {
            const freeRam = this.getFreeRam(server);
            // Account for the safety margin when calculating thread counts
            return Math.floor(freeRam / (this.config.scriptRamCost * 1.05));
        });
    }

    /**
     * Get the amount of RAM reserved for home
     */
    getHomeReservedRam(): number {
        return this.homeReservedRam;
    }

    /**
     * Get RAM usage by script across all servers
     * @param scriptName Script filename to check
     * @returns Total RAM used by the script across all servers
     */
    getScriptRamUsage(scriptName: string): number {
        let totalRamUsed = 0;
        const servers = this.getAvailableServers();

        for (const server of servers) {
            const processes = this.ns.ps(server);
            for (const proc of processes) {
                if (proc.filename === scriptName) {
                    totalRamUsed += this.ns.getScriptRam(scriptName) * proc.threads;
                }
            }
        }

        return totalRamUsed;
    }

    /**
     * Get a breakdown of RAM usage by script type
     * @returns Object mapping script types to RAM usage
     */
    getRamUsageBreakdown(): { [key: string]: number } {
        const result: { [key: string]: number } = {};
        const scriptTypes = [
            this.config.scriptPaths.hack,
            this.config.scriptPaths.grow,
            this.config.scriptPaths.weaken1,
            this.config.scriptPaths.weaken2,
            this.config.scriptPaths.autoGrow,
            this.config.scriptPaths.share
        ];

        for (const script of scriptTypes) {
            result[script] = this.getScriptRamUsage(script);
        }

        return result;
    }

    /**
     * Print detailed RAM usage information
     * Useful for debugging RAM reservation issues
     */
    printRamUsageDetails(): void {
        const homeMaxRam = this.ns.getServerMaxRam('home');
        const homeUsedRam = this.ns.getServerUsedRam('home');
        const homeFreeRam = homeMaxRam - homeUsedRam;
        const reservationViolated = this.isHomeReservationViolated();

        // Get script usage breakdown
        const ramBreakdown = this.getRamUsageBreakdown();
        const totalScriptRam = Object.values(ramBreakdown).reduce((sum, val) => sum + val, 0);

        // Build the detailed RAM info panel
        const ramDetails = [
            '┌─── DETAILED RAM USAGE ───┐',
            `│ Home RAM:     ${homeMaxRam.toFixed(1).padEnd(10)} GB │`,
            `│ Used RAM:     ${homeUsedRam.toFixed(1).padEnd(10)} GB │`,
            `│ Free RAM:     ${homeFreeRam.toFixed(1).padEnd(10)} GB │`,
            `│ Reserved:     ${this.homeReservedRam.toFixed(1).padEnd(10)} GB │`,
            `│ Status:       ${reservationViolated ? 'VIOLATED ⚠️' : 'HEALTHY ✓'.padEnd(10)} │`,
            '├────────────────────────────┤',
            '│ Script RAM Usage:           │'
        ];

        // Add each script's RAM usage
        for (const [script, ram] of Object.entries(ramBreakdown)) {
            const scriptName = script.split('/').pop() || script;
            if (ram > 0) {
                ramDetails.push(`│ ${scriptName.padEnd(12)} ${ram.toFixed(1).padEnd(10)} GB │`);
            }
        }

        ramDetails.push(`│ Total Scripts: ${totalScriptRam.toFixed(1).padEnd(10)} GB │`);
        ramDetails.push('└────────────────────────────┘');

        this.ns.print(ramDetails.join('\n'));
    }
}