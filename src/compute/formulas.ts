import { NS, Server, Player } from '@ns';

/**
 * Helper class for formula calculations with fallbacks if Formulas.exe isn't available.
 * Moved from engine/formulas.ts.
 */
export class FormulaHelper {
    private ns: NS;
    private hasFormulasExe: boolean;

    constructor(ns: NS) {
        this.ns = ns;
        this.hasFormulasExe = ns.fileExists('Formulas.exe', 'home');
    }

    /** Calculate the hack percent (0-1) for a server. */
    getHackPercent(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.hackPercent(server, player);
        } else {
            return this.ns.hackAnalyze(server.hostname);
        }
    }

    /** Calculate the hack chance (0-1) for a server. */
    getHackChance(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.hackChance(server, player);
        } else {
            return this.ns.hackAnalyzeChance(server.hostname);
        }
    }

    /**
     * Calculate grow threads needed to reach max money.
     * @param hackThreads Number of hack threads (used in fallback calculation).
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

    /** Get weaken execution time in milliseconds. */
    getWeakenTime(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.weakenTime(server, player);
        } else {
            return this.ns.getWeakenTime(server.hostname);
        }
    }

    /** Get hack execution time in milliseconds. */
    getHackTime(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.hackTime(server, player);
        } else {
            return this.ns.getHackTime(server.hostname);
        }
    }

    /** Get grow execution time in milliseconds. */
    getGrowTime(server: Server, player: Player): number {
        if (this.hasFormulasExe) {
            return this.ns.formulas.hacking.growTime(server, player);
        } else {
            return this.ns.getGrowTime(server.hostname);
        }
    }

    /** Return a server object with max money and min security (optimal state for calculations). */
    getOptimalServer(hostname: string): Server {
        const server = this.ns.getServer(hostname);
        server.moneyAvailable = server.moneyMax || 0;
        server.hackDifficulty = server.minDifficulty || 1;
        return server;
    }
}
