import type { NS } from '@ns';
import { PORT_PHASE, PORT_AUGS, peekPort } from '../lib/ports';
import { DesignPhase, PHASE_RESET_MIN_AUGS, SCRIPT_PATHS } from '../lib/config';
import { loadSettings } from '../lib/settings';
import { notify } from '../cross/notification';
import { executeCommand } from '../lib/ns_dodge';
import { hasSF4 } from '../lib/sf_check';
import { savePlayerState } from '../lib/player_state';
import { upsertPending, removePending, drainReplies } from '../lib/decisions';
import { PLAYER_MANAGERS } from '../lib/manager_registry';

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
 *          (auto-launched by brain.ts at EARLY phase when home ≥ brainRamFloorGb)
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

/** Per-manager crash-guard state for the generalized registry walk (design/11). */
const managerState = new Map<string, { knownAlive: boolean; failCount: number }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count how many port-opener .exe files currently exist on home. */
function countOpeners(ns: NS): number {
	return PORT_OPENER_FILES.filter(f => ns.fileExists(f, 'home')).length;
}

// ── Player-state publisher ────────────────────────────────────────────────────

/**
 * Gather faction/aug/character info via the RAM-dodge and publish a
 * PlayerSnapshot to `status/player_state.json` for the control console to read
 * cheaply (lib/player_state.ts). All Singularity calls run inside ONE batched
 * dodger expression so their 16 GB cost is paid by the temp script, not this
 * daemon. On failure (no SF4, RAM starved, dodger error) we log and leave the
 * prior snapshot untouched — never overwrite with empties.
 */
async function publishPlayerState(ns: NS): Promise<void> {
	try {
		const snap = await executeCommand<{
			factions: string[];
			invitations: string[];
			augsOwned: number;
			augsPending: number;
			hackingLevel: number;
			city: string;
		}>(
			ns,
			`(() => { const p = ns.getPlayer();
				const owned     = ns.singularity.getOwnedAugmentations(false);
				const purchased = ns.singularity.getOwnedAugmentations(true);
				return {
					factions:     p.factions,
					invitations:  ns.singularity.checkFactionInvitations(),
					augsOwned:    owned.length,
					augsPending:  purchased.length - owned.length,
					hackingLevel: p.skills.hacking,
					city:         p.city,
				}; })()`,
		);
		if (snap == null) {
			ns.print('WARN: publishPlayerState: no data returned (SF4 unavailable or script failed)');
			return;
		}
		savePlayerState(ns, { ts: Date.now(), ...snap });
	} catch (err) {
		ns.print(`WARN: publishPlayerState failed — ${err}`);
	}
}

/**
 * Walk the PLAYER_MANAGERS registry (design/11 §3.7). For each subsystem manager:
 * toggle ON → keep the daemon alive (crash-guard: relaunch up to 2 fails, then
 * notify); toggle OFF → ensure it's stopped. Each manager is a persistent daemon
 * that self-guards on SF/BitNode availability and idles when its feature is
 * absent — so "not alive" always means crashed/never-started, never "no SF".
 *
 * This is the ONLY place new subsystem managers are launched; adding one is a
 * registry row + a script, never an edit here (keeps parallel builds disjoint).
 */
function tickManagers(ns: NS, settings: ReturnType<typeof loadSettings>): void {
	for (const spec of PLAYER_MANAGERS) {
		const enabled = settings[spec.settingKey] === true;
		const st = managerState.get(spec.id) ?? { knownAlive: false, failCount: 0 };
		const alive = ns.isRunning(spec.path, 'home');

		if (enabled) {
			if (alive) {
				st.knownAlive = true;
				st.failCount = 0;
			} else {
				if (st.knownAlive) {
					st.knownAlive = false;
					st.failCount++;
					ns.print(`WARN: ${spec.label} manager exited unexpectedly (failure #${st.failCount})`);
					if (st.failCount >= 2) {
						notify(ns, `${spec.label} manager has exited twice — check its log or RAM headroom`, undefined, { id: spec.id });
					}
				}
				if (st.failCount < 2) {
					const pid = ns.run(spec.path, 1);
					if (pid > 0) {
						ns.print(`${spec.label} manager launched (pid ${pid})`);
						st.knownAlive = true;
					} else {
						ns.print(`WARN: ${spec.label} manager failed to start — insufficient RAM?`);
					}
				}
			}
		} else {
			// Disabled — ensure the daemon is stopped and reset its guard state.
			if (alive) {
				ns.kill(spec.path, 'home');
				ns.print(`${spec.label} manager stopped (toggle off)`);
			}
			st.knownAlive = false;
			st.failCount = 0;
		}
		managerState.set(spec.id, st);
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
	ns.disableLog('ALL');
	ns.print('Player sequencer started');

	// ── One-time startup: cache SF4 (stable within a node) ───────────────────
	let sf4 = hasSF4(ns);
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
			sf4 = hasSF4(ns);
			if (sf4) ns.print('SF4 now detected — trusted actions enabled');
		}

		// Subsystem managers (design/11) — toggle-gated, SF-independent (each self-
		// guards on its own SF/BitNode). Walked every tick, before the SF4 gate and
		// the reset/continue branches, so they're maintained in all loop states.
		tickManagers(ns, settings);

		// ── Apply human/MCP verdicts on the aug/reset decision ────────────────
		// Responders (control console, MCP agent) push to PORT_DECISION_REPLY; we
		// own applying the verdict and clearing the pending entry (lib/decisions.ts).
		for (const reply of drainReplies(ns)) {
			if (reply.id !== AUG_DECISION_ID) continue;
			removePending(ns, AUG_DECISION_ID);
			if (reply.verdict === 'approve') {
				// --install implies --purchase and installs (resets) on a fully-successful
				// buy — matches what the decision prompt actually asked ("buy and reset?").
				if (!ns.isRunning(SCRIPT_PATHS.augPlanner, 'home')) {
					const pid = ns.run(SCRIPT_PATHS.augPlanner, 1, '--install');
					ns.print(pid > 0
						? `DECISION approved — aug_planner --install launched (pid ${pid})`
						: 'WARN: aug_planner --install failed to start on approval');
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
				// --install implies --purchase and, on a fully-successful buy, calls
				// ns.singularity.installAugmentations(brain.js) — the actual soft-reset
				// trigger, with brain.js as the post-reset callback so the loop resumes
				// unattended (aug_planner.ts's own doc comment has the full contract).
				// Clear any decision surfaced before the switches were flipped to auto.
				removePending(ns, AUG_DECISION_ID);
				if (!ns.isRunning(SCRIPT_PATHS.augPlanner, 'home')) {
					const pid = ns.run(SCRIPT_PATHS.augPlanner, 1, '--install');
					ns.print(pid > 0
						? `AUTO: aug_planner --install launched (${pendingAugs} augs pending, pid ${pid})`
						: 'WARN: aug_planner --install failed to start');
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
						command: 'run /player/aug_planner.js --install',
						context: { pendingAugs, money: player.money },
						ts: Date.now(),
					});
					// Ping the notification feed once, when first surfaced (not every tick).
					if (added) {
						notify(
							ns,
							`${pendingAugs} augmentations affordable — buy and reset?`,
							'run /player/aug_planner.js --install',
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

		// ── player-state publisher (slow cadence: startup + every 6 ticks ≈ 30 s) ──
		//
		// Feeds the control console's FactionsPanel (status/player_state.json).
		// Singularity cost is borne by the temp dodger — ~0 GB to this daemon.
		// Failure is silent (prior snapshot kept); never crashes the sequencer.
		if (tick % 6 === 1) {
			await publishPlayerState(ns);
		}

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
