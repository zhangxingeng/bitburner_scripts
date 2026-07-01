import type { NS } from '@ns';
import {
    DesignPhase,
    DAEMON_CATALOG,
    DAEMON_LAUNCH_RESERVE,
    phaseRank,
    PHASE_RAM_EARLY,
    PHASE_RAM_MID,
    PHASE_RAM_LATE,
} from './config';
import { PORT_PHASE, peekPort } from './ports';
import { getReservedRam } from './machine_status';
import { requestRun } from './exec_guard';

/**
 * Daemon-catalog launcher — extracted from `bootstrap.ts` so `brain.ts` can call
 * it as one step of its own per-tick decision loop instead of owning a second,
 * competing top-level entry point (docs/design/14).
 *
 * Same behavior as the original bootstrap.ts, plus one real fix: daemon launches
 * now go through `requestRun` (lib/exec_guard.ts), so they respect the shared
 * per-machine RAM budget (lib/machine_status.ts) — previously `freeHomeRam` here
 * and `RamManager`'s home reservation in the compute stack were computing "how
 * much home RAM is free" completely differently, with the daemon launcher not
 * respecting the reservation at all.
 */

// ── Phase helpers (moved verbatim from bootstrap.ts) ──────────────────────────

/**
 * RAM-only phase estimate — used when PORT_PHASE has not yet been written by
 * `cross/phase_detector.ts`. Mirrors the threshold logic in phase_detector but
 * uses home maxRam alone (no full signal set).
 */
export function estimatePhase(ns: NS): DesignPhase {
    const homeMaxRam = ns.getServerMaxRam('home');
    if (homeMaxRam >= PHASE_RAM_LATE)  return DesignPhase.LATE;
    if (homeMaxRam >= PHASE_RAM_MID)   return DesignPhase.MID;
    if (homeMaxRam <= PHASE_RAM_EARLY) return DesignPhase.BOOTSTRAP;
    return DesignPhase.EARLY;
}

/**
 * Authoritative phase: peeks PORT_PHASE (published by `cross/phase_detector`).
 * Falls back to the RAM estimate when the detector has not yet started.
 */
export function currentPhase(ns: NS): DesignPhase {
    const portVal = peekPort(ns, PORT_PHASE) as DesignPhase | null;
    return portVal ?? estimatePhase(ns);
}

/**
 * Free RAM on home (GB), net of the shared per-machine reservation
 * (lib/machine_status.ts). The original bootstrap.ts version of this function
 * ignored the reservation entirely — daemon launches and the compute stack now
 * agree on the same answer.
 */
export function freeHomeRam(ns: NS): number {
    const maxRam   = ns.getServerMaxRam('home');
    const usedRam  = ns.getServerUsedRam('home');
    const reserved = getReservedRam(ns, 'home');
    return Math.max(0, maxRam - usedRam - reserved);
}

// ── Daemon lifecycle ──────────────────────────────────────────────────────────

/** Per-daemon cooldown: prevent re-launching a daemon that died within this window. */
const DAEMON_COOLDOWN_MS = 30_000;

/** Track last successful launch time per daemon path to prevent death spirals. */
const cooldowns = new Map<string, number>();

/**
 * Walk `DAEMON_CATALOG` in declaration order; request a launch for any daemon
 * whose `minPhase` rank is ≤ the current phase rank, that is not already
 * running, and that fits in free home RAM with `DAEMON_LAUNCH_RESERVE` GB to
 * spare. Launches go through `requestRun` (lib/exec_guard.ts) tagged with each
 * daemon's own `priority` — none of these are BRAIN tier (that's brain.ts's own
 * process only), so this never blocks: a daemon that doesn't fit is skipped and
 * retried on a later tick, same as before, but now it also publishes a pressure
 * signal other tiers can react to.
 *
 * A fresh `ns.ps` snapshot is taken INSIDE this function to avoid stale-process
 * races (the caller's snapshot may be seconds old after BFS + worker spray).
 */
export async function launchEligibleDaemons(
    ns:       NS,
    phase:    DesignPhase,
    freeHome: number,
): Promise<void> {
    // FRESH snapshot — the caller's snapshot may be stale after BFS + worker spray.
    const running = new Set(ns.ps('home').map(p => p.filename));
    const now     = Date.now();
    const rank    = phaseRank(phase);
    let available = freeHome; // running tally — prevent same-tick RAM over-commit

    for (const daemon of DAEMON_CATALOG) {
        if (phaseRank(daemon.minPhase) > rank) continue; // phase gate not yet reached
        if (running.has(daemon.path))          continue; // already alive

        // Cooldown guard: don't re-launch a daemon that died too fast.
        const lastLaunch = cooldowns.get(daemon.path) ?? 0;
        if (now - lastLaunch < DAEMON_COOLDOWN_MS) continue;

        const scriptRam = ns.getScriptRam(daemon.path);
        if (available < scriptRam + DAEMON_LAUNCH_RESERVE) continue; // insufficient headroom

        const result = await requestRun(ns, {
            script:      daemon.path,
            host:        'home',
            threads:     1,
            priority:    daemon.priority,
            args:        daemon.args,
            requesterId: 'daemon_launcher',
        });
        if (result.ok) {
            available -= scriptRam;
            cooldowns.set(daemon.path, now);
            const argsStr = daemon.args ? ' ' + daemon.args.join(' ') : '';
            ns.tprint(`ORCHESTRATOR: launched ${daemon.path}${argsStr} (${scriptRam.toFixed(2)} GB)`);
        }
    }
}

// ── Network helpers (moved verbatim from bootstrap.ts) ────────────────────────

/**
 * Inline BFS over the network; opens all owned port-opener tools and nukes each
 * host. Returns the full list of servers on which we have root access.
 *
 * Deliberately does NOT import lib/net_scan.ts's findAllServers: this file is
 * transitively imported by brain.ts (BRAIN tier, never yields — the single
 * most RAM-sensitive script in the system). net_scan.ts's shared bundle costs
 * ~0.6 GB flat (scan+ps+hasRootAccess+getHostname+getServerMaxRam+
 * getServerUsedRam) regardless of which one function you need — not worth it
 * here for a ~15-line BFS that already costs only ns.scan (0.2 GB) alone. See
 * docs/ram_evasion_rules.md §4.
 */
export function nukeAndScan(ns: NS): string[] {
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
export function pickTarget(ns: NS, rooted: string[]): string {
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
export function deployWorkers(ns: NS, rooted: string[], worker: string, workerRam: number, target: string): number {
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
