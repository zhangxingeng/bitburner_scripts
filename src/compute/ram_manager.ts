import { NS } from '@ns';
import { findAllServers } from '../lib/servers';
import {
    HOME_RAM_RESERVE_FRACTION,
    HOME_RAM_RESERVE_MAX,
    HOME_RAM_RESERVE_MIN,
    HOME_RAM_USE,
    MIN_SERVER_RAM,
    SCRIPT_PATHS,
    SCRIPT_RAM_COST,
} from '../lib/config';

/**
 * RAM management for the distributed hacking botnet.
 * Moved from engine/ram_manager.ts; now uses flat constants from lib/config.
 *
 * Tracks per-server free/max RAM, enforces the home reservation, and exposes
 * thread-slot maps to the allocator.
 */
export class RamManager {
    private ns: NS;
    private servers: Map<string, { freeRam: number; maxRam: number }> = new Map();
    private homeReservedRam: number = 0;
    // Mutable override for home RAM reservation minimum (from --homeRam CLI flag).
    private _minHomeReserve: number = HOME_RAM_RESERVE_MIN;

    constructor(ns: NS, minHomeReserveOverride?: number) {
        this.ns = ns;
        if (minHomeReserveOverride && minHomeReserveOverride > 0) {
            this._minHomeReserve = minHomeReserveOverride;
        }
        this.updateRamInfo();
    }

    /** Override the minimum home RAM reservation (called when --homeRam flag is set). */
    setMinHomeReserve(gb: number): void {
        this._minHomeReserve = gb;
    }

    /** Compute the effective home RAM reservation from configured percentages and limits. */
    calcHomeReservation(homeMaxRam: number): number {
        return Math.max(
            Math.min(homeMaxRam * HOME_RAM_RESERVE_FRACTION, HOME_RAM_RESERVE_MAX),
            this._minHomeReserve
        );
    }

    /** Refresh RAM snapshot for all servers. Call once per coordination loop tick. */
    updateRamInfo(): void {
        this.servers.clear();

        const homeMaxRam = this.ns.getServerMaxRam('home');
        this.homeReservedRam = this.calcHomeReservation(homeMaxRam);

        const homeUsedRam = this.ns.getServerUsedRam('home');
        const homeFreeRam = homeMaxRam - homeUsedRam;
        const reservationViolated = homeFreeRam < this.homeReservedRam;

        this.ns.print([
            '┌─── RAM RESERVATION INFO ───┐',
            `│ Home Reservation: ${this.homeReservedRam.toFixed(2).padEnd(8)} GB │`,
            `│ Max RAM: ${homeMaxRam.toFixed(2).padEnd(10)} GB │`,
            `│ Used RAM: ${homeUsedRam.toFixed(2).padEnd(10)} GB │`,
            `│ Free RAM: ${homeFreeRam.toFixed(2).padEnd(10)} GB │`,
            `│ Available RAM: ${Math.max(0, homeFreeRam - this.homeReservedRam).toFixed(2).padEnd(7)} GB │`,
            `│ Status: ${reservationViolated ? 'VIOLATED' : 'OK      '} │`,
            '└──────────────────────────┘',
        ].join('\n'));

        // Purchased servers
        const purchasedServers = this.ns.cloud.getServerNames();
        const purchasedSet = new Set(purchasedServers);
        for (const server of purchasedServers) {
            const maxRam = this.ns.getServerMaxRam(server);
            const freeRam = maxRam - this.ns.getServerUsedRam(server);
            if (freeRam > MIN_SERVER_RAM) {
                this.servers.set(server, { freeRam, maxRam });
            }
        }

        // Home (if enabled)
        if (HOME_RAM_USE) {
            const freeRam = Math.max(0, homeMaxRam - homeUsedRam - this.homeReservedRam);
            if (freeRam > MIN_SERVER_RAM) {
                this.servers.set('home', { freeRam, maxRam: homeMaxRam - this.homeReservedRam });
            } else {
                this.ns.print(`Home has insufficient free RAM after reservation: ${freeRam.toFixed(2)}GB available`);
            }
        }

        // All other rooted servers
        const allServers = findAllServers(this.ns);
        for (const server of allServers) {
            if (server === 'home' || purchasedSet.has(server)) continue;
            if (!this.ns.hasRootAccess(server)) continue;
            if (this.ns.getServerMaxRam(server) < MIN_SERVER_RAM) continue;

            const maxRam = this.ns.getServerMaxRam(server);
            const freeRam = maxRam - this.ns.getServerUsedRam(server);
            if (freeRam > 0) {
                this.servers.set(server, { freeRam, maxRam });
            }
        }
    }

    /** Total free RAM across all tracked servers (respects home reservation). */
    getTotalFreeRam(): number {
        let total = 0;
        for (const [server] of this.servers.entries()) {
            total += this.getFreeRam(server);
        }
        return total;
    }

    /** Total max RAM across all tracked servers. */
    getTotalMaxRam(): number {
        let total = 0;
        for (const info of this.servers.values()) {
            total += info.maxRam;
        }
        return total;
    }

    /** Whether home free RAM has fallen below the reserved amount (+ a small buffer). */
    isHomeReservationViolated(): boolean {
        const homeMaxRam = this.ns.getServerMaxRam('home');
        const homeUsedRam = this.ns.getServerUsedRam('home');
        const homeFreeRam = homeMaxRam - homeUsedRam;
        const reservationBuffer = 5; // 5 GB early-warning buffer
        return homeFreeRam < (this.homeReservedRam + reservationBuffer);
    }

    /** Available RAM on home after the reservation is subtracted. */
    getHomeAvailableRam(): number {
        const homeMaxRam = this.ns.getServerMaxRam('home');
        const homeUsedRam = this.ns.getServerUsedRam('home');
        return Math.max(0, homeMaxRam - homeUsedRam - this.homeReservedRam);
    }

    /** Free RAM for a specific server (live for home, cached for others). */
    getFreeRam(server: string): number {
        if (server === 'home') {
            const maxRam = this.ns.getServerMaxRam('home');
            const usedRam = this.ns.getServerUsedRam('home');
            return Math.max(0, maxRam - usedRam - this.homeReservedRam);
        }
        return this.servers.get(server)?.freeRam || 0;
    }

    /** Reserve RAM on a server (deducts from cached free RAM). Returns false if insufficient. */
    reserveRam(amount: number, server: string): boolean {
        const info = this.servers.get(server);
        if (!info) return false;

        const amountWithMargin = amount * 1.05; // 5% safety margin

        if (server === 'home') {
            const actualFreeRam = this.getFreeRam(server);
            if (actualFreeRam < amountWithMargin) {
                this.ns.print(`HOME RAM RESERVATION ENFORCED: Cannot allocate ${amountWithMargin.toFixed(2)}GB (only ${actualFreeRam.toFixed(2)}GB available)`);
                return false;
            }
        } else if (info.freeRam < amountWithMargin) {
            return false;
        }

        info.freeRam -= amountWithMargin;
        if (amountWithMargin > 10) {
            this.ns.print(`Reserved ${amountWithMargin.toFixed(2)}GB on ${server} (${info.freeRam.toFixed(2)}GB remaining)`);
        }
        return true;
    }

    /** Hostnames of all tracked servers. */
    getAvailableServers(): string[] {
        return Array.from(this.servers.keys());
    }

    /** Servers sorted by free RAM descending. */
    getServersByFreeRam(): string[] {
        return Array.from(this.servers.keys())
            .map(server => ({ name: server, freeRam: this.getFreeRam(server) }))
            .sort((a, b) => b.freeRam - a.freeRam)
            .map(entry => entry.name);
    }

    /**
     * Thread-slot map aligned to getAvailableServers() order.
     * Each entry is the number of worker threads that fit in the server's free RAM.
     */
    getAllocMap(): number[] {
        return this.getAvailableServers().map(server => {
            const freeRam = this.getFreeRam(server);
            return Math.floor(freeRam / (SCRIPT_RAM_COST * 1.05));
        });
    }

    /** Currently reserved home RAM (GB). */
    getHomeReservedRam(): number {
        return this.homeReservedRam;
    }

    /** Total RAM consumed by a specific script across all tracked servers. */
    getScriptRamUsage(scriptName: string): number {
        let total = 0;
        for (const server of this.getAvailableServers()) {
            for (const proc of this.ns.ps(server)) {
                if (proc.filename === scriptName) {
                    total += this.ns.getScriptRam(scriptName) * proc.threads;
                }
            }
        }
        return total;
    }

    /** RAM used per script type (hack/grow/weaken/autoGrow/share). */
    getRamUsageBreakdown(): { [key: string]: number } {
        const result: { [key: string]: number } = {};
        const scripts = [
            SCRIPT_PATHS.hack,
            SCRIPT_PATHS.grow,
            SCRIPT_PATHS.weaken1,
            SCRIPT_PATHS.weaken2,
            SCRIPT_PATHS.autoGrow,
            SCRIPT_PATHS.share,
        ];
        for (const script of scripts) {
            result[script] = this.getScriptRamUsage(script);
        }
        return result;
    }
}
