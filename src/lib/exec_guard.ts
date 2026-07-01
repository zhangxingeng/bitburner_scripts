import type { NS } from '@ns';
import { Priority } from './config';
import { execMulti } from '../compute/exec_multi';
import { getReservedRam, publishPressure, clearPressure } from './machine_status';
import { PORT_NOTIFY, pushPort } from './ports';

/**
 * Shared safe-launch primitive (docs/design/14, dynamic brain layer).
 *
 * Wraps `compute/exec_multi.ts::execMulti` — does not replace it. Every caller
 * that wants budget-aware, priority-tiered launching goes through `requestRun`
 * instead of calling `ns.exec`/`execMulti` directly; the underlying exec/thread-
 * clamp mechanics are unchanged.
 *
 * Behavior by priority tier when the request doesn't fit as-is:
 *   BRAIN          — publishes a pressure signal (lower tiers react to it — see
 *                     hwgw_batcher's kill-on-pressure and coordinator's shrink-on-
 *                     pressure hooks) and retries with backoff for a BOUNDED
 *                     window (not forever — a script that blocks indefinitely
 *                     inside one call can't do anything else meanwhile). If it
 *                     still doesn't fit after the window, this is a genuine
 *                     hard-OOM: push a notification (PORT_NOTIFY) so it surfaces
 *                     rather than silently failing, leave the pressure signal
 *                     published, and return ok:false — the caller's own tick
 *                     loop re-invoking requestRun next tick is what "keeps
 *                     retrying in the background" without blocking the script.
 *   everything else — publish the same pressure signal (so a higher tier's
 *                     BRAIN-tier request can see contention even from a non-
 *                     BRAIN caller), then try reduce-to-fit once (delegates to
 *                     execMulti's own clamp-to-available-RAM behavior) and
 *                     return immediately — no blocking.
 */

export interface RunRequest {
	script:       string;
	/** Defaults to 'home' — every current caller (hwgw_batcher, coordinator,
	 *  player_sequencer) already knows its target host explicitly. */
	host?:        string;
	threads:      number;
	priority:     Priority;
	args?:        (string | number | boolean)[];
	/** Floor for reduce-to-fit; below this, a non-BRAIN request fails instead
	 *  of running a near-useless thread count. Defaults to 1. */
	minThreads?:  number;
	/** Attribution for the pressure signal. Defaults to `script`. */
	requesterId?: string;
}

export type RunReason = 'ok' | 'reduced' | 'preempted-others' | 'timeout' | 'no-candidate-host';

export interface RunResult {
	ok:             boolean;
	pid:            number;
	threadsGranted: number;
	reason:         RunReason;
}

/** Backoff schedule for BRAIN-tier retries (ms between attempts). Bounded —
 *  see the "why not retry forever" note in the module doc above. */
const BRAIN_RETRY_BACKOFF_MS = [250, 500, 1000, 2000, 2000];

function freeRamOnHost(ns: NS, host: string): number {
	const maxRam  = ns.getServerMaxRam(host);
	const usedRam = ns.getServerUsedRam(host);
	const reserved = getReservedRam(ns, host, { maxRamOverride: maxRam });
	return Math.max(0, maxRam - usedRam - reserved);
}

function maxThreadsFor(ns: NS, host: string, scriptRam: number): number {
	if (scriptRam <= 0) return 0;
	return Math.floor(freeRamOnHost(ns, host) / scriptRam);
}

function notifyHardOom(ns: NS, req: RunRequest, host: string, requestedGb: number): void {
	ns.print(`NOTIFY: requestRun hard-OOM — ${req.script} needs ${requestedGb.toFixed(2)}GB on ${host}, ` +
		`none freed after preemption window`);
	pushPort(ns, PORT_NOTIFY, JSON.stringify({
		ts: Date.now(),
		msg: `requestRun: ${req.script} (BRAIN) could not get ${requestedGb.toFixed(2)}GB on ${host} ` +
			`even after preempting lower-priority work`,
		recommendation: 'Check free RAM / upgrade home RAM / reduce concurrent daemon load',
		data: { script: req.script, host, requestedGb, priority: req.priority },
	}));
}

/** The shared safe-launch primitive. See module doc for per-tier behavior. */
export async function requestRun(ns: NS, req: RunRequest): Promise<RunResult> {
	const host        = req.host ?? 'home';
	const minThreads  = req.minThreads ?? 1;
	const requesterId = req.requesterId ?? req.script;

	if (!ns.serverExists(host)) {
		return { ok: false, pid: 0, threadsGranted: 0, reason: 'no-candidate-host' };
	}

	const scriptRam = ns.getScriptRam(req.script);
	if (scriptRam <= 0) {
		return { ok: false, pid: 0, threadsGranted: 0, reason: 'no-candidate-host' };
	}

	const requestedGb = scriptRam * req.threads;
	const fits = maxThreadsFor(ns, host, scriptRam) >= req.threads;

	if (fits) {
		const pid = execMulti(ns, host, req.threads, req.script, ...(req.args ?? []));
		if (pid > 0) return { ok: true, pid, threadsGranted: req.threads, reason: 'ok' };
		return { ok: false, pid: 0, threadsGranted: 0, reason: 'no-candidate-host' };
	}

	// Doesn't fit as-is — publish contention so reactors (hwgw_batcher's
	// kill-on-pressure, coordinator's shrink-on-pressure) can see it regardless
	// of which tier is asking.
	publishPressure(ns, host, { requestedGb, priority: req.priority, requesterId, ts: Date.now() });

	if (req.priority === Priority.BRAIN) {
		for (const backoffMs of BRAIN_RETRY_BACKOFF_MS) {
			await ns.sleep(backoffMs);
			if (maxThreadsFor(ns, host, scriptRam) >= req.threads) {
				const pid = execMulti(ns, host, req.threads, req.script, ...(req.args ?? []));
				if (pid > 0) {
					clearPressure(ns, host);
					return { ok: true, pid, threadsGranted: req.threads, reason: 'preempted-others' };
				}
			}
		}
		// Bounded window exhausted — genuine hard-OOM. Leave the pressure signal
		// published (lower tiers keep shedding) and let the caller's own tick
		// loop retry; that's the "keep retrying in the background" behavior.
		notifyHardOom(ns, req, host, requestedGb);
		return { ok: false, pid: 0, threadsGranted: 0, reason: 'timeout' };
	}

	// Non-BRAIN: one reduce-to-fit attempt, no blocking.
	const actualThreads = maxThreadsFor(ns, host, scriptRam);
	if (actualThreads >= minThreads) {
		const pid = execMulti(ns, host, actualThreads, req.script, ...(req.args ?? []));
		if (pid > 0) {
			clearPressure(ns, host);
			return { ok: true, pid, threadsGranted: actualThreads, reason: 'reduced' };
		}
	}
	return { ok: false, pid: 0, threadsGranted: 0, reason: actualThreads > 0 ? 'timeout' : 'no-candidate-host' };
}
