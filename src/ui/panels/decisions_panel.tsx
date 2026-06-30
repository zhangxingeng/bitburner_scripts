import { React } from '../../lib/react';
import type { ConsoleState, Dispatch, Panel } from '../console_types';
import type { PendingDecision } from '../../lib/decisions';

/**
 * DecisionsPanel — surface judgment calls inline with Approve / Deny / Defer
 * (docs/design/08 §4.3, Step D). The attended twin of the MCP control channel:
 * both read the same `status/decisions_pending.json` queue and push the same
 * verdict (see lib/decisions.ts).
 *
 * Pure responder: each button only dispatches a `decide` intent. The console
 * loop forwards it to PORT_DECISION_REPLY; the sequencer (producer) applies the
 * verdict and clears the pending entry. This panel never acts or mutates state.
 */

const VerdictButton = ({ label, bg, onClick }: { label: string; bg: string; onClick: () => void }) => (
	<div
		onClick={onClick}
		style={{
			flex: 1,
			textAlign: 'center',
			cursor: 'pointer',
			padding: '4px 5px',
			margin: '0 2px',
			borderRadius: '4px',
			background: bg,
			color: 'white',
			fontWeight: 'bold',
			fontSize: '11px',
			userSelect: 'none',
		}}
	>
		{label}
	</div>
);

const DecisionCard = ({ d, dispatch }: { d: PendingDecision; dispatch: Dispatch }) => (
	<div
		style={{
			border: '1px solid #4a4a2a',
			borderRadius: '4px',
			padding: '5px 6px',
			margin: '4px 0',
			background: 'rgba(224,192,80,0.06)',
		}}
	>
		<div style={{ color: '#e0c050', marginBottom: '4px' }}>{d.prompt}</div>
		{d.command && (
			<div style={{ color: '#7a7a5a', fontSize: '10px', marginBottom: '4px', wordBreak: 'break-all' }}>
				{d.command}
			</div>
		)}
		<div style={{ display: 'flex' }}>
			<VerdictButton label="Approve" bg="#2a6f2a" onClick={() => dispatch({ kind: 'decide', id: d.id, verdict: 'approve' })} />
			<VerdictButton label="Deny"    bg="#8a2a2a" onClick={() => dispatch({ kind: 'decide', id: d.id, verdict: 'deny' })} />
			<VerdictButton label="Defer"   bg="#555533" onClick={() => dispatch({ kind: 'decide', id: d.id, verdict: 'defer' })} />
		</div>
	</div>
);

const DecisionsBody = ({ state, dispatch }: { state: ConsoleState; dispatch: Dispatch }) => {
	if (!state.decisions.length) {
		return <div style={{ color: '#6a6a6a', fontStyle: 'italic' }}>No pending decisions.</div>;
	}
	return (
		<>
			{state.decisions.map(d => (
				<DecisionCard key={d.id} d={d} dispatch={dispatch} />
			))}
		</>
	);
};

export const decisionsPanel: Panel = {
	id: 'decisions',
	title: 'Decisions',
	render: (state, dispatch) => <DecisionsBody state={state} dispatch={dispatch} />,
};
