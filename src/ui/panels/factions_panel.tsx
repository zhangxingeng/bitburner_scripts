import { React } from '../../lib/react';
import type { Panel } from '../console_types';

/**
 * FactionsPanel (design/09 Wave 1-C) — augs owned/pending, joined factions, and
 * pending invitations with one-click Join. Reads state.player (published by the
 * sequencer). STUB: Wave 1-C fills the body. Pure presentation —
 * dispatch({ kind: 'joinFaction', faction }) only, never ns.*.
 */
export const factionsPanel: Panel = {
	id: 'factions',
	title: 'Factions',
	render: () => <div style={{ color: '#888' }}>Factions — pending Wave 1-C.</div>,
};
