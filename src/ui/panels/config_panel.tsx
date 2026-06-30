import { React } from '../../lib/react';
import type { BrainSettings } from '../../lib/settings';
import type { ConsoleState, Dispatch, Panel } from '../console_types';

/**
 * ConfigPanel — the Thread-P brain's autonomy toggles + action buttons.
 *
 * This is the first registered console panel (docs/design/08 §4.1), extracted
 * unchanged from milestone-2's config_dashboard. Pure presentation: toggles and
 * buttons only `dispatch` intents; the NS loop performs every ns.* action.
 */

type ToggleKey =
	| 'autoJoinFactions'
	| 'autoBuyPrograms'
	| 'autoSolveContracts'
	| 'autoBuyAugs'
	| 'autoReset'
	| 'autoBitNode';

const TOGGLES: { key: ToggleKey; label: string }[] = [
	{ key: 'autoJoinFactions',   label: 'Auto-join factions' },
	{ key: 'autoBuyPrograms',    label: 'Auto-buy programs' },
	{ key: 'autoSolveContracts', label: 'Auto-solve contracts' },
	{ key: 'autoBuyAugs',        label: 'Auto-buy augs' },
	{ key: 'autoReset',          label: 'Auto-reset' },
	{ key: 'autoBitNode',        label: 'Auto-BitNode' },
];

const Toggle = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) => (
	<div
		onClick={onClick}
		style={{
			display: 'flex',
			justifyContent: 'space-between',
			alignItems: 'center',
			cursor: 'pointer',
			padding: '3px 7px',
			margin: '2px 0',
			borderRadius: '3px',
			border: '1px solid #2a2a2a',
			background: on ? 'rgba(0,160,0,0.18)' : 'transparent',
			color: on ? '#4ec94e' : '#999',
		}}
	>
		<span>{label}</span>
		<span style={{ fontWeight: 'bold' }}>{on ? 'ON' : 'OFF'}</span>
	</div>
);

const ActionButton = ({ label, bg, onClick }: { label: string; bg: string; onClick: () => void }) => (
	<div
		onClick={onClick}
		style={{
			flex: 1,
			textAlign: 'center',
			cursor: 'pointer',
			padding: '5px 6px',
			margin: '2px',
			borderRadius: '4px',
			background: bg,
			color: 'white',
			fontWeight: 'bold',
			userSelect: 'none',
		}}
	>
		{label}
	</div>
);

const ConfigBody = ({ state, dispatch }: { state: ConsoleState; dispatch: Dispatch }) => {
	// Local optimistic copy so a toggle flips instantly; the loop confirms it on
	// the next tick by republishing settings (which resyncs this via the effect).
	const [settings, setSettings] = React.useState<BrainSettings>(state.settings);
	React.useEffect(() => setSettings(state.settings), [state.settings]);

	const flip = (key: ToggleKey) => {
		const next = { ...settings, [key]: !settings[key] };
		setSettings(next);
		dispatch({ kind: 'setSettings', settings: next });
	};

	return (
		<>
			{TOGGLES.map(t => (
				<Toggle key={t.key} label={t.label} on={settings[t.key]} onClick={() => flip(t.key)} />
			))}
			<div style={{ color: '#bbb', margin: '6px 0 3px' }}>
				Pending augs: <span style={{ color: '#e0c050' }}>{state.pendingAugs}</span>
			</div>
			<div style={{ display: 'flex' }}>
				<ActionButton label="Buy augs" bg="#2a6f2a" onClick={() => dispatch({ kind: 'buyAugs' })} />
				<ActionButton label="Reset now" bg="#8a2a2a" onClick={() => dispatch({ kind: 'reset' })} />
			</div>
		</>
	);
};

export const configPanel: Panel = {
	id: 'config',
	title: 'Brain Config',
	render: (state, dispatch) => <ConfigBody state={state} dispatch={dispatch} />,
};
