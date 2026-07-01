import type { NS } from '@ns';
import { hasSF4 } from './lib/sf_check';
import { buyTOR, buyAllPortOpeners, buyHomeRam, takeCourse, resumeFocus } from './player/ui_actions';
import {
    currentPhase,
    freeHomeRam,
    nukeAndScan,
    pickTarget,
    deployWorkers,
    launchEligibleDaemons,
} from './lib/daemon_launcher';
import { ensureDefaultBudget } from './lib/machine_status';
import { SCRIPT_PATHS } from './lib/config';

/**
 * BRAIN — the single entry point (docs/design/14).
 *
 * `run /brain.js` is the only thing the user types on a fresh game or after a
 * reset. Everything else is orchestrated from here, dynamically, every tick —
 * there is no second "run this at game start" script (bootstrap.ts's old role
 * is now a library this file calls, not a competing entry point).
 *
 * Per-tick responsibilities:
 *   1. Keep the network rooted and spray leftover RAM on non-home servers
 *      while the compute stack (coordinator.ts) isn't up yet — bootstrap.ts's
 *      old job, now via lib/daemon_launcher.ts.
 *   2. Walk DAEMON_CATALOG and launch anything eligible — budget/priority-aware
 *      via lib/exec_guard.ts's requestRun, which every daemon launch now goes
 *      through instead of a bare ns.exec.
 *   3. Pre-SF4 only: mimic human UI actions directly (buy TOR, port openers,
 *      home RAM, a free course) via player/ui_actions.ts's exported actions —
 *      no separate process needed, these are just clicks/keystrokes. Once SF4
 *      is detected this stops entirely; cross/player_sequencer.ts (already in
 *      DAEMON_CATALOG at EARLY phase) takes over TOR/program purchasing via
 *      the Singularity API from then on, so there is never more than one
 *      purchaser running at a time.
 *
 * brain.ts deliberately does NOT hack/grow/weaken or manage hacknet inline —
 * that's workers/early_prepper.ts and compute/hacknet_manager.ts's job, both
 * launched via the catalog like everything else. brain.ts decides WHAT should
 * be running and enforces the RAM budget; it doesn't do the work itself.
 *
 * MCP (mcp__bitburner__*, game-bridge.ts, game_agent.ts's control channel,
 * boot_agent.ts) is dev/debug tooling only — brain.ts has zero runtime
 * dependency on any of it being connected.
 */

// ── Tuning ──────────────────────────────────────────────────────────────────────

const LOOP_MS = 200;
/** Network BFS/nuke + worker spray + daemon-catalog walk cadence (~2s at 200ms —
 *  matches the old bootstrap.ts's own 2000ms loop; no need to run 10x more often). */
const NETWORK_MAINTENANCE_TICKS = 10;
/** Re-check SF4 every ~5 min once absent (mirrors player_sequencer's own cadence). */
const SF4_RECHECK_TICKS = 1500;
/** Pre-SF4 acquire-action cadence (~5s — mirrors ui_actions.ts's own earlyLoop). */
const ACQUIRE_TICKS = 25;
/** Status print cadence (~50s). */
const STATUS_TICKS = 250;

// ── Main ───────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.tprint('BRAIN started — single entry point (docs/design/14)');
    ns.ui.openTail();

    ensureDefaultBudget(ns, 'home');

    let sf4 = hasSF4(ns);
    ns.print(sf4
        ? 'SF4 detected — purchases deferred to cross/player_sequencer.js'
        : 'No SF4 yet — driving early-game purchases directly via DOM/terminal');

    // Studying is NOT idempotent like buyTOR/buyAllPortOpeners/buyHomeRam: clicking the
    // course button always starts a NEW ClassWork, which finishes (and dialog-pops) whatever
    // class is already running (Player.startWork -> currentWork.finish(true) in the game's
    // PlayerObjectWorkMethods.ts). A DOM re-check (e.g. "is the Stop-taking-course button
    // present") is unreliable here because buyTOR/buyAllPortOpeners/buyHomeRam navigate to a
    // TechVendor page earlier in this SAME tick whenever they're not yet satisfied — so by the
    // time we'd check, we're never still on the Work page. Track it ourselves instead: once
    // started, never call takeCourse again for the rest of this process's life.
    let studyingStarted = false;

    let tick = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        tick++;
        const t0 = Date.now();
        try {
            const phase = currentPhase(ns);

            // ── Network maintenance + daemon orchestration (~2s cadence) ─────
            if (tick % NETWORK_MAINTENANCE_TICKS === 0) {
                const rooted = nukeAndScan(ns);
                const target = pickTarget(ns, rooted);

                // Spray leftover RAM on remote servers only while the HWGW batch
                // engine (coordinator.ts) hasn't taken over yet — same rule as
                // the old bootstrap.ts.
                const coordinatorRunning = ns.ps('home').some(p => p.filename === SCRIPT_PATHS.coordinator);
                if (!coordinatorRunning) {
                    const worker = SCRIPT_PATHS.simpleHackLoop;
                    const workerRam = ns.getScriptRam(worker);
                    if (freeHomeRam(ns) > workerRam) deployWorkers(ns, rooted, worker, workerRam, target);
                }

                await launchEligibleDaemons(ns, phase, freeHomeRam(ns));
            }

            // ── SF4 re-check (rare) ───────────────────────────────────────────
            if (!sf4 && tick % SF4_RECHECK_TICKS === 0) {
                sf4 = hasSF4(ns);
                if (sf4) ns.print('SF4 now detected — handing purchases to player_sequencer.js');
            }

            // ── Pre-SF4 acquire: mimic human UI actions directly ──────────────
            if (!sf4 && tick % ACQUIRE_TICKS === 0) {
                const player = ns.getPlayer();
                await buyTOR(ns);
                await buyAllPortOpeners(ns);
                if (ns.getServerMaxRam('home') < 64) await buyHomeRam(ns);
                if (!studyingStarted && player.skills.hacking < 100) {
                    studyingStarted = await takeCourse(ns);
                }
                // The purchase attempts above navigate off the Work page, which auto-unfocuses
                // (see ui_actions.ts::resumeFocus) without cancelling the class — reclaim the
                // focus bonus every cycle instead of leaving study running unfocused forever.
                if (studyingStarted) await resumeFocus(ns);
            }

            // ── Status ─────────────────────────────────────────────────────────
            if (tick % STATUS_TICKS === 0) {
                ns.print(`[brain] phase=${phase} home=${ns.getServerMaxRam('home')}GB ` +
                    `free=${freeHomeRam(ns).toFixed(0)}GB sf4=${sf4}`);
            }
        } catch (err) {
            ns.print(`[brain] ERROR: ${String(err)}`);
            await ns.sleep(1000);
            continue;
        }
        await ns.sleep(Math.max(50, LOOP_MS - (Date.now() - t0)));
    }
}
