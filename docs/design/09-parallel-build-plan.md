# Design 09 — Parallel Build Plan (console v1 completion)

**Status:** BUILT 2026-06-30. Wave 0 (`2ac43ef`), Wave 1 (`e6fbb8d`), Wave 2 (`1ce0ed0`). `tsc --noEmit` + `node --check` clean across all bundles; Tier-2 (user-driven) is the remaining gate. **Build note:** the five worktrees branched from a pre-Step-D base (`7ce9d9e`), so panels (A/B/C) were integrated by copying the file content onto the Wave-0 seam, and the existing-file edits (D sequencer, E game_agent) were re-applied by hand rather than git-merged (a naive merge would have reverted Step D + Wave 0). Lesson: worktree isolation does not inherit an in-session commit as its base, and worktrees lack `node_modules` so agent-side `tsc` reports phantom `@ns` errors — verify in the main tree.

**Goal (user 2026-06-30):** finish the console + judgment layer in ONE session via concurrent subagents in git worktrees. Build *everything*, then debug — not build-while-debug. Waves are allowed; one session is the constraint.

**Companion:** [[08-control-console]] (the architecture being completed), [[06-ui-navigation]] (Navigator the QuickNav panel uses), [[07-dev-loop-tooling]] (verify tiers), [[autoplay-architecture-decision]].

---

## §1 Why waves, not a flat fan-out

Every console panel touches the same three shared files: `control_console.tsx` (shell + NS loop + `PANELS` + gatherers), `console_types.ts` (`ConsoleState`/`Intent`), and any shared lib. Worktrees isolate filesystems but NOT semantic conflicts — two agents editing `ConsoleState` still collide on merge. So we **freeze the contract first**, then fan out on disjoint files.

```
Wave 0 (me, solo)     → freeze the seam: final ConsoleState/Intent, all loop
                        gatherers + intent handlers, stub panels, shared libs.
                        ONE commit on main. Everything compiles.
Wave 1 (N agents,     → each fills ONLY its own new file(s) against the frozen
        worktrees)      contract. Disjoint ownership → conflict-free merge.
Wave 2 (me, solo)     → merge branches, shell-level layout polish (Step E),
                        full verify (typecheck + node --check + Tier-1), then
                        the SINGLE Tier-2 pass (user drives).
```

## §2 Frozen contract (Wave 0 emits this; Wave 1 builds against it — DO NOT CHANGE in Wave 1)

### 2.1 `ConsoleState` (final v1) — `src/ui/console_types.ts`
```ts
export interface ConsoleState {
  settings:     BrainSettings;       // ConfigPanel        (done)
  pendingAugs:  number;              // ConfigPanel        (done)
  monitor:      MonitorSnapshot;     // MonitorPanel       (done)
  decisions:    PendingDecision[];   // DecisionsPanel     (done)
  logs:         Notification[];      // LogPanel           (Wave 1-B) — from notification.ts
  currentPage:  string;              // QuickNavPanel      (Wave 1-A) — Navigator.currentPage() or ''
  player:       PlayerSnapshot;      // FactionsPanel      (Wave 1-C)
}
```

### 2.2 `Intent` (final v1) — `src/ui/console_types.ts`
```ts
export type Intent =
  | { kind: 'setSettings'; settings: BrainSettings }   // done
  | { kind: 'buyAugs' }                                 // done
  | { kind: 'reset' }                                   // done
  | { kind: 'decide'; id: string; verdict: Verdict }   // done
  | { kind: 'navigate'; page: string }                 // QuickNav → loop calls Navigator.goTo
  | { kind: 'joinFaction'; faction: string };          // Factions → loop ns_dodge joinFaction
```

### 2.3 `PlayerSnapshot` — NEW `src/lib/player_state.ts` (shared contract, like decisions.ts)
```ts
export interface PlayerSnapshot {
  ts:          number;     // ms epoch of snapshot (0 = never published)
  factions:    string[];   // joined factions
  invitations: string[];   // pending faction invites
  augsOwned:   number;     // installed augmentations
  augsPending: number;     // purchased/queued, not yet installed
  hackingLevel:number;
  city:        string;
}
export const EMPTY_PLAYER: PlayerSnapshot = { ts:0, factions:[], invitations:[], augsOwned:0, augsPending:0, hackingLevel:0, city:'' };
export function loadPlayerState(ns): PlayerSnapshot   // reads status/player_state.json; EMPTY on miss/corrupt
export function savePlayerState(ns, s: PlayerSnapshot): void
```
- **File:** `status/player_state.json`. **Producer:** Wave 1-D (sequencer publisher). **Consumer:** console loop.

### 2.4 Data sources / sinks (all cheap in the console loop unless noted)
| ConsoleState field | Source in loop | Cost |
|---|---|---|
| logs | read `status/notifications.txt` (game_agent writes it), parse, take last N | ns.read 0 GB |
| currentPage | `navigator.currentPage()` (import lib/navigator) | 0 GB |
| player | `loadPlayerState(ns)` | ns.read 0 GB |
| navigate intent | `navigator.goTo(page as GamePageValue)` in loop | 0 GB |
| joinFaction intent | `executeCommand(ns, 'ns.singularity.joinFaction("…")')` (ns_dodge, on-demand only) | dodge |

## §3 Wave 0 — the frozen seam (me, solo, 1 commit)

Deliverables, all so the project compiles with stub panels:
1. `src/lib/player_state.ts` — types + load/save (§2.3).
2. `console_types.ts` — final `ConsoleState` + `Intent` (§2.1/2.2); import `Notification`, `PlayerSnapshot`.
3. `control_console.tsx`:
   - register all panels in TAB order: `PANELS = [monitorPanel, decisionsPanel, factionsPanel, quickNavPanel, logPanel, configPanel]`. (Wave 0 may keep the simple stacked render; Wave 2 converts the shell to a tab bar showing one panel at a time.)
   - loop gatherers: add `logs` (read notifications.txt, last N), `currentPage` (navigator.currentPage()), `player` (loadPlayerState). Seed `initial` too.
   - intent handlers: `navigate` → `goTo`; `joinFaction` → ns_dodge joinFaction (+ notify).
   - import the three stub panels.
4. Stub panels (minimal placeholder render, replaced in Wave 1): `panels/quicknav_panel.tsx`, `panels/log_panel.tsx`, `panels/factions_panel.tsx`.
5. Typecheck + node --check; commit `feat(ui): wave-0 seam for console v1 panels`.

## §4 Wave 1 — parallel agents (worktrees, branch from Wave-0 commit)

Each agent: read the named files, implement ONLY its owned file(s), keep the frozen contract, typecheck its own output, return a summary. **No agent edits `console_types.ts`, `control_console.tsx`, or another agent's file.**

- **Agent A — QuickNavPanel.** Owns `panels/quicknav_panel.tsx`. Buttons for a curated page set (Terminal, Stats, Factions, Augmentations, Hacknet, Active Scripts, City, Stock Market) → `dispatch({kind:'navigate',page})`; highlight the one matching `state.currentPage`. Pure presentation. Dogfoods Navigator.
- **Agent B — LogPanel.** Owns `panels/log_panel.tsx`. Render `state.logs` newest-first (ts → relative time, msg, recommendation). Cap display ~12 rows, scroll. Empty-state line. Pure presentation.
- **Agent C — FactionsPanel.** Owns `panels/factions_panel.tsx`. Show augs owned/pending, joined factions, and pending `invitations` each with a **Join** button → `dispatch({kind:'joinFaction',faction})`. Reads `state.player`. Pure presentation. Stale-data hint if `player.ts===0`.
- **Agent D — Player-state publisher.** Owns `src/cross/player_sequencer.ts` (only). Add `publishPlayerState(ns)` — one `ns_dodge` batch returning factions/invitations/owned+pending augs/hacking/city → `savePlayerState`. Call every ~6 ticks (≈30 s) and once at startup. RAM stays ≤4 GB (dodge pays Singularity). Honors `loadPlayerState`/`savePlayerState` from `lib/player_state.ts`.
- **Agent E — MCP decision twin.** Owns `src/cross/game_agent.ts` (only). Mirror `status/decisions_pending.json` into the WS/notifications state push (so the remote agent SEES pending decisions), and accept a verdict command that calls `pushReply(ns, {id,verdict})` onto `PORT_DECISION_REPLY` (port 13) — same queue the console uses (`lib/decisions.ts`). Read game_agent's existing command/WS framing first.

## §5 Wave 2 — integrate + polish + verify (me, solo)

1. Merge A–E branches (disjoint files → clean). Remove worktrees.
2. **Step E layout polish** (`control_console.tsx`, shell-level): TAB BAR (§6) — `[Monitor][Decisions][Factions][Nav][Logs][Config]`, render only the active panel's `render(state,dispatch)`; resize handle; persist active-tab + open/pos/size to `status/ui_state.json`.
3. Full verify: `tsc --noEmit`, `node --check` all bundles, Tier-1 Playwright only for genuinely-new DOM (gear/nav already verified; new panels are pure presentation).
4. Hand to user for the SINGLE Tier-2 pass: `run /ui/control_console.js` — confirm all panels render + the new intents (navigate actually changes page, join actually joins, decisions reply drives the sequencer).
5. Commit per wave; push when user OKs.

## §6 Decisions (LOCKED 2026-06-30)
- **Scope = Console v1 complete (A–E).** All five agents; no brain-logic widening this session (autoSolveContracts / broader sequencer autonomy deferred to a later session — separate subsystem).
- **Layout = TABS (Step E).** Tab bar at top: `[Monitor][Decisions][Factions][Nav][Logs][Config]`, one panel visible at a time; active tab persisted. So the shell renders ONE panel's `render()` at a time (selected by tab state), not the full `PANELS.map`. `PANELS` order = that tab order. Persist active-tab + open/pos/size to `status/ui_state.json`.
- **joinFaction transport** — console loop `ns_dodge` on-demand (simple; user-initiated so the Singularity cost is fine). Revisit only if dodge latency in the UI loop is bad.
