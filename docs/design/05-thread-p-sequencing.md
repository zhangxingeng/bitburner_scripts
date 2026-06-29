# Thread-P Sequencing — The Autonomous Player Brain

> Formalizes the architecture decision from [handoff-autoplay.md](../handoff-autoplay.md) §3:
> where the Thread-P brain lives, how it sequences trusted actions, and how it surfaces
> judgment calls over the control channel. **Ratified by the user 2026-06-29.**
>
> **Document-first: no code on any of this until this doc is ratified.** (design/04 §0)
>
> Prereqs: [00-architecture-philosophy.md](00-architecture-philosophy.md) §2.5 (capability
> boundary), [04-player-automation-and-control.md](04-player-automation-and-control.md) §4
> (MCP control surface), [mcp-control-channel-usage.md](../mcp-control-channel-usage.md) §4
> (toolbox).

---

## 0. The Decision — Ratified

**Option A for the autonomous core; Option B for the judgment layer.**

- **(A) In-game daemon** — `src/cross/player_sequencer.ts` owns the Thread-P sequencing loop.
  Reads `getPlayer`/factions/augs/phase, decides the next trusted action, fires it via
  `ns.exec`/terminal injection, and verifies via read-back. Pushes judgment calls to
  PORT_NOTIFY (9) and logs to PORT_DECISION (4). Runs whether or not an MCP session is attached.
- **(B) MCP agent / user** — pinged only for genuine judgment calls (aug purchase, reset timing,
  BitNode choice). Reads via `get_notifications`; answers via `write_port`/`terminal`.

**Rationale:** matches design/04 §4 ("autonomous where trusted") and the existing daemon model.
The in-game brain does the trusted grind perpetually; the agent is paged only when a decision
cannot be settled by stats alone. Running (A) without (B) is still useful; running (B) without
(A) means the brain only operates while a session is attached.

**Autonomy model — default-human, fully toggle-able to full auto.** The system ships with
judgment defaults OFF (human decides irreversible spends). The player can flip any individual
feature — or all of them — to full auto via the centralized settings object (§1). This is a
player choice, not an architectural limit. Every module reads its permitted autonomy level from
settings before acting.

---

## 1. Centralized Configuration

**The settings object is the single source of truth for autonomy.** Think of it as a Pydantic
settings model in TypeScript: one strongly-typed object with sensible defaults, imported wherever
a module needs to know what it may do unattended.

**Proposed path:** `src/lib/settings.ts` — TODO(design): finalize shape before first build.

```ts
// src/lib/settings.ts (proposed — TODO)
export interface BrainSettings {
    // -- Autonomy switches (judgment items default OFF) --
    autoJoinFactions:    boolean;   // default true  (safe; reversible)
    autoBuyPrograms:     boolean;   // default true  (safe; reversible)
    autoSolveContracts:  boolean;   // default false (manual until solver is leaned)
    autoBuyAugs:         boolean;   // default false (irreversible spend)
    autoReset:           boolean;   // default false (point-of-no-return)
    autoBitNode:         boolean;   // default false (irreversible strategic fork)

    // -- Tunables --
    brainRamFloorGb:     number;    // default 16  — home RAM needed to auto-start sequencer
    verificationDelayMs: number;    // default 500 — wait after action before read-back
    tickIntervalMs:      number;    // default 5000 — sequencer loop cadence
}

export const DEFAULT_SETTINGS: BrainSettings = {
    autoJoinFactions:    true,
    autoBuyPrograms:     true,
    autoSolveContracts:  false,
    autoBuyAugs:         false,
    autoReset:           false,
    autoBitNode:         false,
    brainRamFloorGb:     16,
    verificationDelayMs: 500,
    tickIntervalMs:      5000,
};
```

The sequencer (§3) checks the relevant switch before firing any action. The configuration UI
(§8) renders this object as toggles and writes changes back — it is the natural seam the UI
hangs off. The player never edits `settings.ts` directly once the UI exists.

---

## 2. Staged Bootstrap

**One human trigger, then the system self-stages gated on RAM.**

The tight-RAM constraint (8 GB home early game) prevents the brain from co-locating with
`game_agent`. The bootstrap ladder solves this automatically:

| Stage | RAM gate | What happens | Notes |
|-------|----------|--------------|-------|
| 0 — Survive & earn | any | Root network, spray simple hackers, start income | `bootstrap.ts` already handles this |
| 1 — Ramp RAM to floor | home < `brainRamFloorGb` | Auto-buy home RAM upgrades / cheap pservers | Loop until home clears the floor (~16 GB) |
| 2 — Online the brain | home ≥ `brainRamFloorGb` | `bootstrap.ts` auto-starts `player_sequencer` | No second human action needed |
| 3+ — Widen | growing | More compute, more trusted actions, full reset cycle | Brain handles from here |

**Key principle:** the brain's start is automatic but conditional on RAM. The RAM floor
(`brainRamFloorGb`) is a tunable in `BrainSettings` (§1), defaulting to 16 GB. The single
human trigger is `run /bootstrap.js`; everything after is self-staged.

`game_agent` (~6.6 GB) alone cannot fit the brain (~4 GB target) on an 8 GB home — Stage 1
must complete before Stage 2 fires. `bootstrap.ts` detects the floor crossing via
`ns.getServerMaxRam('home')` each tick and launches the sequencer once it clears.

---

## 3. The Sequencer Loop

**Proposed daemon:** `src/cross/player_sequencer.ts`, launched by `bootstrap.ts` at EARLY phase
(once home RAM > `brainRamFloorGb`). Add it to `DAEMON_CATALOG` in `lib/config.ts` with
`minPhase: EARLY`.

### State it reads each tick

| Signal | Source | Cost |
|--------|--------|------|
| Current phase | `peekPort(ns, PORT_PHASE)` (PORT_PHASE = 8) | 0 GB |
| Player stats | `ns.getPlayer()` via `lib/ns_dodge.ts` | dodged |
| Faction standings | `ns.singularity.getFactionRep()` (SF4-gated) | dodged |
| Pending augs count | `peekPort(ns, PORT_AUGS)` (PORT_AUGS = 11) | 0 GB |
| Running scripts | `ns.ps('home')` | ~0.2 GB |
| Pending judgment | `peekPort(ns, PORT_DECISION)` for reply frame | 0 GB |
| Autonomy settings | imported `BrainSettings` object (§1) | 0 GB |

All Singularity calls route through `lib/ns_dodge.ts` — the sequencer itself stays lean; the
dodger script pays the RAM cost and exits.

### Decision loop (design-level)

```
each tick (~5 s):
  1. read phase from PORT_PHASE
  2. if phase == RESET → surface judgment (§7) and idle
  3. read player state (via ns_dodge if SF4; from ns.getPlayer() always)
  4. pick next trusted action from the priority queue (§4)
  5. check settings — skip if autonomy switch is OFF (surface notification instead)
  6. check double-spawn guard (ns.isRunning) before launching anything
  7. fire action via ns.exec or PORT_LAUNCHER inject
  8. sleep verificationDelayMs, then read back (§6)
  9. on failure: retry once, then surface via PORT_NOTIFY
```

The sequencer is **serial by design** — Thread-P is a single actor. It does one thing at a time
and waits for it to complete or stabilize before moving on.

---

## 4. Trusted vs. Judgment Classification

### Trusted — fires autonomously when switch is ON (SF4 assumed)

| Action | Module | Verify via | Default |
|--------|--------|-----------|---------|
| Join eligible factions | `player/faction_manager.js` | `ns.getPlayer().factions` | auto ON |
| Buy TOR + port openers | `player/program_acquirer.js` | `ns.fileExists('BruteSSH.exe', 'home')` etc. | auto ON |
| Solve coding contracts | `player/contract_solver.js` | script exits 0 (RAM caveat §9) | manual (OFF) |
| Travel to faction city | `player/goto.js <target>` | `ns.getPlayer().city` | auto ON |
| Start crime/faction grind | `player/crime.js` | ns.getPlayer activity | auto ON |

**Pre-SF4:** Singularity modules fail safely (they self-check). The sequencer detects SF4 from
`ns.getPlayer().sourceFileLvl(4)` (via ns_dodge) before queueing these.
**Pre-SF4 behavior (resolved):** idle + notify-only; no auto-trigger of Singularity modules
until SF4 detected.

### Judgment — default human-decides; configurable to auto via settings

| Decision | Trigger | Why judgment | Settings key |
|----------|---------|--------------|--------------|
| Aug purchase | `PORT_AUGS >= PHASE_RESET_MIN_AUGS` (= 10) | Irreversible spend; strategic tradeoff | `autoBuyAugs` |
| Reset / install augs | Phase == RESET | Point of no return for current node | `autoReset` |
| BitNode selection | Post-install | Irreversible strategic fork | `autoBitNode` |
| Any spend without a clear rule | ad-hoc | Scarce resource + ambiguous best choice | — |

**Rule:** if the decision cannot be settled purely from stats (money, rep thresholds, clear
priority rules), it is a judgment call. The sequencer recommends with numbers, surfaces, and
waits — unless the relevant settings switch is ON, in which case it acts on the recommendation.

---

## 5. Decision / Notify-and-Wait Protocol (end-to-end)

### Emit (brain side)

```
notify(ns, "12 augs affordable — reset?",
       "run /player/aug_planner.js --purchase",
       { pendingAugs: 12, money: ns.getPlayer().money })
```

`notify()` (in `src/cross/notification.ts`) pushes a `Notification` JSON frame to PORT_NOTIFY (9)
and prints to the script log. Non-blocking — returns immediately.

`game_agent` drains PORT_NOTIFY each tick into `status/notifications.txt` (rolling 500-entry
array). The MCP `get_notifications` tool serves this buffer sub-ms.

### Surface (control channel)

MCP agent (or user) reads `get_notifications` → sees the judgment frame with `recommendation`
field showing the exact command to approve.

### Answer (human/agent side)

**Resolved for milestone 1:** terminal command via PORT_LAUNCHER (12) is the canonical primary
answer channel — simpler and already proven end-to-end. Structured PORT_DECISION approval is
added later when the brain needs to gate multi-step sequences.

| Path | Mechanism | When to use |
|------|-----------|-------------|
| Terminal command | `terminal("run /player/aug_planner.js --purchase")` | **Primary (milestone 1):** agent approves a specific action |
| Port approval | `write_port(PORT_DECISION, '{"type":"APPROVE","action":"aug_purchase"}')` | Later: structured approval for brain to gate multi-step sequences |

The terminal path triggers the action directly (via PORT_LAUNCHER = 12 relay in `game_agent`).
The port path signals intent without acting — useful when the sequencer should drive the action
(e.g., needs to sequence multiple steps before firing).

### Consume (brain side)

For terminal-driven approvals, the sequencer detects completion by read-back (§6).

For port-driven approvals, the sequencer polls PORT_DECISION for `{type:"APPROVE"}` frames in
its main loop. Since phase_detector also writes to PORT_DECISION (phase transitions with
`type:"PHASE_CHANGE"`), the sequencer distinguishes by the `type` field — PHASE_CHANGE frames are
ignored; APPROVE frames are consumed and acted upon.

### Wait primitive

Use `notifyAndWait(ns, msg, condition, recommendation, data)` from `src/cross/notification.ts`
when the sequencer has nothing else useful to do while waiting:

```
await notifyAndWait(
    ns,
    "12 augs affordable — reset?",
    () => peekPort(ns, PORT_DECISION) !== null,  // wait for approval signal
    "run /player/aug_planner.js --purchase",
    { pendingAugs: 12 },
);
```

`notifyAndWait` re-notifies every 30 s so stale notifications stay visible. Returns `true` if
condition met; `false` on the 5-minute timeout (then re-evaluates and re-notifies).

---

## 6. Verification Contract

After each trusted action, read back state to confirm it landed. Retry once on mismatch; surface
on second failure.

| Action | Verify by | On failure |
|--------|-----------|-----------|
| Faction join | `ns.getPlayer().factions.includes(name)` | retry once, then notify |
| Program buy | `ns.fileExists('BruteSSH.exe', 'home')` etc. | retry once, then notify |
| Contract solve | script exit (check `!ns.isRunning(script, 'home')`) | notify with contract id |
| Travel | `ns.getPlayer().city === target` | retry once, then notify |
| Aug purchase | `ns.singularity.getOwnedAugmentations(true).includes(aug)` | notify, hold reset |

Verification uses `get_screen` (rendered terminal tail) as a secondary signal when the API read
is ambiguous — e.g., confirming a purchase printed the expected success line. The 10 ms control
channel round-trip makes this cheap.

---

## 7. Reset Cycle

**Trigger:** `phase_detector` classifies RESET when `pendingAugs >= PHASE_RESET_MIN_AUGS` (= 10,
from `src/lib/config.ts`). It reads `PORT_AUGS` (11), which `aug_planner` writes after evaluating
affordable augmentations. The confirmed RESET phase is published to PORT_PHASE (8).

**Sequencer behavior on RESET:**

1. Detects RESET phase from PORT_PHASE.
2. Calls `notifyAndWait` with the pending aug count and recommendation.
3. Checks `settings.autoReset` — if ON, proceeds; if OFF (default), **waits for approval**
   over PORT_LAUNCHER (terminal command, milestone 1 primary) or PORT_DECISION.
4. On approval (or auto-proceed):
   - Fire `player/aug_planner.js --purchase` via PORT_LAUNCHER.
   - Verify augs were purchased via `ns.singularity.getOwnedAugmentations(true)`.
   - Fire `ns.singularity.installAugmentations('/bootstrap.js')` via PORT_LAUNCHER inject.
   - The game resets; bootstrap re-runs; sequencer restarts from BOOTSTRAP phase on the new node.

**Default: no auto-reset.** The installation call is irreversible. `autoReset` defaults OFF;
the sequencer never fires it without an explicit approval signal unless the player enables it.

---

## 8. Configuration UI

**Goal:** render the `BrainSettings` object (§1) as live controls a human can click. Wire it
as soon as the settings object exists — not big-bang, not dead-last.

**Decision (manager):** build the settings object + brain skeleton first; the UI hangs off the
object immediately after.

### Proposed file

`src/ui/config_dashboard.tsx` — TODO(design): create once settings.ts shape is finalized.

Note: `src/cross/reporter.ts` already carries a `TODO(design)` pointing at
`#overview-extra-hook-0` React injection (the placeholder file-dump approach). The dashboard
is the natural evolution or replacement of that TODO.

### React injection technique (community-standard; verified against reference repos)

**Zero-RAM shim for React/ReactDOM — `src/lib/react.ts` (proposed — TODO):**

```ts
// src/lib/react.ts (proposed — mirrors inigo's libReact.ts)
export function getReact() {
    return (eval("window") as any).React as typeof import("react");
}
export function getReactDOM() {
    return (eval("window") as any).ReactDOM as typeof import("react-dom");
}
```

`eval("window")` reads the game's bundled `window.React` and `window.ReactDOM` at runtime. The
static RAM analyzer never sees the literal tokens, so **no RAM charge**. Mirrors
`inigo-bitburner-scripts/src/react/libReact.ts` exactly (git-ignored reference, example_code_dump/).

**Mount point:**

```ts
const hookNode = (eval("document") as Document).getElementById("overview-extra-hook-0");
ReactDOM.render(<ConfigPanel ns={ns} />, hookNode);
```

Bitburner ships `#overview-extra-hook-0`, `#overview-extra-hook-1`, `#overview-extra-hook-2` as
purpose-built HUD slots for scripts. Use hook 0. Cleanup on exit:

```ts
ns.atExit(() => ReactDOM.render(null, hookNode));
```

**Controls:**

- `<input type="checkbox" checked={settings.autoBuyAugs} onChange={...} />` for each autonomy toggle.
- `<button onClick={...}>Buy recommended augs</button>` and `<button onClick={...}>Reset now</button>`
  for one-shot actions.

**NS-safety — critical:** all `ns.*` calls stay **outside** the React tree. The NS loop pings
the component via a per-PID DOM custom event:

```ts
// NS loop (outside React):
window.dispatchEvent(new CustomEvent(`bb-config-${ns.pid}`, { detail: latestSettings }));

// Inside ConfigPanel (useEffect):
useEffect(() => {
    const handler = (e: CustomEvent) => setSettings(e.detail);
    window.addEventListener(`bb-config-${ns.pid}`, handler as EventListener);
    return () => window.removeEventListener(`bb-config-${ns.pid}`, handler as EventListener);
}, []);
```

This mirrors the existing ns-from-callback rule — no `ns.*` calls inside React handlers or
`setInterval` within the component. Button `onClick` handlers write to a local ref that the NS
loop drains on next tick.

**Capability boundary:** UI interfacing only (rendering controls a human could click). Must NOT
read React internals or hidden game state for data — only render/act. This is squarely within
design/04 §2.5 permitted use of stealth-DOM.

**React version caveat:** Bitburner bundles React 17 (not 18). Use `ReactDOM.render` /
`ReactDOM.render(null, node)` — not `createRoot` / `root.unmount()`. Inigo's
`newUiDashboard.tsx` uses the React 17 API; follow that. TODO(design): confirm React version
against current game bundle before writing JSX.

**Reference files** (git-ignored, in example_code_dump/):
- `inigo-bitburner-scripts/src/react/newUiDashboard.tsx` — full HUD panel example
- `inigo-bitburner-scripts/src/react/libReact.ts` — eval-window shim
- `alainbryden-bitburner-scripts/stats.js`, `stockmaster.js` — overview-extra-hook-0 mount patterns

`src/cross/launcher.ts` is the existing DOM-touching file and shows the project's `eval`-dodge
convention — the same pattern applies here.

---

## 9. RAM Budget

RAM is the binding constraint. Every new daemon must pass a `calculate_ram` pre-flight.

| Script | Measured RAM | Notes |
|--------|-------------|-------|
| `game_agent.js` | ~6.55–6.65 GB | Must run for MCP port I/O to work |
| `bootstrap.js` | ~4.8 GB | Orchestrator; exits after daemons launched |
| `phase_detector.js` | ~4.45 GB | Inlined BFS; runs on any rooted server |
| `contract_solver.js` | ~22 GB | Too heavy to auto-trigger; lean before enabling |
| `player_sequencer.js` | TBD | Target: ≤ 4 GB; all Singularity calls via ns_dodge |

**The sequencer MUST run lean.** It should not import any heavy compute module. Singularity API
calls (which carry a 16 GB base cost) route through `lib/ns_dodge.ts` — a 1.6 GB temp script
that executes the call and exits. The sequencer's own binary should carry only port helpers,
`ns.getPlayer`, `ns.exec`, `ns.isRunning`, `ns.ps`, and `ns.sleep` — all low-cost.

On an 8 GB home, `game_agent` (~6.65 GB) fills most of the RAM. The sequencer cannot co-locate
with it on 8 GB. At 16 GB (EARLY phase), both fit if their combined footprint stays under ~14 GB
(leaving `DAEMON_LAUNCH_RESERVE = 2 GB`). Verify with `calculate_ram` before committing to a
home-only deployment; if tight, run the sequencer on a rooted pserver instead.

**`contract_solver` (22 GB) is manual-only until leaned.** Trigger it via the control channel
(`write_port(12, "run /player/contract_solver.js")`), not the auto queue. This is an open build
task (handoff-autoplay §6 Problem 3). `autoSolveContracts` defaults OFF in settings (§1).

---

## 10. First Milestone

**Build target:** the smallest closed Thread-P loop that demonstrates the full perceive → decide →
act → verify → surface pattern, plus the configuration seam for everything that follows.

Ships:

1. **`src/lib/settings.ts`** — the `BrainSettings` object with judgment defaults OFF. This is
   the foundation everything else reads.
2. **`player_sequencer` brain skeleton** — stages 0–2 of the bootstrap ladder (§2) auto-online
   it once home RAM crosses `brainRamFloorGb`. No second human trigger needed.
3. **Closed Thread-P loop on a fresh node with SF4:**
   - **Auto-joins eligible factions** the moment requirements are met — confirms via
     `ns.getPlayer().factions`, retries on mismatch.
   - **Triggers `program_acquirer`** — confirms port-opener files exist on home.
   - **Triggers `contract_solver`** (manually via PORT_LAUNCHER, not auto) — confirms via
     script-exit read.
   - **Surfaces the first aug-purchase decision** over the control channel — `get_notifications`
     shows the judgment frame with aug count and recommendation; agent or user approves via
     `terminal`/`write_port`.

**Immediate follow-on (not blocked on milestone 1 completion):** wire `src/ui/config_dashboard.tsx`
off the settings object seam — this is the UI's natural entry point. Once `BrainSettings` exists,
the UI can be built and iterated without touching the brain.

---

## 11. Open Questions / TODO(design)

**Resolved:**

- **Answer channel (milestone 1):** terminal command via PORT_LAUNCHER (12) is the canonical
  primary. Structured PORT_DECISION approval added later when the brain needs to gate multi-step
  sequences. *(Resolved — mark done for milestone 1.)*
- **Pre-SF4 behavior:** idle + notify-only; no auto-trigger of Singularity modules until SF4
  detected via `ns.getPlayer().sourceFileLvl(4)`. *(Resolved — default behavior.)*
- **`contract_solver` RAM:** manual-only (`autoSolveContracts` OFF) until the solver is leaned
  below ~8 GB. Not on the auto queue for milestone 1. *(Resolved — default behavior.)*

**Remaining:**

- **TODO(design): `settings.ts` shape finalization.** Confirm the `BrainSettings` interface
  (field names, types, defaults) and the file path (`src/lib/settings.ts`) before first build.
  Decide persistence strategy (in-memory object vs. written to a status file for cross-script
  visibility).
- **TODO(design): sequencer RAM target.** Run `calculate_ram` on the skeleton before adding
  imports. Decide whether home or a rooted pserver is the deployment target at EARLY phase.
- **TODO(design): `react.ts` shim.** Confirm `eval("window").React` resolves correctly on the
  current game bundle before writing `src/lib/react.ts`. Check React version (expect 17 —
  see §8 caveat).
- **TODO(design): `config_dashboard.tsx`.** Finalize component structure, mount lifecycle, and
  the NS-loop → custom-event bridge pattern. Proposed path: `src/ui/config_dashboard.tsx`.
- **TODO(design): React 17 vs 18.** Verify game bundle uses React 17 (`ReactDOM.render`) not
  React 18 (`createRoot`). Inigo's reference uses React 17 API — follow that until confirmed
  otherwise. Do not use `createRoot`.
- **TODO(design): PORT_DECISION contention.** `phase_detector` writes `{type:"PHASE_CHANGE"}`
  frames there; the sequencer would write/read `{type:"APPROVE"}` frames. Confirm the
  `game_agent` mirror to `status/decisions.json` is non-destructive (drains but keeps rolling
  history) so both producers can coexist.
- **TODO(design): DAEMON_CATALOG entry for player_sequencer.** Add once RAM is measured and the
  minPhase confirmed. Candidate: `{ key: 'playerSequencer', path: '/cross/player_sequencer.js', minPhase: DesignPhase.EARLY }`.

---

*Status: RATIFIED (decision, shape, and configuration model). Not yet built. Build pending:
`src/cross/player_sequencer.ts`, `src/lib/settings.ts`, `src/ui/config_dashboard.tsx`.
Derived from [handoff-autoplay.md](../handoff-autoplay.md) §3 +
[04-player-automation-and-control.md](04-player-automation-and-control.md) §4.*
