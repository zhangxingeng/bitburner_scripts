import { React } from '../../lib/react';
import type { ConsoleState, MonitorSnapshot, Panel } from '../console_types';

/**
 * MonitorPanel — read-only live system metrics (docs/design/08 §4.2, Step C).
 *
 * The first reactive (non-config) panel: it proves the NS-loop → ConsoleState →
 * CustomEvent → React display path end-to-end before the high-value DecisionsPanel.
 * Pure presentation — it only reads `state.monitor`, which the loop fills from
 * cheap, legitimately-held ns.* reads. No ns.*, no dispatch.
 */

// ── Tiny formatters (no ns.* — keep the panel pure) ───────────────────────────

/** $ with k/m/b/t/q suffix; negatives (debt) preserved. */
function fmtMoney(n: number): string {
	const sign = n < 0 ? '-' : '';
	let v = Math.abs(n);
	const units = ['', 'k', 'm', 'b', 't', 'q'];
	let u = 0;
	while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
	return `${sign}$${v.toFixed(v >= 100 || u === 0 ? 0 : 2)}${units[u]}`;
}

/** GB → "NN GB" / "N.NN TB" / "N.NN PB". */
function fmtRam(gb: number): string {
	if (gb >= 1_000_000) return `${(gb / 1_000_000).toFixed(2)} PB`;
	if (gb >= 1000) return `${(gb / 1000).toFixed(2)} TB`;
	return `${gb.toFixed(0)} GB`;
}

// ── Presentational bits ───────────────────────────────────────────────────────

const Row = ({ label, value, color }: { label: string; value: string; color?: string }) => (
	<div style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
		<span style={{ color: '#999' }}>{label}</span>
		<span style={{ color: color ?? '#cfcfcf', fontWeight: 'bold' }}>{value}</span>
	</div>
);

/** Thin RAM utilisation bar; green → amber → red as it fills. */
const RamBar = ({ used, max }: { used: number; max: number }) => {
	const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
	const color = pct < 70 ? '#4ec94e' : pct < 90 ? '#e0c050' : '#d05050';
	return (
		<div style={{ height: '5px', background: '#1e1e1e', borderRadius: '3px', overflow: 'hidden', margin: '3px 0 5px' }}>
			<div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 300ms' }} />
		</div>
	);
};

const MonitorBody = ({ state }: { state: ConsoleState }) => {
	const m: MonitorSnapshot = state.monitor;
	const incomeColor = m.incomePerSec > 0 ? '#4ec94e' : m.incomePerSec < 0 ? '#d05050' : '#cfcfcf';
	return (
		<>
			<Row label="Phase" value={m.phase} color="#7fb0ff" />
			<Row label="Money" value={fmtMoney(m.money)} color="#e0c050" />
			<Row label="Income" value={`${fmtMoney(m.incomePerSec)}/s`} color={incomeColor} />
			<Row label="Scripts" value={String(m.scriptCount)} />
			<Row label="Home RAM" value={`${fmtRam(m.ramUsed)} / ${fmtRam(m.ramMax)}`} />
			<RamBar used={m.ramUsed} max={m.ramMax} />
		</>
	);
};

export const monitorPanel: Panel = {
	id: 'monitor',
	title: 'Monitor',
	render: (state) => <MonitorBody state={state} />,
};
