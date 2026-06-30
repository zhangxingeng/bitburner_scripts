import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';

/**
 * Contracts manager daemon (docs/design/11).
 *
 * Persistent loop: every 45 s, snapshots all .cct files on the network,
 * launches /player/contract_solver.js to solve them (one-shot), waits for it
 * to finish, then diffs the before/after state to tally solved and failed.
 * Publishes SubsystemStatus each iteration.
 *
 * Reuse strategy: contract_solver.ts exports only `main()` — all solver
 * helpers (findAllContracts, getAllServers, solveContract, the algorithm
 * classes) are module-private and cannot be imported.  This manager therefore
 * calls the solver via ns.run and polls ns.isRunning until it exits.  No
 * solver algorithms are duplicated here; only a minimal BFS scan is repeated
 * to measure outcomes (before → after diff).
 *
 * Coding contracts are available in every BitNode (no SF gate), so
 * `available` is always true.  `enabled` mirrors settings.autoSolveContracts.
 */

const SOLVER_SCRIPT  = '/player/contract_solver.js';
const LOOP_MS        = 45_000;   // 45 s between passes
const SOLVER_MAX_MS  = 30_000;   // give solver up to 30 s
const POLL_MS        = 250;

// ── Cumulative counters (survive loop iterations, reset on script restart) ──
let totalSolved = 0;
let totalFailed = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** BFS the whole network; returns every reachable server name. */
function bfsServers(ns: NS): string[] {
    const queue: string[] = ['home'];
    const seen = new Set<string>(['home']);
    for (let i = 0; i < queue.length; i++) {
        for (const host of ns.scan(queue[i])) {
            if (!seen.has(host)) { seen.add(host); queue.push(host); }
        }
    }
    return queue;
}

interface ContractSnap {
    server:    string;
    filename:  string;
    triesLeft: number;
}

/** Snapshot every .cct on the network along with its remaining-tries count. */
function snapshot(ns: NS): ContractSnap[] {
    return bfsServers(ns).flatMap(server =>
        (ns.ls(server, '.cct') as string[]).map(filename => ({
            server,
            filename,
            triesLeft: ns.codingcontract.getNumTriesRemaining(filename, server),
        }))
    );
}

/** Poll until the given PID exits or the timeout elapses. */
async function awaitPid(ns: NS, pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (ns.isRunning(pid) && Date.now() < deadline) {
        await ns.sleep(POLL_MS);
    }
}

// ── Main daemon ──────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    while (true) {
        const settings = loadSettings(ns);
        const enabled  = settings.autoSolveContracts;

        // ── disabled: idle but stay alive so sequencer needn't restart us ──
        if (!enabled) {
            saveSubsystem(ns, {
                id:       'contracts',
                available: true,
                enabled:   false,
                running:   false,
                headline:  'contracts disabled (autoSolveContracts off)',
                metrics:   { solved: totalSolved, failed: totalFailed, lastSeen: 0 },
                ts:        Date.now(),
            });
            await ns.sleep(LOOP_MS);
            continue;
        }

        // ── before-snapshot ─────────────────────────────────────────────────
        const before   = snapshot(ns);
        const lastSeen = before.length;

        saveSubsystem(ns, {
            id:       'contracts',
            available: true,
            enabled:   true,
            running:   true,
            headline:  `scanning · ${lastSeen} contract${lastSeen !== 1 ? 's' : ''} found`,
            metrics:   { solved: totalSolved, failed: totalFailed, lastSeen },
            ts:        Date.now(),
        });

        // ── run solver + diff ────────────────────────────────────────────────
        if (lastSeen > 0) {
            // Map "server|filename" → tries remaining before solver runs.
            const beforeMap = new Map<string, number>(
                before.map(c => [`${c.server}|${c.filename}`, c.triesLeft])
            );

            const pid = ns.run(SOLVER_SCRIPT, 1);
            if (pid > 0) {
                await awaitPid(ns, pid, SOLVER_MAX_MS);
            }

            // After-snapshot: measure what changed.
            const after    = snapshot(ns);
            const afterSet = new Set(after.map(c => `${c.server}|${c.filename}`));
            const afterMap = new Map(after.map(c => [`${c.server}|${c.filename}`, c.triesLeft]));

            let solvedRun = 0;
            let failedRun = 0;

            for (const [key, triesBefore] of beforeMap) {
                if (!afterSet.has(key)) {
                    // Contract gone → reward paid, file removed by the game.
                    solvedRun++;
                } else {
                    // Contract still present; if tries went down, solver tried and failed.
                    const triesAfter = afterMap.get(key) ?? triesBefore;
                    if (triesAfter < triesBefore) {
                        failedRun++;
                    }
                    // triesAfter === triesBefore means solver skipped (unsupported type).
                }
            }

            totalSolved += solvedRun;
            totalFailed += failedRun;
        }

        // ── publish final status for this pass ───────────────────────────────
        const headline =
            lastSeen === 0
                ? 'no contracts on network'
                : `solved ${totalSolved} · ${totalFailed} failed`;

        saveSubsystem(ns, {
            id:       'contracts',
            available: true,
            enabled:   true,
            running:   false,
            headline,
            metrics:   { solved: totalSolved, failed: totalFailed, lastSeen },
            ts:        Date.now(),
        });

        await ns.sleep(LOOP_MS);
    }
}
