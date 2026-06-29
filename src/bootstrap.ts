import { NS } from '@ns';
import {
    DesignPhase,
    SCRIPT_PATHS,
    DAEMON_CATALOG,
    DAEMON_LAUNCH_RESERVE,
    phaseRank,
    PHASE_RAM_EARLY,
    PHASE_RAM_MID,
    PHASE_RAM_LATE,
} from './lib/config';
import { PORT_PHASE, peekPort } from './lib/ports';

/**
 * Lean BOOTSTRAP orchestrator — the first thing you run on a fresh BitNode.
 *
 * Why this exists (docs/HANDOFF.md §4, docs/design/04-player-automation-and-control.md §5):
 * The old pattern handed off to `compute/coordinator.ts` (~15.85 GB) once home RAM hit 32 GB —
 * a cliff that forced the botnet to sit idle for minutes while RAM slowly climbed.  This script
 * replaces that cliff with a **gradual ramp**: a lean (≤ 5 GB) permanent orchestrator that
 * spawns each daemon as its own `ns.exec` process the instant home RAM allows, gated by phase.
 *
 * ### Daemon-spawning mechanism
 * All daemon lifecycle uses `ns.exec` + `ns.ps`-based running-set guards (Mechanism #1 — see
 * docs/design/04 §2).  Rationale (manager decision, 2026-06-29):
 *   - RAM-neutral: the orchestrator already pays the 1.3 GB `ns.exec` cost for worker spray,
 *     so daemon-exec is free on top; `launch()` would save nothing because it references
 *     `ns.exec` for its fallback anyway.
 *   - More robust: `ns.exec` returns a synchronous PID; `ns.ps` reflects the spawn instantly —
 *     no double-spawn race, no cooldown needed.
 *   - Cleaner separation: `cross/launcher.ts` (Mechanism #3a) stays reserved for terminal-only
 *     commands, player UI actions, and MCP hands-free control.  The process separation that
 *     dissolves the 15.85 GB import wall comes from each daemon being its own process (delivered
 *     by `ns.exec`), not from terminal injection.
 *
 * ### What it does each loop
 *   1. Rebuild the running-process set from `ns.ps('home')`.
 *   2. Determine the current `DesignPhase` (PORT_PHASE authoritative; RAM estimate as fallback).
 *   3. BFS the network; root every openable server.
 *   4. Spray `workers/simple_hack_loop.js <target>` — but ONLY while the coordinator is absent,
 *      so once the batcher is up it owns all worker RAM.
 *   5. Walk `DAEMON_CATALOG`; launch any daemon whose phase gate is met and that fits in free
 *      home RAM (≥ scriptRam + DAEMON_LAUNCH_RESERVE).
 *
 * ### RAM note
 * Deliberately self-contained — imports ONLY pure constants from `lib/config` and zero-cost port
 * helpers from `lib/ports`.  Does NOT import the compute stack, formulas, batcher, or
 * `cross/launcher`.  BFS, nuke, target-pick, and deploy logic are inlined for that reason.
 *
 *   Usage:  run /bootstrap.js
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    const worker    = SCRIPT_PATHS.simpleHackLoop;   // '/workers/simple_hack_loop.js' (~2 GB/thread)
    const workerRam = ns.getScriptRam(worker);

    ns.tprint('BOOTSTRAP ORCHESTRATOR started — spawning daemons as home RAM allows.');

    // eslint-disable-next-line no-constant-condition
    while (true) {
        // ── 1. Snapshot running processes ─────────────────────────────────────
        const running = new Set(ns.ps('home').map(p => p.filename));

        // ── 2. Determine phase ────────────────────────────────────────────────
        const phase = currentPhase(ns);

        // ── 3. Root network ───────────────────────────────────────────────────
        const rooted = nukeAndScan(ns);
        const target = pickTarget(ns, rooted);

        // ── 4. Spray workers (only while coordinator is not yet running) ──────
        // Once the coordinator is up it owns all free worker RAM; stop spraying.
        if (!running.has(SCRIPT_PATHS.coordinator)) {
            const threads = deployWorkers(ns, rooted, worker, workerRam, target);
            ns.print(`rooted=${rooted.length} target=${target} newThreads=${threads} phase=${phase}`);
        } else {
            ns.print(`rooted=${rooted.length} phase=${phase} coordinator=running`);
        }

        // ── 5. Launch eligible daemons ────────────────────────────────────────
        launchEligibleDaemons(ns, phase, running, freeHomeRam(ns));

        await ns.sleep(2000);
    }
}

// ── Phase helpers ─────────────────────────────────────────────────────────────

/**
 * RAM-only phase estimate — used when PORT_PHASE has not yet been written by
 * `cross/phase_detector.ts`.  Mirrors the threshold logic in phase_detector but
 * uses home maxRam alone (no full signal set).
 *
 * Cheap: one `ns.getServerMaxRam` call (0.05 GB).
 */
function estimatePhase(ns: NS): DesignPhase {
    const homeMaxRam = ns.getServerMaxRam('home');
    if (homeMaxRam >= PHASE_RAM_LATE)  return DesignPhase.LATE;
    if (homeMaxRam >= PHASE_RAM_MID)   return DesignPhase.MID;
    if (homeMaxRam <= PHASE_RAM_EARLY) return DesignPhase.BOOTSTRAP;
    return DesignPhase.EARLY;
}

/**
 * Authoritative phase: peeks PORT_PHASE (published by `cross/phase_detector`).
 * Falls back to the RAM estimate when the detector has not yet started.
 * Port-peek costs 0 GB; estimatePhase adds one `getServerMaxRam` call.
 */
function currentPhase(ns: NS): DesignPhase {
    const portVal = peekPort(ns, PORT_PHASE) as DesignPhase | null;
    return portVal ?? estimatePhase(ns);
}

/** Free RAM on home (GB) at the moment of the call. */
function freeHomeRam(ns: NS): number {
    return ns.getServerMaxRam('home') - ns.getServerUsedRam('home');
}

// ── Daemon lifecycle ──────────────────────────────────────────────────────────

/**
 * Walk `DAEMON_CATALOG` in declaration order; call `ns.exec` for any daemon whose
 * `minPhase` rank is ≤ the current phase rank, that is not already running, and
 * that fits in free home RAM with `DAEMON_LAUNCH_RESERVE` GB to spare.
 *
 * A running `available` tally is decremented on each successful exec so multiple
 * daemons in the same tick cannot over-commit the same RAM.
 *
 * Spawn mechanism: `ns.exec` (API Mechanism #1) — synchronous PID means the
 * `ns.ps`-based running set on the *next* tick reflects the new process instantly;
 * no cooldown constant needed, no double-spawn race possible.
 */
function launchEligibleDaemons(
    ns:       NS,
    phase:    DesignPhase,
    running:  Set<string>,
    freeHome: number,
): void {
    const rank = phaseRank(phase);
    let available = freeHome; // running tally — prevent same-tick RAM over-commit

    for (const daemon of DAEMON_CATALOG) {
        if (phaseRank(daemon.minPhase) > rank) continue; // phase gate not yet reached
        if (running.has(daemon.path))          continue; // already alive
        const scriptRam = ns.getScriptRam(daemon.path);
        if (available < scriptRam + DAEMON_LAUNCH_RESERVE) continue; // insufficient headroom
        const pid = ns.exec(daemon.path, 'home', 1);
        if (pid !== 0) {
            available -= scriptRam;
            ns.tprint(`ORCHESTRATOR: launched ${daemon.path} (${scriptRam.toFixed(2)} GB)`);
        }
    }
}

// ── Network helpers (inlined to keep import footprint minimal) ────────────────

/**
 * Inline BFS over the network; opens all owned port-opener tools and nukes each
 * host.  Returns the full list of servers on which we have root access.
 */
function nukeAndScan(ns: NS): string[] {
    const openers: Array<[string, (h: string) => void]> = [
        ['BruteSSH.exe',  h => ns.brutessh(h)],
        ['FTPCrack.exe',  h => ns.ftpcrack(h)],
        ['relaySMTP.exe', h => ns.relaysmtp(h)],
        ['HTTPWorm.exe',  h => ns.httpworm(h)],
        ['SQLInject.exe', h => ns.sqlinject(h)],
    ];
    const available = openers.filter(([file]) => ns.fileExists(file)).map(([, fn]) => fn);

    const visited = new Set<string>();
    const queue: string[] = ['home'];
    const rooted: string[] = [];

    while (queue.length > 0) {
        const host = queue.shift()!;
        if (visited.has(host)) continue;
        visited.add(host);

        if (host !== 'home' && !ns.hasRootAccess(host)) {
            for (const open of available) {
                try { open(host); } catch { /* opener not applicable to this host */ }
            }
            try { ns.nuke(host); } catch { /* not enough ports open yet */ }
        }

        if (ns.hasRootAccess(host)) rooted.push(host);
        for (const next of ns.scan(host)) if (!visited.has(next)) queue.push(next);
    }

    return rooted;
}

/** Best early target: highest moneyMax among rooted servers we can currently hack. */
function pickTarget(ns: NS, rooted: string[]): string {
    const level = ns.getHackingLevel();
    let best = 'n00dles';
    let bestMoney = -1;

    for (const host of rooted) {
        if (host === 'home') continue;
        if (ns.getServerRequiredHackingLevel(host) > level) continue;
        const money = ns.getServerMaxMoney(host);
        if (money > 0 && money > bestMoney) {
            bestMoney = money;
            best = host;
        }
    }

    return best;
}

/**
 * Fill each rooted non-home server's free RAM with simple_hack_loop workers.
 * Home is excluded to keep RAM available for the daemon catalog.
 * Returns total threads launched this call.
 */
function deployWorkers(ns: NS, rooted: string[], worker: string, workerRam: number, target: string): number {
    let launched = 0;

    for (const host of rooted) {
        if (host === 'home') continue;   // keep home free for daemons
        const freeRam = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        const threads = Math.floor(freeRam / workerRam);
        if (threads < 1) continue;

        ns.scp(worker, host);
        if (ns.exec(worker, host, threads, target) !== 0) launched += threads;
    }

    return launched;
}
