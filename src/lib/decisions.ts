import type { NS } from '@ns';
import { PORT_DECISION_REPLY, popPort, pushPort } from './ports';

/**
 * Shared decision-queue contract (docs/design/08-control-console.md §4.3 / §6).
 *
 * THE single source of truth so the in-game DecisionsPanel and the remote MCP
 * agent consume the *same* queue — not two divergent ones. Two halves:
 *
 *  1. Pending decisions — a status FILE (`status/decisions_pending.json`), owned
 *     and maintained by the PRODUCER (player_sequencer). A file (not a port)
 *     because multiple responders need the same persistent view, and a port pop
 *     would let one consumer steal an item the other never sees.
 *  2. Replies — a PORT (`PORT_DECISION_REPLY`). Responders (console / MCP) push
 *     a verdict; the producer pops and applies, then clears the pending entry.
 *
 * Capability boundary: responders only *emit* a verdict. They never act on a
 * decision or mutate pending state — the producer owns that (§3).
 *
 * NOTE: distinct from the existing PORT_DECISION (port 4) transition LOG, which
 * game_agent mirrors to `status/decisions.json`. Different file, different job.
 */

export type DecisionKind = 'augReset' | 'bitNode' | 'spend' | 'generic';
export type Verdict = 'approve' | 'deny' | 'defer';

/** A judgment call awaiting a human (or MCP) verdict. `id` is stable per logical decision. */
export interface PendingDecision {
	id: string;
	kind: DecisionKind;
	prompt: string;                       // human-readable question
	command?: string;                     // suggested terminal command / action hint
	context?: Record<string, unknown>;    // structured detail (counts, money…)
	ts: number;                           // ms epoch first surfaced
}

/** A verdict on a pending decision, correlated by `id`. */
export interface DecisionReply {
	id: string;
	verdict: Verdict;
}

const PENDING_FILE = 'status/decisions_pending.json';

// ── Pending queue (file; producer-owned) ──────────────────────────────────────

/** Read the pending-decision list. Missing/corrupt file → []. Never throws. */
export function loadPending(ns: NS): PendingDecision[] {
	try {
		const raw = ns.read(PENDING_FILE);
		if (!raw || raw.trim() === '') return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as PendingDecision[]) : [];
	} catch {
		return [];
	}
}

/** Overwrite the pending-decision list. */
export function savePending(ns: NS, list: PendingDecision[]): void {
	ns.write(PENDING_FILE, JSON.stringify(list, null, 2), 'w');
}

/**
 * Add `d` if no entry with its `id` exists yet (idempotent — re-surfacing the
 * same logical decision each tick won't duplicate it or reset its timestamp).
 * Returns true if it was newly added.
 */
export function upsertPending(ns: NS, d: PendingDecision): boolean {
	const list = loadPending(ns);
	if (list.some(x => x.id === d.id)) return false;
	list.push(d);
	savePending(ns, list);
	return true;
}

/** Remove the pending decision with `id` (no-op if absent). */
export function removePending(ns: NS, id: string): void {
	const list = loadPending(ns);
	const next = list.filter(x => x.id !== id);
	if (next.length !== list.length) savePending(ns, next);
}

// ── Replies (port; responder → producer) ──────────────────────────────────────

/** Responder side: emit a verdict on a decision. */
export function pushReply(ns: NS, reply: DecisionReply): boolean {
	return pushPort(ns, PORT_DECISION_REPLY, JSON.stringify(reply));
}

/** Producer side: drain all pending replies (FIFO). Malformed entries are skipped. */
export function drainReplies(ns: NS): DecisionReply[] {
	const out: DecisionReply[] = [];
	let raw = popPort(ns, PORT_DECISION_REPLY);
	while (raw !== null) {
		try {
			const r = JSON.parse(raw) as DecisionReply;
			if (r && typeof r.id === 'string' && typeof r.verdict === 'string') out.push(r);
		} catch { /* skip malformed */ }
		raw = popPort(ns, PORT_DECISION_REPLY);
	}
	return out;
}
