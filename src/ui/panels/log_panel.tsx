import { React } from '../../lib/react';
import type { ConsoleState, Panel } from '../console_types';
import type { Notification } from '../../cross/notification';

/**
 * LogPanel — scrollable notification feed (docs/design/08 §4, Step D+).
 *
 * Pure presentation: reads `state.logs` (Notification[], oldest-first),
 * reverses for display (newest-first), formats relative timestamps, and
 * renders each entry as a compact two-line row.  No ns.*, no dispatch.
 */

// ── Age formatter ─────────────────────────────────────────────────────────────

/** Convert a ms-epoch timestamp into a short human-readable age string. */
function fmtAge(ts: number): string {
	const sec = Math.floor((Date.now() - ts) / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	return `${Math.floor(hr / 24)}d`;
}

// ── Presentational components ─────────────────────────────────────────────────

const LogRow = ({ n }: { n: Notification }) => (
	<div
		style={{
			padding: '4px 0',
			borderBottom: '1px solid #1e1e1e',
		}}
	>
		{/* Header: age label + message */}
		<div style={{ display: 'flex', gap: '6px', alignItems: 'baseline' }}>
			<span
				style={{
					flexShrink: 0,
					color: '#555',
					fontSize: '10px',
					fontFamily: 'monospace',
					minWidth: '24px',
					textAlign: 'right',
				}}
			>
				{fmtAge(n.ts)}
			</span>
			<span
				style={{
					color: '#cfcfcf',
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
		{/* Optional recommendation line (dimmer) */}
		{n.recommendation && (
			<div
				style={{
					marginLeft: '30px',
					marginTop: '1px',
					color: '#4ec94e',
					fontSize: '11px',
					fontFamily: 'monospace',
					fontStyle: 'italic',
					lineHeight: '1.3',
					wordBreak: 'break-word',
					overflowWrap: 'anywhere',
					opacity: 0.75,
				}}
			>
				→ {n.recommendation}
			</div>
		)}
	</div>
);

const LogBody = ({ state }: { state: ConsoleState }) => {
	const raw: Notification[] = state.logs ?? [];

	// Copy and reverse so newest entry is displayed first; never mutate state.
	const rows = raw.slice().reverse();

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
				No activity yet.
			</div>
		);
	}

	// Cap visible rows to ~12 via maxHeight; overflowY lets user scroll older entries.
	return (
		<div
			style={{
				maxHeight: '204px',   // ~12 rows × ~17px each
				overflowY: 'auto',
				overflowX: 'hidden',
			}}
		>
			{rows.map((n) => (
				<LogRow key={n.ts} n={n} />
			))}
		</div>
	);
};

export const logPanel: Panel = {
	id: 'logs',
	title: 'Logs',
	render: (state) => <LogBody state={state} />,
};
