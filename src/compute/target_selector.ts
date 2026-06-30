import { NS } from '@ns';
import { findAllServers, calculateServerValue } from '../lib/servers';
import { TARGET_MONEY_THRESHOLD, TARGET_SECURITY_THRESHOLD } from '../lib/config';
import { FormulaHelper } from './formulas';

// ── Standalone helpers (dissolved from engine/batch_util.ts) ─────────────────

/**
 * Check if a server is prepared for batch hacking (at or near min-sec + max-money).
 * @param moneyThreshold Fraction of maxMoney required (default: TARGET_MONEY_THRESHOLD).
 * @param securityThreshold Max excess security above minDifficulty (default: TARGET_SECURITY_THRESHOLD).
 */
export function isServerPrepared(
    ns: NS,
    target: string,
    moneyThreshold: number = TARGET_MONEY_THRESHOLD,
    securityThreshold: number = TARGET_SECURITY_THRESHOLD,
): boolean {
    const server = ns.getServer(target);
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
 * Return hackable non-purchased servers sorted by calculateServerValue descending.
 * Dissolved from engine/batch_util.getTargetServers.
 */
export function getTargetServers(ns: NS): string[] {
    const allServers = findAllServers(ns);
    const hackLevel = ns.getHackingLevel();
    const purchased = new Set(ns.cloud.getServerNames());

    const targets = allServers.filter(server => {
        if (server === 'home' || purchased.has(server)) return false;
        if (!ns.hasRootAccess(server) || ns.getServerMaxMoney(server) <= 0) return false;
        return ns.getServerRequiredHackingLevel(server) <= hackLevel;
    });

    return targets.sort((a, b) => calculateServerValue(ns, b) - calculateServerValue(ns, a));
}

// ── TargetSelector class (was ServerTargetManager in engine/server_manager.ts) ─

/**
 * Phase-aware server-target ranking and prepared-status tracking.
 * Adapted from engine/server_manager.ts; uses flat constants from lib/config.
 *
 * TODO(design): Add per-thread-efficiency ranking for EARLY phase and
 *               payback-period ranking for LATE phase (inigo TargetFinder pattern).
 */
export class TargetSelector {
    private ns: NS;
    private formulas: FormulaHelper;
    private targetServers: string[] = [];
    private targetValues: Map<string, number> = new Map();
    private preparedServers: Set<string> = new Set();

    constructor(ns: NS) {
        this.ns = ns;
        this.formulas = new FormulaHelper(ns);
        this.refreshTargets();
    }

    /** Rescan the network and recompute target rankings. */
    refreshTargets(): void {
        const allServers = findAllServers(this.ns);
        const hackLevel = this.ns.getHackingLevel();
        const purchased = new Set(this.ns.cloud.getServerNames());

        this.targetServers = allServers.filter(server => {
            if (server === 'home' || purchased.has(server)) return false;
            if (!this.ns.hasRootAccess(server) || this.ns.getServerMaxMoney(server) <= 0) return false;
            return this.ns.getServerRequiredHackingLevel(server) <= hackLevel;
        });

        for (const target of this.targetServers) {
            this.targetValues.set(target, calculateServerValue(this.ns, target));
        }

        this.targetServers.sort((a, b) =>
            (this.targetValues.get(b) || 0) - (this.targetValues.get(a) || 0)
        );

        this.updatePreparedStatus();
    }

    /** Re-evaluate which targets currently meet the prepared thresholds. */
    updatePreparedStatus(): void {
        this.preparedServers.clear();
        for (const target of this.targetServers) {
            if (isServerPrepared(this.ns, target)) {
                this.preparedServers.add(target);
            }
        }
    }

    /** Check if a specific server meets the prepared thresholds. */
    isServerPrepared(target: string): boolean {
        return isServerPrepared(this.ns, target);
    }

    /**
     * Return up to `count` best targets, optionally restricted to prepared ones.
     */
    getBestTargets(count: number = 1, preparedOnly: boolean = true): string[] {
        this.updatePreparedStatus();
        const candidates = preparedOnly
            ? this.targetServers.filter(s => this.preparedServers.has(s))
            : this.targetServers;
        return candidates.slice(0, count);
    }

    /** True if the player currently has a 100% hack chance against this target. */
    hasMaxHackChance(target: string): boolean {
        const server = this.formulas.getOptimalServer(target);
        const player = this.ns.getPlayer();
        return this.formulas.getHackChance(server, player) >= 1.0;
    }

    /** Print a compact status panel of top targets. */
    printStatus(): void {
        this.updatePreparedStatus();
        const totalTargets = this.targetServers.length;
        const preparedCount = this.preparedServers.size;
        const topTargets = this.targetServers.slice(0, 3).map(name => ({
            name,
            value: this.targetValues.get(name) || 0,
            prepared: this.preparedServers.has(name),
        }));

        const lines = [
            '┌─── SERVER TARGETS ───┐',
            `│ Total Targets: ${totalTargets.toString().padEnd(7)} │`,
            `│ Prepared:      ${preparedCount.toString().padEnd(7)} │`,
            '├───────────────────────┤',
            '│ Top Targets:           │',
        ];
        for (let i = 0; i < topTargets.length; i++) {
            const t = topTargets[i];
            lines.push(`│ ${i + 1}. ${t.name.padEnd(15)} ${t.prepared ? '✓' : '✗'} │`);
        }
        lines.push('└───────────────────────┘');
        this.ns.print(lines.join('\n'));
    }
}
