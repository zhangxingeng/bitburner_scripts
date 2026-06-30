import { React } from '../../lib/react';
import type { Panel } from '../console_types';

/**
 * AuditPanel (design/11 §3.5) — action/decision history feed (what the brain
 * actually did + verdicts applied). STUB: Wave 1 fills the body. Pure
 * presentation — never ns.*.
 */
export const auditPanel: Panel = {
	id: 'audit',
	title: 'Audit',
	render: () => <div style={{ color: '#888' }}>Audit — pending Wave 1.</div>,
};
