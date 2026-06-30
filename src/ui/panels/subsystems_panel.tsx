import { React } from '../../lib/react';
import type { Panel } from '../console_types';

/**
 * SubsystemsPanel (design/11 §3.5) — overview of every registry subsystem
 * (available/enabled/running + headline) with a per-subsystem on/off toggle
 * (dispatch toggleSubsystem). Reads state.subsystems. STUB: Wave 1 fills the body.
 * Pure presentation — dispatch only, never ns.*.
 */
export const subsystemsPanel: Panel = {
	id: 'subsystems',
	title: 'Systems',
	render: () => <div style={{ color: '#888' }}>Subsystems — pending Wave 1.</div>,
};
