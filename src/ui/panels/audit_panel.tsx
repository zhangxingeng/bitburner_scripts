import { React } from '../../lib/react';
import type { Panel, ConsoleState } from '../console_types';
import type { Notification } from '../../cross/notification';

/**
 * AuditPanel — full audit trail of notifications / judgment calls (design/11 §3.5).
 *
 * Visually distinct from LogPanel:
 *   • Absolute timestamps  (HH:MM:SS) instead of relative ages ("2m").
 *   • Recommendation lines are EMPHASISED (bold green, full opacity) — they are
 *     the decisions / actions the brain took, not a side-note.
 *   • Entries with a recommendation get a green left-border accent so decision
 *     rows stand out from plain informational notices at a glance.
 *   • `data` keys are rendered as a compact "key=value" line beneath each row.
 *   • Newest-first (copy + reverse; state not mutated).
 *   • Capped at MAX_ROWS entries; scrollable.
 *
 * Pure presentation — never ns.*.
 */

// Maximum rows to render (avoids DOM pressure for very long logs)
const MAX_ROWS = 50;

// ── Timestamp formatter ────────────────────────────────────────────────────────

/** Absolute wall-clock time, e.g. "3:42:07 PM". */
function fmtTime(ts: number): string {
	return new Date(ts).toLocaleTimeString();
}

// ── Data renderer ──────────────────────────────────────────────────────────────

/** Flatten a data bag into a compact "k=v  k=v" string. */
function compactData(data: Record<string, unknown>): string {
	return Object.entries(data)
		.map(([k, v]) => `${k}=${String(v)}`)
		.join('  ');
}

// ── Presentational components ─────────────────────────────────────────────────

const AuditRow = ({ n }: { n: Notification }) => {
	const isAction = !!n.recommendation;
	return (
		<div
			style={{
				padding: '4px 4px 4px 6px',
				borderBottom: '1px solid #1a1a1a',
				// Green accent bar on decision/action rows; invisible on plain notices
				borderLeft: `2px solid ${isAction ? '#4ec94e' : 'transparent'}`,
			}}
		>
			{/* Header: absolute timestamp + message */}
			<div style={{ display: 'flex', gap: '6px', alignItems: 'baseline' }}>
				<span
					style={{
						flexShrink: 0,
						// Green timestamp for action rows, dim for plain notices
						color: isAction ? '#4ec94e' : '#555',
						fontSize: '10px',
						fontFamily: 'monospace',
						minWidth: '62px',
					}}
				>
					{fmtTime(n.ts)}
				</span>
				<span
					style={{
						// Brighter text for action rows
						color: isAction ? '#e0e0e0' : '#999',
						fontSize: '12px',
						fontFamily: 'monospace',
						lineHeight: '1.3',
						wordBreak: 'break-word',
						overflowWrap: 'anywhere',
					}}
				>
					{n.msg}
				</span>
			</div>

			{/* Recommendation — EMPHASISED (bold, full opacity) unlike LogPanel's dimmed italic */}
			{n.recommendation && (
				<div
					style={{
						marginLeft: '68px',
						marginTop: '2px',
						color: '#4ec94e',
						fontSize: '11px',
						fontFamily: 'monospace',
						fontWeight: 'bold',
						lineHeight: '1.3',
						wordBreak: 'break-word',
						overflowWrap: 'anywhere',
					}}
				>
					→ {n.recommendation}
				</div>
			)}

			{/* Compact data key=value pairs when present */}
			{n.data && Object.keys(n.data).length > 0 && (
				<div
					style={{
						marginLeft: '68px',
						marginTop: '2px',
						color: '#6a7a6a',
						fontSize: '10px',
						fontFamily: 'monospace',
						lineHeight: '1.2',
						wordBreak: 'break-word',
						overflowWrap: 'anywhere',
					}}
				>
					{compactData(n.data)}
				</div>
			)}
		</div>
	);
};

const AuditBody = ({ state }: { state: ConsoleState }) => {
	const raw: Notification[] = state.logs ?? [];

	// Copy the last MAX_ROWS entries (oldest-to-newest), then reverse to newest-first.
	// Never mutate state.
	const rows = raw.slice(-MAX_ROWS).reverse();

	if (rows.length === 0) {
		return (
			<div
				style={{
					color: '#555',
					fontFamily: 'monospace',
					fontSize: '12px',
					padding: '6px 0',
					fontStyle: 'italic',
				}}
			>
				No audit entries yet.
			</div>
		);
	}

	return (
		<div
			style={{
				maxHeight: '255px',  // ~15 rows × ~17px each
				overflowY: 'auto',
				overflowX: 'hidden',
			}}
		>
			{rows.map((n) => (
				<AuditRow key={n.ts} n={n} />
			))}
		</div>
	);
};

export const auditPanel: Panel = {
	id: 'audit',
	title: 'Audit',
	render: (state) => <AuditBody state={state} />,
};
