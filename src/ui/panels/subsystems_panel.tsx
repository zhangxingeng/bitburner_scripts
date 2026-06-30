import { React } from '../../lib/react';
import type { Panel, Dispatch, ConsoleState } from '../console_types';
import type { SubsystemStatus } from '../../lib/subsystem_state';
import { PLAYER_MANAGERS } from '../../lib/manager_registry';
import type { ManagerSpec } from '../../lib/manager_registry';

/**
 * SubsystemsPanel (design/11 §3.5) — one row per PLAYER_MANAGERS entry.
 *
 * Layout per row (top → bottom):
 *   [dot] Label                                     [ON|OFF]
 *   (dim, truncated headline)
 *   key:val  key:val   ← up to 2 metrics
 *
 * Status dot colour:
 *   green  — available && running
 *   amber  — available && !running  (idle / waiting)
 *   grey   — !available             (SF absent / BitNode locked)
 *   + "stale" badge when ts === 0 (manager never published)
 *
 * Toggle wiring:
 *   Each spec carries settingKey (a BooleanSettingKey).
 *   Current value = state.settings[settingKey].
 *   Click → dispatch({ kind: 'toggleSubsystem', settingKey, on: !current }).
 *
 * Pure presentation — only side effect is dispatch, never ns.*.
 */

// ── Palette (matches existing panels) ─────────────────────────────────────────

const GREEN = '#4ec94e';
const AMBER = '#e0c050';
const DIM   = '#999';
const WHITE = '#cfcfcf';
const GREY  = '#484848';
const SEP   = '#222';
const MET   = '#7a9a7a';

// ── Status dot helper ─────────────────────────────────────────────────────────

function dotProps(s: SubsystemStatus): { color: string; title: string } {
	if (!s.available) {
		return { color: GREY, title: s.ts === 0 ? 'unavailable · stale' : 'unavailable' };
	}
	if (s.running) return { color: GREEN, title: 'running'        };
	return               { color: AMBER, title: 'available · idle' };
}

// ── Fallback status when a manager has never published ─────────────────────────

const EMPTY_STATUS = (id: string): SubsystemStatus => ({
	id, available: false, enabled: false, running: false,
	headline: '', metrics: {}, ts: 0,
});

// ── Per-row component ─────────────────────────────────────────────────────────

const SubsystemRow = ({
	spec,
	status,
	on,
	onToggle,
}: {
	spec:     ManagerSpec;
	status:   SubsystemStatus;
	on:       boolean;
	onToggle: () => void;
}) => {
	const dot          = dotProps(status);
	const isStale      = status.ts === 0;
	const metricPairs  = Object.entries(status.metrics).slice(0, 2);

	return (
		<div style={{ padding: '4px 0', borderBottom: `1px solid ${SEP}` }}>

			{/* ── Main row: dot · label · stale · toggle ─────────────────── */}
			<div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>

				{/* Status dot */}
				<span title={dot.title} style={{ color: dot.color, fontSize: '10px', flexShrink: 0, lineHeight: 1 }}>
					●
				</span>

				{/* Label */}
				<span style={{ color: WHITE, fontWeight: 'bold', fontSize: '12px', flexGrow: 1, minWidth: 0 }}>
					{spec.label}
				</span>

				{/* Stale badge — shown when manager has never published */}
				{isStale && (
					<span style={{ color: AMBER, fontSize: '10px', flexShrink: 0 }}>
						stale
					</span>
				)}

				{/* ON / OFF toggle */}
				<span
					onClick={onToggle}
					title={on ? 'Click to disable' : 'Click to enable'}
					style={{
						cursor:     'pointer',
						padding:    '1px 6px',
						border:     `1px solid ${on ? GREEN : GREY}`,
						borderRadius: '3px',
						color:      on ? GREEN : DIM,
						fontSize:   '10px',
						fontWeight: 'bold',
						flexShrink: 0,
						background: on ? 'rgba(78,201,78,0.12)' : 'transparent',
						userSelect: 'none',
					}}
				>
					{on ? 'ON' : 'OFF'}
				</span>
			</div>

			{/* ── Headline (one line, truncated) ─────────────────────────── */}
			{status.headline && (
				<div style={{
					color:        DIM,
					fontSize:     '11px',
					paddingLeft:  '15px',
					marginTop:    '1px',
					overflow:     'hidden',
					textOverflow: 'ellipsis',
					whiteSpace:   'nowrap',
				}}>
					{status.headline}
				</div>
			)}

			{/* ── Up to 2 metrics ────────────────────────────────────────── */}
			{metricPairs.length > 0 && (
				<div style={{ paddingLeft: '15px', marginTop: '1px' }}>
					{metricPairs.map(([k, v]) => (
						<span key={k} style={{ color: MET, fontSize: '10px', marginRight: '8px' }}>
							{k}:{String(v)}
						</span>
					))}
				</div>
			)}
		</div>
	);
};

// ── Panel body ────────────────────────────────────────────────────────────────

const SubsystemsBody = ({ state, dispatch }: { state: ConsoleState; dispatch: Dispatch }) => {
	const byId = new Map<string, SubsystemStatus>(
		state.subsystems.map(s => [s.id, s])
	);

	return (
		<div>
			{PLAYER_MANAGERS.map(spec => {
				const status = byId.get(spec.id) ?? EMPTY_STATUS(spec.id);
				const on     = state.settings[spec.settingKey] as boolean;

				return (
					<SubsystemRow
						key={spec.id}
						spec={spec}
						status={status}
						on={on}
						onToggle={() => dispatch({ kind: 'toggleSubsystem', settingKey: spec.settingKey, on: !on })}
					/>
				);
			})}
		</div>
	);
};

// ── Panel export ──────────────────────────────────────────────────────────────

export const subsystemsPanel: Panel = {
	id:    'subsystems',
	title: 'Systems',
	render: (state, dispatch) => <SubsystemsBody state={state} dispatch={dispatch} />,
};
