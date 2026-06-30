import type { NS } from '@ns';
import { PORT_PHASE, PORT_AUGS, peekPort } from '../lib/ports';
import { DesignPhase, PHASE_RESET_MIN_AUGS, SCRIPT_PATHS } from '../lib/config';
import { loadSettings } from '../lib/settings';
import { notify } from '../cross/notification';
import { executeCommand } from '../lib/ns_dodge';
import { upsertPending, removePending, drainReplies } from '../lib/decisions';

/**
 * Player Sequencer — autonomous Thread-P brain daemon.
 *
 * Perceives game state each tick, picks the next trusted action, fires it, verifies.
 * Surfaces judgment calls (aug purchase, reset) over PORT_NOTIFY for human approval.
 *
 * Milestone 1 coverage (docs/design/05-thread-p-sequencing.md §10):
 *   - Auto-join eligible factions via faction_manager (SF4-gated, default ON)
 *   - Trigger program_acquirer for TOR + port openers  (SF4-gated, default ON)
 *   - Surface aug-purchase / reset decision over PORT_NOTIFY  (auto OFF by default)
 *
 * RAM target: ≤ 4 GB.
 *   Direct NS calls: getPlayer (0.5), run (1.0), isRunning (0.1), fileExists (0.1).
 *   Singularity (16 GB each) routes through lib/ns_dodge.ts — zero cost to this script.
 *   Port/sleep/print/read/write: 0 GB each.
 *   Estimated total: ~3.3 GB.
 *
 * Launch:  ns.exec('/cross/player_sequencer.js', 'home', 1)
 *          (auto-launched by bootstrap.ts at EARLY phase when home ≥ brainRamFloorGb)
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Port opener executables — all five needed for full network access. */
const PORT_OPENER_FILES = [
	'BruteSSH.exe',
	'FTPCrack.exe',
	'relaySMTP.exe',
	'HTTPWorm.exe',
	'SQLInject.exe',
] as const;

/** Re-check SF4 every N ticks if not found (60 × 5 s ≈ 5 min at default cadence). */
const SF4_RECHECK_INTERVAL = 60;

/** How long a "Defer" verdict suppresses the aug/reset decision (12 × 5 s ≈ 1 min). */
const DECISION_DEFER_TICKS = 12;

/** Stable id for the (single) aug-purchase/reset judgment call. */
const AUG_DECISION_ID = 'augReset';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check whether the player owns Source-File 4 (Singularity).
 * Runs the check inside a temp dodger script so the 16 GB Singularity cost
 * is paid by the dodger, not by this daemon.
 */
async function checkSf4(ns: NS): Promise<boolean> {
	const result = await executeCommand<boolean>(
		ns,
		'ns.singularity.getOwnedSourceFiles().some(sf => sf.n === 4)',
	);
	return result === true;
}

/** Count how many port-opener .exe files currently exist on home. */
function countOpeners(ns: NS): number {
	return PORT_OPENER_FILES.filter(f => ns.fileExists(f, 'home')).length;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');
	ns.print('Player sequencer started');

	// ── One-time startup: cache SF4 (stable within a node) ───────────────────
	let sf4 = await checkSf4(ns);
	ns.print(sf4
		? 'SF4 detected — trusted actions enabled'
		: 'SF4 not found — idling until available');

	// SF4 absence notification guard — fire once, not every tick
	let sf4NotifiedOnce = false;

	// ── faction_manager crash-guard state ─────────────────────────────────────
	let fmKnownAlive    = false;  // true when we confirmed it running last tick
	let fmFailCount     = 0;      // unexpected exits observed; reset when alive
	let lastFactionCount = 0;     // for progress logging

	// ── program_acquirer verification state ───────────────────────────────────
	// paLastOpenerCount >= 0 means a run finished and is pending read-back.
	let paLastOpenerCount = -1;   // opener count captured at last launch
	let paRetryCount      = 0;    // consecutive runs with no new openers

	// ── Aug/reset decision suppression (Step D — DecisionsPanel) ──────────────
	let augDeniedAtAugs   = -1;   // deny → don't re-surface until pendingAugs exceeds this
	let augDeferUntilTick = 0;    // defer → don't re-surface until this tick

	let tick = 0;

	while (true) {
		tick++;

		const settings    = loadSettings(ns);
		const phase       = peekPort(ns, PORT_PHASE) as DesignPhase | null;
		const player      = ns.getPlayer();
		const pendingAugs = parseInt(peekPort(ns, PORT_AUGS) ?? '0', 10);

		// Re-check SF4 periodically — only when still absent (it never reverts)
		if (!sf4 && tick % SF4_RECHECK_INTERVAL === 0) {
			sf4 = await checkSf4(ns);
			if (sf4) ns.print('SF4 now detected — trusted actions enabled');
		}

		// ── Apply human/MCP verdicts on the aug/reset decision ────────────────
		// Responders (control console, MCP agent) push to PORT_DECISION_REPLY; we
		// own applying the verdict and clearing the pending entry (lib/decisions.ts).
		for (const reply of drainReplies(ns)) {
			if (reply.id !== AUG_DECISION_ID) continue;
			removePending(ns, AUG_DECISION_ID);
			if (reply.verdict === 'approve') {
				if (!ns.isRunning(SCRIPT_PATHS.augPlanner, 'home')) {
					const pid = ns.run(SCRIPT_PATHS.augPlanner, 1, '--purchase');
					ns.print(pid > 0
						? `DECISION approved — aug_planner --purchase launched (pid ${pid})`
						: 'WARN: aug_planner --purchase failed to start on approval');
				}
			} else if (reply.verdict === 'deny') {
				augDeniedAtAugs = pendingAugs;
				ns.print(`DECISION denied — aug/reset suppressed until augs exceed ${pendingAugs}`);
			} else if (reply.verdict === 'defer') {
				augDeferUntilTick = tick + DECISION_DEFER_TICKS;
				ns.print(`DECISION deferred — re-surfacing in ${DECISION_DEFER_TICKS} ticks`);
			}
		}

		// ── RESET handling (judgment item) ────────────────────────────────────
		//
		// Trigger: phase == RESET (from phase_detector) OR pendingAugs crosses
		// PHASE_RESET_MIN_AUGS directly from PORT_AUGS (belt-and-suspenders).
		// Default: notify-only (autoBuyAugs+autoReset both OFF).
		if (phase === DesignPhase.RESET || pendingAugs >= PHASE_RESET_MIN_AUGS) {
			if (settings.autoBuyAugs && settings.autoReset) {
				// Full auto-reset — intentionally gated behind BOTH switches.
				// Clear any decision surfaced before the switches were flipped to auto.
				removePending(ns, AUG_DECISION_ID);
				if (!ns.isRunning(SCRIPT_PATHS.augPlanner, 'home')) {
					const pid = ns.run(SCRIPT_PATHS.augPlanner, 1, '--purchase');
					ns.print(pid > 0
						? `AUTO: aug_planner --purchase launched (${pendingAugs} augs pending, pid ${pid})`
						: 'WARN: aug_planner --purchase failed to start');
				}
			} else {
				// Surface as a pending decision (Approve/Deny/Defer). The control
				// console and the MCP agent both read status/decisions_pending.json
				// and reply via PORT_DECISION_REPLY (drained above). Suppressed while
				// a prior Deny (until more augs) or Defer (cooldown) is in effect.
				const suppressed = pendingAugs <= augDeniedAtAugs || tick < augDeferUntilTick;
				if (!suppressed) {
					const added = upsertPending(ns, {
						id: AUG_DECISION_ID,
						kind: 'augReset',
						prompt: `${pendingAugs} augmentations affordable — buy and reset?`,
						command: 'run /player/aug_planner.js --purchase',
						context: { pendingAugs, money: player.money },
						ts: Date.now(),
					});
					// Ping the notification feed once, when first surfaced (not every tick).
					if (added) {
						notify(
							ns,
							`${pendingAugs} augmentations affordable — buy and reset?`,
							'run /player/aug_planner.js --purchase',
							{ pendingAugs, money: player.money },
						);
					}
				}
			}
			await ns.sleep(settings.tickIntervalMs);
			continue;  // skip trusted-action block while reset is pending
		}

		// Reset condition not active — drop any stale aug/reset decision.
		removePending(ns, AUG_DECISION_ID);

		// ── Pre-SF4: idle + notify once ───────────────────────────────────────
		if (!sf4) {
			if (!sf4NotifiedOnce) {
				notify(
					ns,
					'SF4 (Source-File 4) required for player automation — earn it to enable faction and program management',
				);
				sf4NotifiedOnce = true;
			}
			await ns.sleep(settings.tickIntervalMs);
			continue;
		}

		// ── Trusted actions (SF4 present) ─────────────────────────────────────

		// ── faction_manager — persistent daemon ───────────────────────────────
		//
		// Verify: check player.factions growth each tick.
		// Crash-guard: relaunch once on unexpected exit; notify on second failure.
		if (settings.autoJoinFactions) {
			const fmAlive = ns.isRunning(SCRIPT_PATHS.factionManager, 'home');

			if (fmAlive) {
				fmKnownAlive = true;
				fmFailCount  = 0;
				const n = player.factions.length;
				if (n > lastFactionCount) {
					ns.print(`Factions: ${lastFactionCount} → ${n} (+${n - lastFactionCount} joined)`);
					lastFactionCount = n;
				}
			} else {
				if (fmKnownAlive) {
					// Was alive last tick — unexpected exit
					fmKnownAlive = false;
					fmFailCount++;
					ns.print(`WARN: faction_manager exited unexpectedly (failure #${fmFailCount})`);
					if (fmFailCount >= 2) {
						notify(
							ns,
							'faction_manager has exited twice — check script logs or RAM headroom',
							undefined,
							{ failCount: fmFailCount },
						);
					}
				}
				// Relaunch if under the notify threshold (first launch OR first retry)
				if (fmFailCount < 2) {
					const pid = ns.run(SCRIPT_PATHS.factionManager, 1);
					if (pid > 0) {
						ns.print(`faction_manager launched (pid ${pid})`);
						fmKnownAlive = true;
					} else {
						ns.print('WARN: faction_manager failed to start — insufficient RAM?');
					}
				}
			}
		}

		// ── program_acquirer — one-shot with built-in single-instance guard ───
		//
		// Verify: check opener count after the script exits.
		// Retry-once: relaunch if no new openers; notify on second miss.
		if (settings.autoBuyPrograms) {
			const openerCount = countOpeners(ns);

			if (openerCount < PORT_OPENER_FILES.length) {
				const paAlive = ns.isRunning(SCRIPT_PATHS.programAcquirer, 'home');

				if (paAlive) {
					// Running — let it finish; check again next tick

				} else if (paLastOpenerCount >= 0) {
					// Finished since last tick — verify progress
					if (openerCount > paLastOpenerCount) {
						ns.print(`Openers: ${paLastOpenerCount} → ${openerCount} / ${PORT_OPENER_FILES.length}`);
						paRetryCount = 0;
					} else {
						paRetryCount++;
						ns.print(
							`WARN: program_acquirer: no new openers ` +
							`(${openerCount}/${PORT_OPENER_FILES.length}), run #${paRetryCount}`,
						);
						if (paRetryCount >= 2) {
							notify(
								ns,
								`program_acquirer: no new port openers after ${paRetryCount} runs — check money or TOR router`,
								undefined,
								{ openersHave: openerCount, openersTotal: PORT_OPENER_FILES.length },
							);
							paRetryCount = 0;
						}
					}
					paLastOpenerCount = -1;  // clear → will relaunch next tick if still needed

				} else {
					// Not running and no pending verification — launch
					paLastOpenerCount = openerCount;
					const pid = ns.run(SCRIPT_PATHS.programAcquirer, 1);
					if (pid > 0) {
						ns.print(`program_acquirer launched (pid ${pid}, have ${openerCount}/${PORT_OPENER_FILES.length} openers)`);
					} else {
						ns.print('WARN: program_acquirer failed to start — insufficient RAM?');
						paLastOpenerCount = -1;  // reset so we retry next tick
					}
				}
			}
		}

		await ns.sleep(settings.tickIntervalMs);
	}
}
