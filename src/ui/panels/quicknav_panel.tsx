import { React } from '../../lib/react';
import type { Panel } from '../console_types';

/**
 * QuickNavPanel (design/09 Wave 1-A) — buttons to jump game pages via the
 * Navigator, highlighting the current page. STUB: Wave 1-A fills the body.
 * Pure presentation — dispatch({ kind: 'navigate', page }) only, never ns.*.
 */
export const quickNavPanel: Panel = {
	id: 'quicknav',
	title: 'Navigate',
	render: () => <div style={{ color: '#888' }}>Nav — pending Wave 1-A.</div>,
};
