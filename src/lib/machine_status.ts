import type { NS } from '@ns';
import { Priority, HOME_RAM_RESERVE_FRACTION, HOME_RAM_RESERVE_MAX, HOME_RAM_RESERVE_MIN } from './config';

/**
 * Per-machine RAM budget + preemption signal (docs/design/14, dynamic brain layer).
 *
 * One status file per host: `status/machines/<hostname>.json`. `home` doubles as
 * the master/global file — it's where brain.ts and most ESSENTIAL daemons live,
 * so its `pressure` field also carries system-wide signals (see publishPressure).
 *
 * This is the ONLY module that reads/writes these files — `RamManager`,
 * `coordinator.ts`, and `exec_guard.ts` all go through here rather than each
 * re-deriving the reservation formula (that used to be copy-pasted three times:
 * lib/config.ts::calcHomeRamReservation, RamManager::calcHomeReservation, and an
 * inline copy in compute/coordinator.ts).
 *
 * Only `ns.read`/`ns.write` are used — both ~0 GB via the file API.
 */

export interface PressureSignal {
	/** GB the blocked requester still needs. */
	requestedGb: number;
	/** Priority tier of the blocked requester (BRAIN publishes; lower tiers react). */
	priority:    Priority;
	/** Free-form id of whoever published this (e.g. 'brain', 'daemon_launcher'). */
	requesterId: string;
	/** ms epoch when published. Consumers should treat stale (old) signals as cleared. */
	ts:          number;
}

export interface MachineStatus {
	/** Fraction of this host's max RAM to keep reserved (not assigned to workers). */
	reserveFraction: number;
	/** Hard floor GB to reserve regardless of the fraction. */
	reserveFloorGb:  number;
	/** Optional cap on the fraction-derived reservation (GB). */
	reserveMaxGb?:   number;
	/** Present when a higher-priority requester is currently blocked on this host. */
	pressure?:       PressureSignal;
}

const DIR = 'status/machines';
const fileFor = (host: string): string => `${DIR}/${host}.json`;

/**
 * Default budget for a host with no status file yet. `home` preserves today's
 * behavior exactly (HOME_RAM_RESERVE_* constants); every other host reserves
 * nothing, matching current RamManager behavior where non-home servers are
 * 100% available once rooted.
 */
function defaultFor(host: string): MachineStatus {
	if (host === 'home') {
		return {
			reserveFraction: HOME_RAM_RESERVE_FRACTION,
			reserveFloorGb:  HOME_RAM_RESERVE_MIN,
			reserveMaxGb:    HOME_RAM_RESERVE_MAX,
		};
	}
	return { reserveFraction: 0, reserveFloorGb: 0 };
}

/** Read one host's status. Missing/corrupt → host default. Never throws. */
export function loadMachineStatus(ns: NS, host: string): MachineStatus {
	try {
		const raw = ns.read(fileFor(host));
		if (!raw || raw.trim() === '') return defaultFor(host);
		const parsed = JSON.parse(raw) as Partial<MachineStatus>;
		return { ...defaultFor(host), ...parsed };
	} catch {
		return defaultFor(host);
	}
}

/** Producer side: persist a host's full status (overwrite mode). */
export function saveMachineStatus(ns: NS, host: string, status: MachineStatus): void {
	ns.write(fileFor(host), JSON.stringify(status, null, 2), 'w');
}

/**
 * Write the default budget file for `host` if it doesn't exist yet. Idempotent;
 * safe to call every tick. brain.ts calls this once for 'home' on boot — build
 * only what's load-bearing today (see plan) rather than writing every rooted
 * host up front.
 */
export function ensureDefaultBudget(ns: NS, host = 'home'): void {
	const raw = ns.read(fileFor(host));
	if (!raw || raw.trim() === '') saveMachineStatus(ns, host, defaultFor(host));
}

/**
 * Effective RAM (GB) reserved on `host`, given its current max RAM. Generalizes
 * the old home-only `calcHomeRamReservation`/`RamManager.calcHomeReservation` to
 * any host, reading the per-host budget file instead of hardcoded constants.
 *
 * `floorOverrideGb` supports the `--homeRam` CLI-flag use case (a one-off,
 * unpersisted bump to the floor for a single script invocation) without
 * writing to the status file.
 */
export function getReservedRam(
	ns: NS, host: string,
	opts?: { maxRamOverride?: number; floorOverrideGb?: number },
): number {
	const status = loadMachineStatus(ns, host);
	const maxRam = opts?.maxRamOverride ?? ns.getServerMaxRam(host);
	const floor  = opts?.floorOverrideGb !== undefined
		? Math.max(status.reserveFloorGb, opts.floorOverrideGb)
		: status.reserveFloorGb;
	const byFraction = maxRam * status.reserveFraction;
	const capped = status.reserveMaxGb !== undefined ? Math.min(byFraction, status.reserveMaxGb) : byFraction;
	return Math.max(capped, floor);
}

/** Publish (or overwrite) a pressure signal for `host`. */
export function publishPressure(ns: NS, host: string, signal: PressureSignal): void {
	const status = loadMachineStatus(ns, host);
	status.pressure = signal;
	saveMachineStatus(ns, host, status);
}

/** Clear any pressure signal for `host` (e.g. once the blocked request succeeds). */
export function clearPressure(ns: NS, host: string): void {
	const status = loadMachineStatus(ns, host);
	if (status.pressure) {
		delete status.pressure;
		saveMachineStatus(ns, host, status);
	}
}

/** Read the current pressure signal for `host`, if any. */
export function getPressure(ns: NS, host: string): PressureSignal | undefined {
	return loadMachineStatus(ns, host).pressure;
}
