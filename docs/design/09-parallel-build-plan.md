# Design 09 — Console v1 Parallel Build (retrospective)

**Status:** ✅ BUILT 2026-06-30 — Wave 0 `2ac43ef`, Wave 1 `e6fbb8d`, Wave 2 `1ce0ed0`, perf fix `1c64634`. Pushed to `origin/main`. Tier-2 passed (user). This was the first wide multi-agent build; the **reusable process it produced lives in [[10-parallel-build-playbook]]** — read that for the next round, not this doc.

**Companions:** [[08-control-console]] (the architecture completed here), [[10-parallel-build-playbook]] (the generalized process).

---

## What shipped

Console v1 = the attended human↔system surface ([[08-control-console]]). Six panels in a tabbed, resizable, persisted shell:

| Panel | File | Reads | Acts |
|---|---|---|---|
| Monitor | `panels/monitor_panel.tsx` | `state.monitor` (RAM/income/money/phase) | — |
| Decisions | `panels/decisions_panel.tsx` | `state.decisions` | Approve/Deny/Defer → `PORT_DECISION_REPLY` |
| Factions | `panels/factions_panel.tsx` | `state.player` | Join invite → `joinFaction` intent (ns_dodge) |
| Nav | `panels/quicknav_panel.tsx` | `state.currentPage` | `navigate` intent → `Navigator.goTo` |
| Logs | `panels/log_panel.tsx` | `state.logs` (notifications.txt) | — |
| Config | `panels/config_panel.tsx` | `state.settings` | toggles + Buy-augs/Reset |

Plus two producers feeding it: **player_sequencer** publishes `status/player_state.json` (`publishPlayerState`, ~1/30 s via ns_dodge), and **game_agent** is the MCP decision-twin (mirrors `decisions_pending.json` to a WS channel + accepts a `decide` verdict command on the same `PORT_DECISION_REPLY` queue the console uses).

Shell (Step E): tab bar (one panel at a time), bottom-right resize handle, and `UiState`/`persistUi` persistence to `status/ui_state.json`. Loop cadence decoupled from the sequencer to `CONSOLE_TICK_MS=200` (was reusing the 5 s sequencer tick → slow nav; fixed in `1c64634`).

## How it was built

Wave 0 froze the seam (`console_types.ts` final `ConsoleState`/`Intent`, new `lib/player_state.ts`, loop gatherers + intent handlers, stub panels). Wave 1 = 5 parallel worktree agents on disjoint files (A Nav, B Logs, C Factions, D sequencer publisher, E game_agent twin). Wave 2 = integrate + tab/resize/persist + verify.

## Lessons (folded into [[10-parallel-build-playbook]])

1. **Worktree base defaults to `origin/<default-branch>`, not local HEAD.** Wave 0 was unpushed, so all five agents branched from the stale origin tip and lacked the seam. Fix next time: push the seam first, or set `worktree.baseRef: head`. (Playbook §3.)
2. **Worktrees lack `node_modules`** → agent-side `tsc` shows phantom `@ns` errors; verify in the main tree. (Playbook §4.)
3. **Stale-based existing-file edits can't be git-merged** without reverting prior work — re-apply diffs by hand. (Playbook §4.)
