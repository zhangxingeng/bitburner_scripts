import { React } from '../../lib/react';
import type { Panel } from '../console_types';

/**
 * LogPanel (design/09 Wave 1-B) — recent notify() stream, newest-first, from
 * state.logs (status/notifications.txt). STUB: Wave 1-B fills the body.
 * Pure presentation — reads state.logs only, never ns.*.
 */
export const logPanel: Panel = {
	id: 'logs',
	title: 'Logs',
	render: () => <div style={{ color: '#888' }}>Logs — pending Wave 1-B.</div>,
};
