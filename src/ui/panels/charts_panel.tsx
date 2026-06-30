import { React } from '../../lib/react';
import type { Panel, ConsoleState, MonitorSample } from '../console_types';

/**
 * ChartsPanel (design/11 §3.5) — rolling sparklines for money, income, and RAM %.
 * Pure presentation over state.history — never ns.*, no dispatch.
 */

// ── Tiny formatters ────────────────────────────────────────────────────────────

/** $ with k/m/b/t/q suffix; negatives preserved. */
function fmtMoney(n: number): string {
	const sign = n < 0 ? '-' : '';
	let v = Math.abs(n);
	const units = ['', 'k', 'm', 'b', 't', 'q'];
	let u = 0;
	while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
	return `${sign}$${v.toFixed(v >= 100 || u === 0 ? 0 : 2)}${units[u]}`;
}

/** 0–100 → "NN.N%" */
function fmtPct(n: number): string {
	return `${n.toFixed(1)}%`;
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

const SPARK_W = 220;
const SPARK_H = 28;
const SPARK_PAD = 2; // px top/bottom padding inside SVG

interface SparklineProps {
	values: number[];
	color: string;
	width?: number;
	height?: number;
}

const Sparkline = ({ values, color, width = SPARK_W, height = SPARK_H }: SparklineProps) => {
	if (values.length < 2) {
		// Placeholder with matching height so layout doesn't shift when data arrives
		return (
			<div style={{ height: `${height}px`, display: 'flex', alignItems: 'center' }}>
				<span style={{ color: '#555', fontStyle: 'italic', fontSize: '10px' }}>collecting…</span>
			</div>
		);
	}

	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min; // may be 0 → flat line

	const usableH = height - SPARK_PAD * 2;
	const points = values.map((v, i) => {
		const x = (i / (values.length - 1)) * width;
		// When all values equal, draw a centred flat line
		const y = range === 0
			? height / 2
			: height - SPARK_PAD - ((v - min) / range) * usableH;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	}).join(' ');

	return (
		<svg
			width={width}
			height={height}
			style={{ display: 'block', overflow: 'visible' }}
		>
			<polyline
				points={points}
				fill="none"
				stroke={color}
				strokeWidth="1.5"
				strokeLinejoin="round"
				strokeLinecap="round"
			/>
		</svg>
	);
};

// ── Chart row: label + latest value + sparkline ────────────────────────────────

interface ChartRowProps {
	label: string;
	values: number[];
	latest: string;
	color: string;
}

const ChartRow = ({ label, values, latest, color }: ChartRowProps) => (
	<div style={{ marginBottom: '10px' }}>
		<div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
			<span style={{ color: '#999', fontSize: '11px' }}>{label}</span>
			<span style={{ color, fontSize: '11px', fontFamily: 'monospace', fontWeight: 'bold' }}>
				{latest}
			</span>
		</div>
		<div style={{ background: '#111', borderRadius: '3px', padding: '2px 0' }}>
			<Sparkline values={values} color={color} />
		</div>
	</div>
);

// ── Panel body ────────────────────────────────────────────────────────────────

const ChartsBody = ({ state }: { state: ConsoleState }) => {
	// Shallow copy — never mutate state.history
	const hist: MonitorSample[] = state.history.slice();

	const moneyVals  = hist.map(s => s.money);
	const incomeVals = hist.map(s => s.income);
	const ramPctVals = hist.map(s => s.ramMax > 0 ? (s.ramUsed / s.ramMax) * 100 : 0);

	const last = hist.length > 0 ? hist[hist.length - 1] : null;
	const latestMoney  = last ? fmtMoney(last.money) : '—';
	const latestIncome = last ? `${fmtMoney(last.income)}/s` : '—';
	const latestRamPct = last
		? fmtPct(last.ramMax > 0 ? (last.ramUsed / last.ramMax) * 100 : 0)
		: '—';

	return (
		<div style={{ fontFamily: 'monospace', fontSize: '12px', width: '240px' }}>
			<ChartRow label="Money"    values={moneyVals}  latest={latestMoney}  color="#e0c050" />
			<ChartRow label="Income/s" values={incomeVals} latest={latestIncome} color="#4ec94e" />
			<ChartRow label="RAM %"    values={ramPctVals} latest={latestRamPct} color="#7fb0ff" />
		</div>
	);
};

// ── Export ────────────────────────────────────────────────────────────────────

export const chartsPanel: Panel = {
	id: 'charts',
	title: 'Charts',
	render: (state) => <ChartsBody state={state} />,
};
