# Design 08 — Central Control Console (the brain's UI surface)

**Status:** RATIFIED vision + architecture (user 2026-06-30). Seed built in milestone 2; the console proper is the next build phase. Doc-first capture so it survives compaction.

**Companion notes:** [[05-thread-p-sequencing]] (the brain it fronts), [[06-ui-navigation]] (Navigator + gear anchor it uses), [[07-dev-loop-tooling]] (how we verify it), [[autoplay-architecture-decision]] (A/B split — the console is the *attended* face of layer B).

---

## §0 Vision — what this becomes

The floating panel built in milestone 2 (`src/ui/config_dashboard.tsx`) is **the seed of a central control console**, not the end state. It grows from "brain-config toggles" into the primary **human ↔ system surface**: a single self-owned in-game window, opened by the toolbar button beside Save/Kill, that displays system state **reactively** and exposes controls + **surfaced judgment calls** as the autonomous system expands.

It is the **attended-mode counterpart to the MCP control channel** (the unattended/agent surface). Both read the *same* NS-loop state and write the *same* mailboxes — the console is just the in-game face. When a human is watching the game, the console is how they see and steer; when nobody is, the MCP agent does the same over ports.

User framing (2026-06-30): *"this is not just about brain config — in the future as things expand we will use this as a central control console of sorts to display stuff reactively and other stuff."*

## §1 Why a console (vs scattered tail windows / terminal commands)

- **One discoverable entry point** — the toolbar button (next to Save / Remote-API / Kill). No commands to remember.
- **Self-owned DOM** — a `document.body` portal (built). Full control of our UI; minimal injection into game chrome (exactly one button).
- **Page-independent & persistent** — lives on `body`, so it survives navigation and is always reachable, draggable, out of the game's way.
- **Consolidation** — config (done), live monitoring, decision surfacing, quick actions all in one place instead of N tail windows + `get_monitoring` scraping.

## §2 Architecture — the proven milestone-2 pattern, generalized

The config panel already established the safe shape; the console generalizes it. **Do not invent a new pattern — widen this one.**

- **Single owner script** (rename target: `control_console.tsx`) runs as one in-game daemon and is the **ONLY `ns.*` caller**.
- **NS loop → UI (read path):** each tick the loop builds a typed `ConsoleState` snapshot (settings, pendingAugs, RAM/income/phase, pending decisions, recent notifications…) and dispatches it via a per-PID `CustomEvent`. Widgets subscribe with `useEffect`. **Never call `ns.*` inside React** (§3).
- **UI → NS loop (action path):** widgets push intents into module-level outbound mailboxes (today: `outboundSettings` / `outboundAction`); the loop drains + executes each tick (`saveSettings`, `ns.run`, `ns_dodge` Singularity, `Navigator.goTo`). Generalize to a small `outboundIntents: Intent[]` queue.
- **Panel registry (the key generalization):** the console **shell** renders a list of registered `Panel`s. A `Panel = { id, title, render(state, dispatch) }`. Adding a feature = add a panel module + register it; the shell never changes. Milestone 2's toggles/buttons become the first panel (`ConfigPanel`).
- **Layout:** draggable shell (built). Add collapse/resize + tabbed or sectioned panels; persist position/size/open-state (§6).

## §3 Capability-boundary contract (unchanged — restated so it can't drift)

- **Display only legitimately-held data:** `ns.*` results the loop already gathered, plus our own status files. **Never read React/game internals for hidden data.** (The Navigator's fiber use is *action-only* — clicks — never data exfiltration; see [[06-ui-navigation]] §1.)
- **All `ns.*` lives in the loop.** The React tree is pure presentation + mailbox writes. This is the NS-from-callback rule.
- **Actions are things a human could do:** toggles, buys, resets, page navigation (via Navigator). Irreversible spends (augs/reset/BitNode) stay **default-human**, fully toggle-able to auto ([[autoplay-architecture-decision]]).

## §4 Candidate panels (roadmap — build incrementally, each shippable)

1. **ConfigPanel** — *DONE* (config_dashboard): autonomy toggles + Buy-augs / Reset.
2. **MonitorPanel** — live RAM, income/sec, money, current phase, active daemons; reactive (replaces eyeballing tail windows / `get_monitoring`). Read-only → lowest risk, validates the reactive display path first.
3. **DecisionsPanel** — surface judgment calls inline (BitNode choice, reset timing, scarce/irreversible spends) with **Approve / Deny / Defer** → writes the decision queue the sequencer reads. The **attended twin of `PORT_DECISION`/MCP**; closes the human-in-the-loop without the MCP agent attached. *Highest value.*
4. **Factions/AugsPanel** — progress toward target augs, eligible factions, one-click join (Navigator + ns).
5. **QuickNavPanel** — buttons to jump pages via `Navigator.goTo` (useful + dogfoods the Navigator).
6. **LogPanel** — recent `notify()` stream / errors.

## §5 Migration plan (incremental, no big-bang)

- **M2 (done):** single ConfigPanel + toolbar button + NS↔React bridge + visible Reddit-mascot icon.
- **Step A — shell refactor (DONE 2026-06-30):** renamed `config_dashboard` → `control_console`; extracted the toggles/actions into `src/ui/panels/config_panel.tsx` (`configPanel: Panel`); the shell (`ConsoleShell`) renders a `PANELS` registry list; behavior unchanged. `SCRIPT_PATHS.configDashboard`→`controlConsole` + `DAEMON_CATALOG` key updated; old `config_dashboard.{tsx,js}` removed. Typecheck + node-syntax clean; Tier-2 (user) pending. (No new DOM selectors → milestone-2 Tier-1 still covers the injection path.)
- **Step B — types (DONE alongside A):** `ConsoleState` + `Intent`/`Dispatch`/`Panel` defined in `src/ui/console_types.ts`; the loop drains a single `outboundIntents: Intent[]` queue. `ConsoleState` still minimal (settings + pendingAugs) — widens in Step C.
- **Step C — MonitorPanel:** read-only reactive display; proves the data path end-to-end.
- **Step D — DecisionsPanel:** wire to the sequencer's decision queue (reuse `PORT_DECISION` so MCP + console share one queue). The high-value attended-autonomy piece.
- **Step E — layout polish:** tabs, resize, persistence.

Each step: typecheck, Tier-1 (Playwright DOM logic), Tier-2 (compiled in the running game — user drives), then commit. ([[07-dev-loop-tooling]])

## §6 Open questions / TODO(design)

- **Tabs vs single scroll?** Lean tabs once >2 panels.
- **Persistence:** position/size/open-state/active-tab → `status/settings.json` or a dedicated `status/ui_state.json`?
- **Re-render cadence vs perf:** throttle the state `CustomEvent` to ~1–2 Hz; heavy panels opt into slower ticks. The loop already sleeps `tickIntervalMs`.
- **Decision queue transport:** confirm a single shared shape so the MCP agent and the DecisionsPanel consume the *same* queue (`PORT_DECISION`), not two divergent ones.
- **Product name:** "Control Console" vs "Brain" — pick one for the button title / header (currently button title = "Control Console").
- **One window vs tear-off sub-windows** later (e.g. pop a MonitorPanel into its own draggable). Defer.

## §7 Notes carried from the build

- MUI is **not** on `window` (only `React`/`ReactDOM`). Icons must be **inlined SVG paths** copied from the game's own `@mui/icons-material` (done for the console button — Reddit mascot path + explicit theme-green `#00cc00`, since `color:inherit` rendered dark-on-dark). Same approach for any future icon.
- The toolbar row is a class-less flex `Box` with 3 children [save / Remote-API / kill]; anchor via `[aria-label="kill all scripts"]` → `closest('div').parentElement`, append our button (lands right of kill). Kept alive by idempotency guard + MutationObserver + per-tick re-assert. ([[06-ui-navigation]] §4, Tier-1 verified.)
