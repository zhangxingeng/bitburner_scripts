import type { NS } from '@ns';

// ── Named port channels ──────────────────────────────────────────────────────
// Ports 1–4 carry the existing boot-agent IPC and heartbeat protocol.
// Ports 5–9 are reserved for the future Zharay-style task-event bus (Phase 3).

/** boot_agent reads JSON commands from this port. */
export const PORT_CMD = 1;
/** boot_agent writes JSON results to this port. */
export const PORT_RESULT = 2;
/** strategy_agent sends heartbeat ticks here; boot_agent peeks it. */
export const PORT_HEARTBEAT = 3;
/** strategy_agent writes phase decisions/intent here; game_agent drains it. */
export const PORT_DECISION = 4;

// Future bus channels — reserve now, implement in Phase 3
/** Bus: daemon self-registration events. */
export const PORT_BUS_REGISTER = 5;
/** Bus: distributed lock acquire/release events. */
export const PORT_BUS_LOCK = 6;
/** Bus: task START/DONE accounting events. */
export const PORT_BUS_TASK = 7;
/** Bus: phase-detector publishes current Phase enum value here. */
export const PORT_PHASE = 8;
/** Bus: notification channel (user-facing alerts). */
export const PORT_NOTIFY = 9;
/** Stock engine publishes current positions here each cycle for coordinator coupling. */
export const PORT_STOCK = 10;
/** aug_planner publishes count of affordable/pending augmentations here (read by phase_detector). */
export const PORT_AUGS  = 11;
/** Raw terminal-command strings → game_agent pops and injects via cross/launcher. */
export const PORT_LAUNCHER = 12;

// ── Sentinel returned by readPort/peek when a port is empty ─────────────────
const NULL_DATA = 'NULL PORT DATA';

// ── Thin helpers (port functions cost 0 GB — keep helpers free of logic) ─────

/** Peek at the top of a port without consuming it. Returns null if empty. */
export function peekPort(ns: NS, port: number): string | null {
    const val = ns.peek(port);
    return val === NULL_DATA ? null : String(val);
}

/** Pop (consume) the top message from a port. Returns null if empty. */
export function popPort(ns: NS, port: number): string | null {
    const val = ns.readPort(port);
    return val === NULL_DATA || val === null || val === '' ? null : String(val);
}

/** Push a message onto a port. Returns false if the port queue is full. */
export function pushPort(ns: NS, port: number, data: string): boolean {
    return ns.writePort(port, data);
}

/** Clear all messages from a port. */
export function clearPort(ns: NS, port: number): void {
    ns.clearPort(port);
}
