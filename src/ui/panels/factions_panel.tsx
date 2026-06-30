import { React } from '../../lib/react';
import type { Panel, Dispatch, ConsoleState } from '../console_types';
import type { PlayerSnapshot } from '../../lib/player_state';

/**
 * FactionsPanel — read-only faction status + manual invite acceptance.
 *
 * Reads state.player (a PlayerSnapshot published by the NS loop each tick).
 * Pure presentation: the only side effect is dispatch({ kind: 'joinFaction', faction })
 * when the user clicks a Join button. No ns.* calls ever run here (§3 boundary).
 *
 * Layout (top → bottom, ~240 px wide window):
 *   [stale hint]       — dim amber line when player.ts === 0 (sequencer not yet ticked)
 *   Summary row        — augs owned/pending, hacking level, city
 *   Joined factions    — comma-joined names; "None" empty state
 *   Pending invites    — one row per invite: name + Join button; "None" empty state
 */

// ── Palette (matches existing panels) ────────────────────────────────────────

const GREEN  = '#4ec94e';
const DIM    = '#999';
const LABEL  = '#8fbf8f';
const AMBER  = '#e0c050';
const WHITE  = '#cfcfcf';
const DARK   = '#1e1e1e';

// ── Sub-components ────────────────────────────────────────────────────────────

/** Key/value row matching monitor_panel's Row style. */
const Row = ({ label, value, color }: { label: string; value: string; color?: string }) => (
	<div style={{ display: 'flex', justifyContent: 'space-between', padding: '1px 0' }}>
		<span style={{ color: DIM }}>{label}</span>
		<span style={{ color: color ?? WHITE, fontWeight: 'bold' }}>{value}</span>
	</div>
);

/** Section sub-heading (slightly smaller than panel title). */
const SectionHead = ({ children }: { children: string }) => (
	<div style={{ color: LABEL, fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '6px 0 2px' }}>
		{children}
	</div>
);

/** Dim line shown when no data of a particular kind is available. */
const EmptyHint = ({ text }: { text: string }) => (
	<div style={{ color: DIM, fontStyle: 'italic', padding: '1px 0' }}>{text}</div>
);

/** Single pending-invitation row: faction name + small Join button. */
const InviteRow = ({ faction, onJoin }: { faction: string; onJoin: () => void }) => (
	<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
		<span style={{ color: WHITE, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: '6px' }}>
			{faction}
		</span>
		<span
			onClick={onJoin}
			style={{
				cursor: 'pointer',
				padding: '1px 7px',
				background: 'rgba(0,160,0,0.25)',
				border: `1px solid ${GREEN}`,
				borderRadius: '3px',
				color: GREEN,
				fontWeight: 'bold',
				fontSize: '11px',
				flexShrink: 0,
				userSelect: 'none',
			}}
		>
			Join
		</span>
	</div>
);

// ── Main body ─────────────────────────────────────────────────────────────────

const FactionsBody = ({ state, dispatch }: { state: ConsoleState; dispatch: Dispatch }) => {
	const p: PlayerSnapshot | undefined = state.player;

	// No snapshot at all — sequencer never published; ts===0 is handled below.
	if (!p) {
		return (
			<div style={{ color: AMBER, fontSize: '11px', padding: '2px 0' }}>
				· stale (no snapshot yet)
			</div>
		);
	}

	const isStale = p.ts === 0;

	return (
		<>
			{/* Stale hint — shown when ts===0 (sequencer ticked but published zero-epoch) */}
			{isStale && (
				<div style={{ color: AMBER, fontSize: '11px', padding: '1px 0', marginBottom: '3px' }}>
					· stale (no snapshot yet)
				</div>
			)}

			{/* Summary */}
			<Row
				label="Augs"
				value={`${p.augsOwned} owned · ${p.augsPending} pending`}
				color={p.augsPending > 0 ? AMBER : WHITE}
			/>
			<Row label="Hacking" value={String(p.hackingLevel)} color={GREEN} />
			<Row label="City"    value={p.city}                 color={WHITE}  />

			{/* Joined factions */}
			<SectionHead>Joined</SectionHead>
			{p.factions.length === 0
				? <EmptyHint text="None" />
				: (
					<div style={{ color: WHITE, lineHeight: '1.5', wordBreak: 'break-word' }}>
						{p.factions.join(', ')}
					</div>
				)
			}

			{/* Pending invitations */}
			<SectionHead>Invitations</SectionHead>
			{p.invitations.length === 0
				? <EmptyHint text="None" />
				: p.invitations.map(faction => (
					<InviteRow
						key={faction}
						faction={faction}
						onJoin={() => dispatch({ kind: 'joinFaction', faction })}
					/>
				))
			}
		</>
	);
};

// ── Panel export ──────────────────────────────────────────────────────────────

export const factionsPanel: Panel = {
	id: 'factions',
	title: 'Factions',
	render: (state, dispatch) => <FactionsBody state={state} dispatch={dispatch} />,
};
