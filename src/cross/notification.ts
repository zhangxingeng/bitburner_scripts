import type { NS } from '@ns';
import { PORT_NOTIFY, pushPort } from '../lib/ports';

/**
 * Notification primitives — notify-and-wait pattern (docs/design/00-architecture-philosophy.md §3).
 *
 * When a Player-thread module reaches a decision it cannot or should not make autonomously:
 *   1. Compute the recommended action (with numbers) — caller's responsibility.
 *   2. Call notify() to surface it on PORT_NOTIFY + print to log.
 *   3. Call waitForCondition() or notifyAndWait() to yield until conditions change.
 *
 * All functions are RAM-light: port helpers cost 0 GB; ns.sleep costs 0 GB.
 * Optional file writes (if caller passes ns.write) add ~1 GB — avoid in tight scripts.
 *
 * PORT_NOTIFY consumers: game_agent (drains to status/notifications.json),
 *                        future dashboard (React inject — see docs/design/08-control-console.md;
 *                        docs/archive/ui_plan.md has the original scratch notes).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Notification {
    ts:              number;
    msg:             string;
    recommendation?: string;
    data?:           Record<string, unknown>;
}

// ── Core primitives ───────────────────────────────────────────────────────────

/**
 * Surface a notification on PORT_NOTIFY and print it to the script log.
 * Non-blocking — returns immediately after queueing.
 * RAM cost: 0 GB (port functions only).
 */
export function notify(
    ns:              NS,
    msg:             string,
    recommendation?: string,
    data?:           Record<string, unknown>,
): void {
    const n: Notification = { ts: Date.now(), msg, recommendation, data };
    ns.print(`NOTIFY: ${msg}${recommendation ? ` → ${recommendation}` : ''}`);
    // Best-effort — port may be full if consumer (game_agent) is slow
    pushPort(ns, PORT_NOTIFY, JSON.stringify(n));
}

/**
 * Block until condition() returns true, sleeping intervalMs between checks.
 * Use this when a Player-thread module has nothing else useful to do.
 * Returns the total elapsed wait time in ms.
 *
 * RAM cost: 0 GB (ns.sleep costs 0 GB).
 */
export async function waitForCondition(
    ns:          NS,
    condition:   () => boolean,
    intervalMs = 5000,
): Promise<number> {
    const start = Date.now();
    while (!condition()) {
        await ns.sleep(intervalMs);
    }
    return Date.now() - start;
}

/**
 * Notify then block until condition becomes true (or maxWaitMs elapses).
 * Re-notifies every remindIntervalMs so stale notifications don't go unnoticed.
 * Returns true if condition was met before the timeout, false otherwise.
 *
 * RAM cost: 0 GB.
 */
export async function notifyAndWait(
    ns:               NS,
    msg:              string,
    condition:        () => boolean,
    recommendation?:  string,
    data?:            Record<string, unknown>,
    intervalMs    = 5000,
    maxWaitMs     = 300000,  // 5-minute default timeout
    remindEveryMs = 30000,
): Promise<boolean> {
    notify(ns, msg, recommendation, data);
    const start = Date.now();
    let lastReminder = start;

    while (!condition()) {
        const now = Date.now();
        if (now - start > maxWaitMs) return false;

        // Periodic reminder so the notification stays visible in the log
        if (now - lastReminder >= remindEveryMs) {
            ns.print(`NOTIFY (still waiting): ${msg}`);
            lastReminder = now;
        }

        await ns.sleep(intervalMs);
    }
    return true;
}
