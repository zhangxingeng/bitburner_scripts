import { React } from '../../lib/react';
import type { Panel } from '../console_types';

/**
 * ChartsPanel (design/11 §3.5) — income/RAM sparklines from a rolling history.
 * STUB: Wave 1 fills the body (reads a rolling-history status file the loop
 * appends to). Pure presentation — never ns.*.
 */
export const chartsPanel: Panel = {
	id: 'charts',
	title: 'Charts',
	render: () => <div style={{ color: '#888' }}>Charts — pending Wave 1.</div>,
};
