import { NS } from '@ns';

// ── Phase boundary constants ──────────────────────────────────────────────────
// Tunable thresholds for the phase state machine (see docs/design/02-system-architecture.md §1).
// All numeric values are in GB (RAM) or raw counts unless noted.

/** Home RAM at which the game begins — BOOTSTRAP phase. */
export const PHASE_RAM_BOOTSTRAP = 8;
/** Home RAM threshold to leave BOOTSTRAP and enter EARLY. */
export const PHASE_RAM_EARLY = 16;
/** Home RAM threshold to enter MID (HWGW batching becomes viable). */
export const PHASE_RAM_MID = 64;
/** Home RAM threshold to enter LATE (side-engines viable, SF4 expected). */
export const PHASE_RAM_LATE = 512;

/** Minimum rooted servers before SNOWBALL/EARLY is considered active. */
export const PHASE_ROOTED_EARLY = 5;
/** Minimum hacking level before EARLY strategy activates. */
export const PHASE_HACK_EARLY = 50;

/** Minimum new augmentations available before RESET is recommended. */
export const PHASE_RESET_MIN_AUGS = 10;

// ── Global RAM budgets and reserves ──────────────────────────────────────────

/** Fraction of home RAM to keep free (not assigned to workers). */
export const HOME_RAM_RESERVE_FRACTION = 0.25;
/** Maximum GB to reserve on home regardless of the fraction. */
export const HOME_RAM_RESERVE_MAX = 128;
/** Minimum GB to reserve on home (hard floor; overrides the fraction). */
export const HOME_RAM_RESERVE_MIN = 100;
/** Minimum server RAM (GB) before a server is used for workers. */
export const MIN_SERVER_RAM = 2;
/** Whether to include home in the worker pool. */
export const HOME_RAM_USE = true;

// ── Targeting thresholds ──────────────────────────────────────────────────────

/** Money fraction at which a server is considered "prepared" for batch hacking. */
export const TARGET_MONEY_THRESHOLD = 0.9;
/** Security above minDifficulty at which a server is still "prepared". */
export const TARGET_SECURITY_THRESHOLD = 3;
/** Maximum number of simultaneous hack targets. */
export const MAX_TARGETS = 4;

// ── Script paths ─────────────────────────────────────────────────────────────
export const SCRIPT_PATHS = {
    // workers/ — ultra-thin HGW compute nodes (Phase 2b)
    hack:           '/workers/hack.js',
    weaken:         '/workers/weaken.js',
    weaken1:        '/workers/weaken.js',
    weaken2:        '/workers/weaken.js',
    grow:           '/workers/grow.js',
    autoGrow:       '/workers/auto_grow.js',
    share:          '/workers/share.js',
    simpleHackLoop: '/workers/simple_hack_loop.js',
    // compute/ — orchestrators and infrastructure daemons
    coordinator:    '/compute/coordinator.js',
    pservManager:   '/compute/pserv_manager.js',
    hacknetManager: '/compute/hacknet_manager.js',
    spreader:       '/compute/spreader.js',
} as const;

/** Base RAM cost per worker script thread (GB). */
export const SCRIPT_RAM_COST = 1.75;

// ── Batch operation constants ─────────────────────────────────────────────────

/** Milliseconds between sequential HWGW operations within a single batch. */
export const BATCH_STEP_TIME = 20;
/** Maximum parallel batch instances per target. -1 = auto-size by hack time. */
export const BATCH_MAX_CONCURRENCY = -1;
/** Maximum hack threads per batch. -1 = auto binary-search up to 100. */
export const BATCH_MAX_HACK_PER_BATCH = -1;

// ── Security impact constants (Bitburner game mechanics) ──────────────────────

/** Security increase per hack thread. */
export const HACK_SECURITY_INCREASE = 0.002;
/** Security increase per grow thread. */
export const GROW_SECURITY_INCREASE = 0.004;
/** Security decrease per weaken thread. */
export const WEAKEN_SECURITY_DECREASE = 0.05;

// ── Execution options ─────────────────────────────────────────────────────────

/** Enable verbose per-operation logging. */
export const EXEC_DEBUG = false;
/** Suppress toast messages when operations misfire (start late). */
export const EXEC_SILENT_MISFIRES = true;

// ── Maintenance intervals (seconds) ──────────────────────────────────────────

export const INTERVAL_NUKE_S            = 60;
export const INTERVAL_PORT_OPENER_S     = 30;
export const INTERVAL_SERVER_PURCHASE_S = 300;
export const INTERVAL_UPGRADE_HOME_S    = 60;
export const INTERVAL_SHARE_S           = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute the effective home RAM reservation from the configured percentages and limits.
 * @param ns            NetScript API (needed for home max RAM).
 * @param minOverride   Optional minimum override (from --homeRam CLI flag).
 */
export function calcHomeRamReservation(ns: NS, minOverride?: number): number {
    const homeMaxRam = ns.getServerMaxRam('home');
    const minReserve = minOverride ?? HOME_RAM_RESERVE_MIN;
    return Math.max(
        Math.min(homeMaxRam * HOME_RAM_RESERVE_FRACTION, HOME_RAM_RESERVE_MAX),
        minReserve,
    );
}
