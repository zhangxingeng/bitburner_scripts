import { NS, Server, Player } from '@ns';

/**
 * Helper class for formula calculations with fallbacks if Formulas.exe isn't available
 * Converted from the original hack/bat/formulas.js implementation
 */
export class FormulaHelper {
    private ns: NS;
    private hasFormulasExe: boolean;

    /**
     * Create a new FormulaHelper
     * @param ns NetScript API
     */
    constructor(ns: NS) {
        this.ns = ns;
        this.hasFormulasExe = ns.fileExists('Formulas.exe', 'home');
    }

    /**
     * Calculate the hack percent (0-1) for a server
     * @param server Server object
     * @param player Player object
     * @returns Hack percent (0-1)
     */
    getHackPercent(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.hackPercent(server, player);
        } else {
            return this.ns.hackAnalyze(server.hostname);
        }
    }

    /**
     * Calculate the hack chance (0-1) for a server
     * @param server Server object
     * @param player Player object
     * @returns Hack chance (0-1)
     */
    getHackChance(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.hackChance(server, player);
        } else {
            return this.ns.hackAnalyzeChance(server.hostname);
        }
    }

    /**
     * Calculate grow threads needed to reach max money
     * @param server Server object
     * @param player Player object
     * @param hackThreads Number of hack threads (for without-formula calculation)
     * @returns Number of grow threads needed
     */
    getGrowThreads(server: Server, player: Player, hackThreads: number): number {
        if (this.hasFormulasExe) {
            return Math.ceil(this.ns.formulas.hacking.growThreads(
                server,
                player,
                server.moneyMax || 0,
                1 // Cores
            ));
        } else {
            const hackPercent = this.ns.hackAnalyze(server.hostname);
            const availableMoney = server.moneyAvailable || 0;
            const hackMoney = hackPercent * availableMoney * hackThreads;
            const moneyAfterHack = Math.max(1, availableMoney - hackMoney);
            const maxMoney = server.moneyMax || 1;
            const multiplier = maxMoney / moneyAfterHack;

            return Math.ceil(this.ns.growthAnalyze(server.hostname, multiplier));
        }
    }

    /**
     * Get weaken execution time
     * @param server Server object
     * @param player Player object
     * @returns Weaken time in milliseconds
     */
    getWeakenTime(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.weakenTime(server, player);
        } else {
            return this.ns.getWeakenTime(server.hostname);
        }
    }

    /**
     * Get hack execution time
     * @param server Server object
     * @param player Player object
     * @returns Hack time in milliseconds
     */
    getHackTime(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.hackTime(server, player);
        } else {
            return this.ns.getHackTime(server.hostname);
        }
    }

    /**
     * Get grow execution time
     * @param server Server object
     * @param player Player object
     * @returns Grow time in milliseconds
     */
    getGrowTime(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.growTime(server, player);
        } else {
            return this.ns.getGrowTime(server.hostname);
        }
    }

    /**
     * Helper function to get server with optimal settings
     * @param hostname Server hostname
     * @returns Server object with max money and min security
     */
    getOptimalServer(hostname: string): Server {
        const server = this.ns.getServer(hostname);
        server.moneyAvailable = server.moneyMax || 0;
        server.hackDifficulty = server.minDifficulty || 1;
        return server;
    }
} 