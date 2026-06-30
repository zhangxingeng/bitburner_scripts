import { React } from '../../lib/react';
import type { ConsoleState, Dispatch, Panel } from '../console_types';

/**
 * QuickNavPanel — one-click navigation to curated game pages.
 *
 * Pure presentation: each button dispatches `{ kind: 'navigate', page }`.
 * The active page (state.currentPage) gets a distinct highlight so the
 * user can see where they are at a glance. No ns.*, no side effects.
 */

/** Pages exposed in the nav grid, in display order. */
const NAV_PAGES: string[] = [
	'Terminal',
	'Stats',
	'Factions',
	'Augmentations',
	'Hacknet',
	'Active Scripts',
	'City',
	'Stock Market',
];

const NavButton = ({
	page,
	active,
	onClick,
}: {
	page: string;
	active: boolean;
	onClick: () => void;
}) => (
	<div
		onClick={onClick}
		style={{
			boxSizing: 'border-box',
			width: 'calc(50% - 4px)',
			margin: '2px',
			padding: '4px 6px',
			borderRadius: '3px',
			border: active ? '1px solid #4ec94e' : '1px solid #2a2a2a',
			background: active ? 'rgba(0,160,0,0.22)' : '#111',
			color: active ? '#4ec94e' : '#cfcfcf',
			fontFamily: 'monospace',
			fontSize: '11px',
			fontWeight: active ? 'bold' : 'normal',
			textAlign: 'center',
			cursor: 'pointer',
			userSelect: 'none',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
		}}
		title={page}
	>
		{page}
	</div>
);

const QuickNavBody = ({
	state,
	dispatch,
}: {
	state: ConsoleState;
	dispatch: Dispatch;
}) => {
	const current = state.currentPage ?? '';
	return (
		<div
			style={{
				display: 'flex',
				flexWrap: 'wrap',
				margin: '-2px',
			}}
		>
			{NAV_PAGES.map(page => (
				<NavButton
					key={page}
					page={page}
					active={page === current}
					onClick={() => dispatch({ kind: 'navigate', page })}
				/>
			))}
		</div>
	);
};

export const quickNavPanel: Panel = {
	id: 'quicknav',
	title: 'Navigate',
	render: (state, dispatch) => <QuickNavBody state={state} dispatch={dispatch} />,
};
