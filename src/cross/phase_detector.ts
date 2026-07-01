import type { NS } from '@ns';
import { PORT_PHASE, PORT_HEARTBEAT, PORT_DECISION, PORT_AUGS, pushPort, clearPort, peekPort } from '../lib/ports';
import { findAllServers, resetCaches } from '../lib/net_scan';
import {
    DesignPhase,
    PHASE_RAM_EARLY,
    PHASE_RAM_MID,
    PHASE_RAM_LATE,
    PHASE_ROOTED_EARLY,
    PHASE_RESET_MIN_AUGS,
    TARGET_MONEY_THRESHOLD,
    TARGET_SECURITY_THRESHOLD,
} from '../lib/config';

/**
 * Phase Detector — standalone daemon that classifies game stage and publishes to PORT_PHASE.
 *
 * EXTRACTED from monitor/strategy_agent.ts (phase detection only; execution/deployment
 * logic moved to compute/coordinator.ts or abandoned — see RECONCILIATION in coordinator).
 *
 * Phase mapping (legacy strategy_agent → design phases, docs/design/02-system-architecture.md §1):
 *   BOOTSTRAP   → BOOTSTRAP  (homeMaxRam ≤ PHASE_RAM_EARLY)
 *   SNOWBALL    → EARLY      (building port openers, nuking servers, ramping RAM)
 *   EXPANSION   → EARLY      (more nukable servers; still pre-MID)
 *   PREPARATION → MID        (targets unprepared; coordinator handles prep)
 *   BATCH       → MID        (HWGW batching active; coordinator handles scheduling)
 *   (new)       → LATE       (homeMaxRam ≥ PHASE_RAM_LATE = 512 GB)
 *   (new)       → RESET      (pendingAugs ≥ PHASE_RESET_MIN_AUGS — notify + wait)
 *
 * Hysteresis: PHASE_STABILITY_TICKS consecutive ticks required before any transition.
 * Heartbeat: writes 'alive' to PORT_HEARTBEAT every HEARTBEAT_INTERVAL_TICKS.
 * Publishes: string DesignPhase value on PORT_PHASE (cleared then re-written on change).
 * Logs: phase transitions to PORT_DECISION (game_agent mirrors to status/decisions.json).
 *
 * RAM note: BFS is inlined to keep import footprint minimal.  phase_detector is
 * designed to be schedulable on any rooted server with > ~4 GB free.
 *
 * Launch: ns.exec('/cross/phase_detector.js', 'home', 1)
 */

// ── Tuning ────────────────────────────────────────────────────────────────────

const PHASE_STABILITY_TICKS    = 5;    // ticks required to confirm a phase transition (hysteresis)
const HEARTBEAT_INTERVAL_TICKS = 5;    // write heartbeat every N ticks
const LOOP_INTERVAL_MS         = 1000; // target loop cadence

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal signals needed for phase classification (pure data, no actions). */
interface PhaseSignals {
    homeMaxRam:             number;
    hackingLevel:           number;
    rootedCount:            number;
    hasAnyPortOpener:       boolean;
    hasNukableServers:      boolean;  // at least one unrooted server we can nuke now
    unpreparedTargetCount:  number;
    pendingAugs:            number; // from PORT_AUGS, written by aug_planner
}

/** Hysteresis state — prevents rapid flapping on transient signals. */
interface StabilityState {
    candidate:        DesignPhase | null;
    consecutiveTicks: number;
}

// ── Signal snapshot ───────────────────────────────────────────────────────────

function gatherSignals(ns: NS): PhaseSignals {
    const home   = ns.getServer('home');
    const player = ns.getPlayer();

    const hasBruteSSH  = ns.fileExists('BruteSSH.exe',  'home');
    const hasFtpCrack  = ns.fileExists('FTPCrack.exe',  'home');
    const hasRelaySmtp = ns.fileExists('relaySMTP.exe', 'home');
    const hasHttpWorm  = ns.fileExists('HTTPWorm.exe',  'home');
    const hasSqlInject = ns.fileExists('SQLInject.exe', 'home');
    const maxPorts = [hasBruteSSH, hasFtpCrack, hasRelaySmtp, hasHttpWorm, hasSqlInject]
        .filter(Boolean).length;

    let rootedCount           = 0;
    let hasNukableServers     = false;
    let unpreparedTargetCount = 0;

    for (const host of findAllServers(ns)) {
        if (host === 'home') continue;
        const sv = ns.getServer(host);
        if (sv.hasAdminRights) {
            rootedCount++;
            if ((sv.moneyMax ?? 0) > 0 && player.skills.hacking >= (sv.requiredHackingSkill ?? Infinity)) {
                const moneyPct = (sv.moneyAvailable ?? 0) / (sv.moneyMax ?? 1);
                const secDiff  = (sv.hackDifficulty  ?? 100) - (sv.minDifficulty ?? 1);
                if (moneyPct < TARGET_MONEY_THRESHOLD || secDiff > TARGET_SECURITY_THRESHOLD) {
                    unpreparedTargetCount++;
                }
            }
        } else {
            if ((sv.numOpenPortsRequired ?? 99) <= maxPorts) hasNukableServers = true;
        }
    }

    // Peek PORT_AUGS for the count published by aug_planner (player/aug_planner.ts).
    // Port peek costs 0 GB — safe to call from phase_detector on any server.
    // Falls back to 0 if aug_planner has not run yet this session.
    const augsRaw    = peekPort(ns, PORT_AUGS);
    const pendingAugs = augsRaw !== null ? (parseInt(augsRaw, 10) || 0) : 0;

    return {
        homeMaxRam:            home.maxRam ?? 0,
        hackingLevel:          player.skills.hacking,
        rootedCount,
        hasAnyPortOpener:      maxPorts > 0,
        hasNukableServers,
        unpreparedTargetCount,
        pendingAugs,
    };
}

// ── Phase classification ──────────────────────────────────────────────────────

/** Map current signals to a DesignPhase (no hysteresis — pure classification). */
function classifyPhase(s: PhaseSignals): DesignPhase {
    // RESET: enough pending augments to justify installing and resetting.
    // pendingAugs is published by aug_planner to PORT_AUGS; peekPort reads it above.
    if (s.pendingAugs >= PHASE_RESET_MIN_AUGS) return DesignPhase.RESET;

    // LATE: massive home RAM; side-engines (gang/sleeve/bladeburner) viable
    if (s.homeMaxRam >= PHASE_RAM_LATE) return DesignPhase.LATE;

    // BOOTSTRAP: fresh start — home RAM at or near starting value
    if (s.homeMaxRam <= PHASE_RAM_EARLY) return DesignPhase.BOOTSTRAP;

    // MID: HWGW batching viable — enough RAM, network mostly under control
    if (
        s.homeMaxRam >= PHASE_RAM_MID &&
        s.rootedCount >= PHASE_ROOTED_EARLY &&
        !s.hasNukableServers
    ) return DesignPhase.MID;

    // EARLY: building up — nuking, acquiring port openers, ramping pservs
    return DesignPhase.EARLY;
}

// ── Hysteresis wrapper ────────────────────────────────────────────────────────

/**
 * Apply PHASE_STABILITY_TICKS hysteresis: require the raw candidate to be
 * consistent for N consecutive ticks before committing to a transition.
 * Returns the (possibly unchanged) confirmed phase.
 */
function applyHysteresis(
    candidate: DesignPhase,
    current:   DesignPhase,
    stab:      StabilityState,
): DesignPhase {
    if (candidate === current) {
        // stable — clear any pending candidate
        stab.candidate        = null;
        stab.consecutiveTicks = 0;
        return current;
    }

    if (stab.candidate === candidate) {
        stab.consecutiveTicks++;
        if (stab.consecutiveTicks >= PHASE_STABILITY_TICKS) {
            stab.candidate        = null;
            stab.consecutiveTicks = 0;
            return candidate;  // transition confirmed after enough consistent ticks
        }
    } else {
        // New candidate — reset counter
        stab.candidate        = candidate;
        stab.consecutiveTicks = 1;
    }

    return current;  // hold steady while candidate accumulates ticks
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.print(`Phase detector started on ${ns.getHostname()}`);

    let currentPhase: DesignPhase = DesignPhase.BOOTSTRAP;
    const stab: StabilityState    = { candidate: null, consecutiveTicks: 0 };
    let tick = 0;

    // Publish initial phase before first sleep so coordinator has something to read
    clearPort(ns, PORT_PHASE);
    pushPort(ns, PORT_PHASE, currentPhase);

    while (true) {
        tick++;
        const loopStart = Date.now();
        resetCaches(); // avoid reusing a stale findAllServers() result across ticks

        try {
            // Heartbeat — confirms this daemon is alive (boot_agent peeks PORT_HEARTBEAT)
            if (tick % HEARTBEAT_INTERVAL_TICKS === 0) {
                clearPort(ns, PORT_HEARTBEAT);
                pushPort(ns, PORT_HEARTBEAT, 'alive');
            }

            const signals   = gatherSignals(ns);
            const raw       = classifyPhase(signals);
            const confirmed = applyHysteresis(raw, currentPhase, stab);

            if (confirmed !== currentPhase) {
                ns.print(
                    `Phase: ${currentPhase} → ${confirmed}` +
                    ` (home=${signals.homeMaxRam}GB rooted=${signals.rootedCount}` +
                    ` nukable=${signals.hasNukableServers} unprepared=${signals.unpreparedTargetCount})`
                );

                // Publish new phase — consumer (coordinator) peeks this port
                clearPort(ns, PORT_PHASE);
                pushPort(ns, PORT_PHASE, confirmed);

                // Log transition to PORT_DECISION — game_agent drains this to decisions.json
                pushPort(ns, PORT_DECISION, JSON.stringify({
                    ts:   Date.now(),
                    tick,
                    type: 'PHASE_CHANGE',
                    from: currentPhase,
                    to:   confirmed,
                    signals: {
                        homeMaxRam:   signals.homeMaxRam,
                        rootedCount:  signals.rootedCount,
                        hackingLevel: signals.hackingLevel,
                    },
                }));

                currentPhase = confirmed;
            }
        } catch (err) {
            ns.print(`ERROR in phase detector: ${String(err)}`);
            await ns.sleep(1000);  // back off after error, then continue loop
            continue;
        }

        await ns.sleep(Math.max(50, LOOP_INTERVAL_MS - (Date.now() - loopStart)));
    }
}
