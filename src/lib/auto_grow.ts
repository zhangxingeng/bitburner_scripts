import { NS } from '@ns';
import { formatMoney, formatPercent, findAllServers, gainRootAccess, scanAndNuke } from '../utils';

/**
 * Configuration settings for the auto-grow system
 */
export interface AutoGrowConfig {
    security: {
        /** Extra security level to tolerate above minimum */
        threshold: number;
        /** Security decrease per weaken thread */
        weakenAmount: number;
    };
    money: {
        /** Target money threshold as percentage of max money */
        threshold: number;
    };
    /** Enable debug logging */
    debug: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: AutoGrowConfig = {
    security: {
        threshold: 3,
        weakenAmount: 0.05
    },
    money: {
        threshold: 0.8
    },
    debug: false
};

/**
 * Server preparation states
 */
export enum PrepState {
    NONE = 'none',
    WEAKENING = 'weakening',
    GROWING = 'growing',
    READY = 'ready'
}

/**
 * Script paths and RAM usages
 */
export interface ScriptInfo {
    path: string;
    ram: number;
}

/**
 * Available script types
 */
export interface Scripts {
    weaken: ScriptInfo;
    grow: ScriptInfo;
    hack: ScriptInfo;
    share: ScriptInfo;
}

/**
 * Server Auto-Grow Manager
 * Handles server preparation using a tick-based approach
 */
export class AutoGrowManager {
    private ns: NS;
    private servers: string[] = [];
    private prepTargets: string[] = [];
    private serverStates = new Map<string, PrepState>();
    private config: AutoGrowConfig;
    private scripts: Scripts;
    private initialRun: boolean = true;

    /**
     * Creates a new instance of the Auto-Grow manager
     * 
     * @param ns - NetScript API
     * @param config - Configuration options (optional)
     */
    constructor(ns: NS, config: Partial<AutoGrowConfig> = {}) {
        this.ns = ns;
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Initialize script paths and RAM usage
        this.scripts = {
            weaken: {
                path: '/remote_batch/weaken.ts',
                ram: this.ns.getScriptRam('/remote_batch/weaken.ts')
            },
            grow: {
                path: '/remote_batch/grow.ts',
                ram: this.ns.getScriptRam('/remote_batch/grow.ts')
            },
            hack: {
                path: '/remote_batch/hack.ts',
                ram: this.ns.getScriptRam('/remote_batch/hack.ts')
            },
            share: {
                path: '/remote/share.ts',
                ram: this.ns.getScriptRam('/remote/share.ts')
            }
        };
    }

    /**
     * Initialize the manager by scanning servers and identifying targets
     */
    async init(): Promise<void> {
        // Get all rooted servers
        const nukedServers = scanAndNuke(this.ns);
        this.servers = Array.from(nukedServers);

        // Filter to hackable servers for preparation targets
        this.prepTargets = this.getHackableServers();

        if (this.config.debug) {
            this.ns.print(`Found ${this.servers.length} rooted servers and ${this.prepTargets.length} prep targets`);
        }
    }

    /**
     * Get servers that can be hacked based on player's hacking level
     */
    private getHackableServers(): string[] {
        const hackLevel = this.ns.getHackingLevel();
        return this.servers.filter(server => {
            // Skip purchased servers and home
            if (server === 'home' || this.ns.getPurchasedServers().includes(server)) {
                return false;
            }

            // Check if we can hack it
            const requiredLevel = this.ns.getServerRequiredHackingLevel(server);
            const hasMaxMoney = this.ns.getServerMaxMoney(server) > 0;

            return hasMaxMoney && requiredLevel <= hackLevel;
        }).sort((a, b) => {
            // Sort by required hacking level
            return this.ns.getServerRequiredHackingLevel(a) - this.ns.getServerRequiredHackingLevel(b);
        });
    }

    /**
     * Check if a server is fully prepared for hacking
     */
    isServerPrepared(target: string): boolean {
        if (!this.ns.serverExists(target)) return false;

        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);
        const currentMoney = this.ns.getServerMoneyAvailable(target);
        const maxMoney = this.ns.getServerMaxMoney(target);

        // Check against thresholds
        const securityReady = securityLevel <= minSecurityLevel + this.config.security.threshold;
        const moneyReady = currentMoney >= maxMoney * this.config.money.threshold;

        return securityReady && moneyReady;
    }

    /**
     * Get the current preparation state of a server
     */
    getServerState(target: string): PrepState {
        // Return the cached state if exists and server is prepared
        const currentState = this.serverStates.get(target) || PrepState.NONE;
        if (currentState === PrepState.READY && this.isServerPrepared(target)) {
            return PrepState.READY;
        }

        // Recalculate the state
        if (this.isServerPrepared(target)) {
            this.serverStates.set(target, PrepState.READY);
            return PrepState.READY;
        }

        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);
        const securityThreshold = minSecurityLevel + this.config.security.threshold;

        // Prioritize security over money
        if (securityLevel > securityThreshold) {
            this.serverStates.set(target, PrepState.WEAKENING);
            return PrepState.WEAKENING;
        }

        // If security is good but money is low, grow
        this.serverStates.set(target, PrepState.GROWING);
        return PrepState.GROWING;
    }

    /**
     * Process a single server for one tick
     * Returns true if action was taken, false otherwise
     */
    async processTick(target: string, ramManager: IRamManager): Promise<boolean> {
        if (!this.ns.serverExists(target)) return false;

        const state = this.getServerState(target);
        if (state === PrepState.READY) return false;

        // Not enough RAM to do anything meaningful
        if (ramManager.getTotalFreeRam() < this.scripts.weaken.ram) return false;

        // Process server based on current state
        switch (state) {
            case PrepState.WEAKENING:
                return this.weakenServer(target, ramManager);
            case PrepState.GROWING:
                return this.growServer(target, ramManager);
            default:
                return false;
        }
    }

    /**
     * Execute weaken operations on a server
     */
    private weakenServer(target: string, ramManager: IRamManager): boolean {
        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);
        const securityThreshold = minSecurityLevel + this.config.security.threshold;

        // Already at minimum security
        if (securityLevel <= securityThreshold) {
            this.serverStates.set(target, PrepState.GROWING);
            return false;
        }

        // Calculate threads needed to reach threshold
        const securityDiff = securityLevel - minSecurityLevel;
        const threadsNeeded = Math.ceil(securityDiff / this.config.security.weakenAmount);

        // Use as many threads as possible with available RAM
        const availableThreads = Math.floor(ramManager.getTotalFreeRam() / this.scripts.weaken.ram);
        const threads = Math.min(threadsNeeded, availableThreads);

        if (threads <= 0) return false;

        // Execute weaken with available threads
        return this.executeScript(this.scripts.weaken, threads, target, ramManager);
    }

    /**
     * Execute grow operations on a server
     */
    private growServer(target: string, ramManager: IRamManager): boolean {
        // Check security first - if too high, weaken instead
        const securityLevel = this.ns.getServerSecurityLevel(target);
        const minSecurityLevel = this.ns.getServerMinSecurityLevel(target);
        const securityThreshold = minSecurityLevel + this.config.security.threshold;

        if (securityLevel > securityThreshold) {
            this.serverStates.set(target, PrepState.WEAKENING);
            return this.weakenServer(target, ramManager);
        }

        // Check money
        const currentMoney = this.ns.getServerMoneyAvailable(target);
        const maxMoney = this.ns.getServerMaxMoney(target);

        // Already at target money
        if (currentMoney >= maxMoney * this.config.money.threshold) {
            this.serverStates.set(target, PrepState.READY);
            return false;
        }

        // Special case: if money is very low, add a small amount to avoid NaN
        if (currentMoney <= 1) {
            return this.executeScript(this.scripts.grow, 1, target, ramManager);
        }

        // Calculate grow threads needed
        let growThreads = 0;
        if (this.ns.fileExists('Formulas.exe')) {
            const server = this.ns.getServer(target);
            const player = this.ns.getPlayer();
            server.moneyAvailable = currentMoney;
            growThreads = Math.ceil(this.ns.formulas.hacking.growThreads(
                server, player, maxMoney, 1
            ));
        } else {
            const growthFactor = maxMoney / currentMoney;
            growThreads = Math.ceil(this.ns.growthAnalyze(target, growthFactor));
        }

        // Calculate security increase from grow and weaken threads needed
        const growSecurityIncrease = this.ns.growthAnalyzeSecurity(growThreads);
        const weakenThreadsNeeded = Math.ceil(growSecurityIncrease / this.config.security.weakenAmount);

        // Calculate total RAM needed
        const totalRamNeeded = (growThreads * this.scripts.grow.ram) +
            (weakenThreadsNeeded * this.scripts.weaken.ram);
        const availableRamAmount = ramManager.getTotalFreeRam();

        // If not enough RAM for both grow and weaken, scale down
        if (availableRamAmount < totalRamNeeded) {
            const scaleFactor = Math.floor(availableRamAmount / totalRamNeeded * 100) / 100;
            if (scaleFactor <= 0) return false;

            // Use at least one thread for each operation
            const adjustedGrowThreads = Math.max(1, Math.floor(growThreads * scaleFactor));

            // Allocate as much as possible to grow since we're doing one operation per tick
            return this.executeScript(this.scripts.grow, adjustedGrowThreads, target, ramManager);
        }

        // We can only do one operation per tick, so prioritize grow
        return this.executeScript(this.scripts.grow, growThreads, target, ramManager);
    }

    /**
     * Execute a script across available servers
     */
    private executeScript(script: ScriptInfo, threads: number, target: string, ramManager: IRamManager): boolean {
        if (threads <= 0) return false;

        const totalRamNeeded = script.ram * threads;

        if (ramManager.getTotalFreeRam() < totalRamNeeded) return false;

        // Sort servers by free RAM (descending)
        const servers = ramManager.getServersByFreeRam();
        let remainingThreads = threads;

        for (const server of servers) {
            if (remainingThreads <= 0) break;

            const freeRam = ramManager.getFreeRam(server);
            const maxThreads = Math.floor(freeRam / script.ram);

            if (maxThreads <= 0) continue;

            const threadsToRun = Math.min(maxThreads, remainingThreads);

            // Copy script if needed
            if (!this.ns.fileExists(script.path, server)) {
                if (!this.ns.scp(script.path, server, 'home')) {
                    continue;
                }
            }

            // Arguments for the script
            const scriptArgs = [
                target,                // Target server
                Date.now(),            // Start time
                0,                     // Duration (0 = run to completion)
                `prep-${script.path.split('/').pop()?.split('.')[0]}`, // Description
                false,                 // Stock manipulation
                true,                  // Silent execution
                true                   // Loop mode
            ];

            const pid = this.ns.exec(script.path, server, threadsToRun, ...scriptArgs);

            if (pid > 0) {
                remainingThreads -= threadsToRun;
                ramManager.reserveRam(threadsToRun * script.ram, server);
            }
        }

        return remainingThreads === 0;
    }

    /**
     * Process all prep targets for one tick
     */
    async tick(ramManager: IRamManager): Promise<void> {
        // Only update target list on initial run or periodically
        if (this.initialRun || Math.random() < 0.05) {
            await this.init();
            this.initialRun = false;
        }

        // Process each target in priority order
        for (const target of this.prepTargets) {
            // Skip if not enough RAM for even one operation
            if (ramManager.getTotalFreeRam() < this.scripts.weaken.ram) break;

            // Process this server for one tick
            await this.processTick(target, ramManager);
        }
    }

    /**
     * Get all prepared servers
     */
    getPreparedServers(): string[] {
        return this.prepTargets.filter(server => this.isServerPrepared(server));
    }

    /**
     * Print preparation status of all targets
     */
    printStatus(): void {
        const lines: string[] = [];
        lines.push('===== SERVER PREPARATION STATUS =====');
        lines.push('TARGET                | SECURITY      | MONEY         | STATE');

        for (const target of this.prepTargets) {
            const security = this.ns.getServerSecurityLevel(target);
            const minSecurity = this.ns.getServerMinSecurityLevel(target);
            const securityStatus = `${security.toFixed(2)}/${minSecurity.toFixed(2)}`;

            const currentMoney = this.ns.getServerMoneyAvailable(target);
            const maxMoney = this.ns.getServerMaxMoney(target);
            const moneyPercent = currentMoney / maxMoney;
            const moneyStatus = `${formatMoney(currentMoney)} (${formatPercent(moneyPercent)})`;

            const state = this.getServerState(target);

            lines.push(`${target.padEnd(20)} | ${securityStatus.padEnd(13)} | ${moneyStatus.padEnd(13)} | ${state}`);
        }

        this.ns.tprint(lines.join('\n'));
    }

    /**
     * Reset all server preparation states
     */
    resetServerStates(): void {
        this.serverStates.clear();
    }
}

/**
 * RAM management interface
 */
export interface IRamManager {
    /**
     * Get total free RAM across all servers
     */
    getTotalFreeRam(): number;

    /**
     * Get total maximum RAM across all servers
     */
    getTotalMaxRam(): number;

    /**
     * Get RAM utilization percentage
     */
    getUtilization(): number;

    /**
     * Get free RAM for a specific server
     */
    getFreeRam(server: string): number;

    /**
     * Reserve RAM on a specific server
     */
    reserveRam(amount: number, server: string): boolean;

    /**
     * Get servers sorted by free RAM (descending)
     */
    getServersByFreeRam(): string[];

    /**
     * Update RAM information for all servers
     */
    updateRamInfo(): void;
}

/**
 * Server RAM information
 */
export interface ServerRamInfo {
    /** Free RAM available on the server */
    freeRam: number;
    /** Maximum RAM on the server */
    maxRam: number;
}

/**
 * RAM management implementation
 */
export class RamManager implements IRamManager {
    private ns: NS;
    private servers: Map<string, ServerRamInfo> = new Map();

    /**
     * Creates a new instance of the RAM manager
     * 
     * @param ns - NetScript API
     * @param updateOnCreate - Whether to update RAM info on creation
     */
    constructor(ns: NS, updateOnCreate: boolean = true) {
        this.ns = ns;
        if (updateOnCreate) {
            this.updateRamInfo();
        }
    }

    /**
     * Update RAM information for all servers
     */
    updateRamInfo(): void {
        this.servers.clear();

        const allServers = findAllServers(this.ns);
        for (const server of allServers) {
            // Only include servers we have root on
            if (!this.ns.hasRootAccess(server)) continue;

            // Skip servers with less than 2GB RAM
            if (this.ns.getServerMaxRam(server) < 2) continue;

            const maxRam = this.ns.getServerMaxRam(server);
            const usedRam = this.ns.getServerUsedRam(server);
            const freeRam = maxRam - usedRam;

            // Handle home server differently (reserve some RAM)
            if (server === 'home') {
                const reserveAmount = Math.max(
                    Math.min(maxRam * 0.15, 128),  // Reserve 15% up to 128GB
                    32  // At least 32GB
                );
                this.servers.set(server, {
                    freeRam: Math.max(0, freeRam - reserveAmount),
                    maxRam
                });
            } else {
                this.servers.set(server, { freeRam, maxRam });
            }
        }
    }

    /**
     * Get total free RAM across all servers
     */
    getTotalFreeRam(): number {
        let total = 0;
        for (const server of this.servers.values()) {
            total += server.freeRam;
        }
        return total;
    }

    /**
     * Get total maximum RAM across all servers
     */
    getTotalMaxRam(): number {
        let total = 0;
        for (const server of this.servers.values()) {
            total += server.maxRam;
        }
        return total;
    }

    /**
     * Get current RAM utilization percentage
     */
    getUtilization(): number {
        const maxRam = this.getTotalMaxRam();
        if (maxRam === 0) return 0;
        return (maxRam - this.getTotalFreeRam()) / maxRam;
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
     * Get servers sorted by free RAM (descending)
     */
    getServersByFreeRam(): string[] {
        return Array.from(this.servers.entries())
            .sort((a, b) => b[1].freeRam - a[1].freeRam)
            .map(entry => entry[0]);
    }
}

/**
 * Main function to run the auto-grow script independently
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    const manager = new AutoGrowManager(ns);
    const ramManager = new RamManager(ns);

    await manager.init();

    ns.tprint('Starting Auto-Grow daemon...');

    while (true) {
        // Update RAM availability at the start of each tick
        ramManager.updateRamInfo();

        // Process one tick
        await manager.tick(ramManager);

        // Wait before next tick
        await ns.sleep(1000);
    }
}
