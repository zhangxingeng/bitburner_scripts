# Design 06 — In-Game UI Navigation & Injection (the Navigator)

**Status:** RATIFIED (plan + scope approved 2026-06-30). **Built** — `src/lib/navigator.ts` implements this Navigator (`goTo`/`ensureTerminal`), consumed by `lib/dom.ts::navToPage` and `docs/design/14`. Doc-first capture of ground truth from the game source so it survives context compaction.

**Companion notes:** [[05-thread-p-sequencing]] (the brain this serves), 07-dev-loop-tooling (browser/Playwright verification — the external dev loop).

---

## §0 Why this note exists — the limitation it removes

The brain (Thread-P) must *act on the UI* — and the act path turned out fragile. Three live failures on 2026-06-30 (all in `memory/mcp-act-path-gotchas`):
1. `get_screen` is a ~1 Hz buffer, not a live read → stale frames read as "command didn't land."
2. A probe script failed to launch with `Cannot run … requires 1.60GB` → **home RAM exhaustion**, not a UI problem.
3. Terminal command injection **silently no-ops unless the game is on the Terminal page** (writes to `#terminal-input`, which is absent on other pages).

Root cause behind the repeated mis-diagnoses: **I cannot directly observe the live rendered DOM.** My only window was the terminal-text buffer + probe scripts (gated on RAM + an active terminal). The fix is two-pronged:

- **Ground truth from source** — `../bitburner-src` (`/home/shane/workspace/bitburner-src`, see `memory/game-source-checkout`) is the authoritative DOM/routing reference. Read it instead of blind-probing. All of §2–§4 below is derived from it.
- **Real eyes via a browser dev loop** — run the game at `localhost:8000` and inspect/verify with Playwright MCP, delegated to Sonnet subagents (design/07).

The deliverable of *this* note is the in-game **Navigator**: a zero-RAM module that lets a script switch the game to any sidebar page from anywhere, read the current page, and (critically) **ensure the Terminal page is active before injecting** — which closes failure #3 for good.

---

## §1 Capability boundary check

Navigation is **UI interfacing** (clicking the game's own controls / invoking the game's own click handlers), which is explicitly allowed by the capability boundary (design/00 §2.5 / design/04 §2.5): automate ACTION, not data ACCESS. We must NOT read React internals *for hidden game data* — but reaching the game's own `clickPage` callback to drive navigation a human could do by clicking is action, not data exfiltration. We never read save state, RNG, or game objects through the fiber; we only use it to *click*.

---

## §2 Game navigation — ground truth (from `bitburner-src`)

React **17.0.2**, rendered via legacy `ReactDOM.render` into `#root` (`src/index.tsx`). Navigation is a **React state update**, not URL/hash routing.

### §2.1 The Page enum (`src/ui/Enums.ts`) — value strings are the stable key
`Page = { ...SimplePage, ...ComplexPage }` (`src/ui/Router.ts`). The **value string** is what appears as the sidebar item's text. Sidebar-reachable `SimplePage` values we care about:
`Terminal`, `Script Editor`, `Active Scripts`, `Create Program`, `Stanek's Gift`, `Stats`, `Factions`, `Augmentations`, `Hacknet`, `Sleeves`, `Grafting`, `City`, `Travel`, `Job`, `Stock Market`, `Bladeburner`, `Corporation`, `Gang`, `IPvGO Subnet`, `Dark Net`, `Milestones`, `Documentation`, `Achievements`, `Options`, `Dev` (dev-only).
`ComplexPage` (need a context payload, NOT sidebar-reachable, out of scope for v1): `Faction`, `FactionAugmentations`, `ScriptEditor`, `Location`, `ActiveScripts`, `BitVerse`, `ImportSave`, `CustomPage`, …

### §2.2 Router API (`src/ui/Router.ts`)
```ts
interface IRouter {
  page(): Page;
  toPage(page: SimplePage): void;
  toPage<T extends ComplexPage>(page: T, context: PageContext<T>): void;
  back(): void;
  // allowRouting / hidingMessages also exist
}
```
A page switch ultimately calls `setNextPage(...)` (React state) in `GameRoot.tsx`; the big `switch (page)` renders the matching root.

### §2.3 Reachability from a script — **no global Router; use the React fiber**
Confirmed exhaustively: the only always-on global exposure is `globalThis.React` / `globalThis.ReactDOM` (`src/index.tsx`). `globalThis.Bitburner = {Player, …}` exists **only in dev builds** and does **not** include Router. So `eval("window")` gives DOM but **cannot read `Router`**. Also note `window.print`/`window.prompt` are overridden to throw — avoid them.

**Navigation IS reachable via the fiber bridge (preferred path):**
- Sidebar nav nodes carry React-17 expando keys `__reactFiber$<rand>` and `__reactProps$<rand>`.
- `SidebarRoot` passes a `clickPage` callback as a **prop** down to each `SidebarAccordion` (`SidebarRoot.tsx`). Reading `accordionFiber.memoizedProps.clickPage` and calling `clickPage("Factions")` routes through the real `Router.toPage` **with correct context handling**, and works **even when the accordion is collapsed / item off-screen**.
- `clickPage` only covers sidebar pages; it throws for complex pages it doesn't special-case — fine for v1 scope.

**Fallback path — synthetic DOM click:**
- React 17 delegates events at `#root`, so a native `.click()` on a nav `ListItem` fires the synthetic `onClick`. Navigation handlers do **not** check `event.isTrusted` (only casino/work/faction-accept/infiltration buttons do — none on nav). So `listItem.click()` navigates.
- Caveat: the item must be in the DOM — its accordion section must be expanded (sections use `Collapse unmountOnExit`, so collapsed = removed). Expand first by `.click()`ing the section header.

### §2.4 Sidebar DOM selectors (`src/Sidebar/ui/*`)
- Drawer: `.MuiDrawer-root` (paper `.MuiDrawer-paper`).
- Nav item: a `.MuiListItem-root` containing `.MuiListItemText-root > Typography` whose **text === the Page value string**. No ids/aria-labels/data-attrs on items — **text label is the hook**.
- Accordion section headers: `.MuiListItem-root` with text `Hacking` / `Character` / `World` / `Help`. Default open; user can collapse. A collapsed section's `Collapse` gets `.MuiCollapse-hidden`.
- Active item: extra tss-hashed `active` class (left-border). Class name is hashed → detect by computed `border-left` style, not by name.
- Many sidebar pages are conditional (gated by `canOpenFactions`, `canBladeburner`, etc. in `SidebarRoot.tsx`) — absent until unlocked. `goTo` must handle "item not present."

---

## §3 Navigator design — `src/lib/navigator.ts`

Zero-RAM (pure `eval('window')/eval('document')` + DOM; no `ns.*` → costs nothing, importable anywhere). Scope v1 = sidebar pages + current-page read + Terminal-ensure (ratified).

```ts
// Page value constants mirrored from bitburner-src/src/ui/Enums.ts (kept in sync manually).
export const GamePage = {
  Terminal: 'Terminal', ScriptEditor: 'Script Editor', ActiveScripts: 'Active Scripts',
  CreateProgram: 'Create Program', StaneksGift: "Stanek's Gift",
  Stats: 'Stats', Factions: 'Factions', Augmentations: 'Augmentations', Hacknet: 'Hacknet',
  Sleeves: 'Sleeves', Grafting: 'Grafting',
  City: 'City', Travel: 'Travel', Job: 'Job', StockMarket: 'Stock Market',
  Bladeburner: 'Bladeburner', Corporation: 'Corporation', Gang: 'Gang',
  IPvGO: 'IPvGO Subnet', DarkNet: 'Dark Net',
  Milestones: 'Milestones', Documentation: 'Documentation', Achievements: 'Achievements', Options: 'Options',
} as const;
export type GamePageValue = typeof GamePage[keyof typeof GamePage];
```

### API
- `goTo(page: GamePageValue): boolean` — navigate from anywhere. Returns true on success.
  1. **Primary (fiber):** locate a `.MuiDrawer-root` accordion node, read its fiber `__reactFiber$…`, walk up to the component holding `memoizedProps.clickPage`, cache that callback; call `clickPage(page)`. (Cache survives until a fiber lookup fails, then re-resolve.)
  2. **Fallback (DOM click):** if the fiber path throws/returns falsy, map page→section (Hacking/Character/World/Help), expand the header if `.MuiCollapse-hidden`, find the `ListItem` whose text === page, `.click()` it.
  3. If the page item isn't present (locked/conditional) → return false (don't throw). Caller decides.
- `currentPage(): GamePageValue | null` — find the nav item carrying the active left-border (computed-style probe) and return its text; null if none matched.
- `ensureTerminal(): boolean` — `if (currentPage() === 'Terminal') return true; return goTo('Terminal');` Used by the act path.
- (internal) `getFiberKey(el, prefix)`, `findClickPage()`, `findNavItem(text)`, `expandSectionFor(page)`.

### Robustness rules
- Idempotent + side-effect-free except the actual navigation.
- Never call `ns.*` (this is a pure DOM lib). Scripts that use it pass nothing.
- Tolerate missing DOM (return false), never throw into a caller's loop.
- All `eval('window'/'document')` access localized here; other modules import `goTo`/`currentPage`/`ensureTerminal`.

---

## §4 Toolbar / gear injection — corrected selectors (`src/ui/React/CharacterOverview.tsx`)

My earlier selectors were guesses and **wrong**; source ground truth:

- The Save / RFA-status / Kill-all row is the **last child of `CharacterOverview`** — a class-less flex `Box` (inline `borderTop` only, no id/class).
- Buttons (aria-label is the only stable hook):
  - `[aria-label="save game"]`
  - `[aria-label="Remote API status"]`
  - `[aria-label="kill all scripts"]`
- **Gear anchor:** `const kill = document.querySelector('[aria-label="kill all scripts"]'); const row = kill.closest('div').parentElement;` then append our gear `<span>`/IconButton into `row`.
- **React owns + re-renders this subtree (~600 ms cycle).** Keep the gear alive with: an **idempotency guard** (check our marker id before appending) **+ a `MutationObserver`** on `#root` (already the approach in the built panel). Re-assert each loop tick too.
- Alternative (more robust, less "in the toolbar"): inject into the inert `overview-extra-hook-0/1/2` Typography nodes which React leaves empty (`{}` children) and won't overwrite. **Decision: keep the gear in the toolbar row** (user wants it beside Save/Kill); use guard+observer.

Overview hooks confirmed: ids `overview-extra-hook-0/1/2` (and per-stat `overview-<name>-hook`); sidebar hooks `sidebar-extra-hook-0..3`.

---

## §5 Floating panel (built + Tier-1 verified)

`src/ui/control_console.tsx` (renamed from `config_dashboard.tsx` in design/08 Step A) implements: toolbar button → toggle event → self-owned draggable window on `document.body` (z-index 10000) that renders a `PANELS` registry; the first panel (`src/ui/panels/config_panel.tsx`) holds the 6 autonomy toggles + Buy-augs / Reset-now. NS-loop ↔ React bridge via per-PID CustomEvent (`ConsoleState`) + an `outboundIntents: Intent[]` queue, `saveSettings` round-trip, `ns.atExit` cleanup. Toolbar selectors corrected to §4 and Tier-1 verified. Button icon is an inlined `@mui/icons-material` Reddit (robot) SVG path with explicit theme-green (`#00cc00`) — MUI isn't on `window`, and `color:inherit` rendered dark-on-dark. **This panel is the seed of the central control console — see [[08-control-console]] for the vision, panel-registry architecture, and incremental migration plan.**

---

## §6 Act-path hardening (closes failure #3)

The launcher (`src/cross/launcher.ts`) injects terminal commands by writing to `#terminal-input`; off the Terminal page that element is absent → silent no-op. **Fix:** before injecting, call `ensureTerminal()` from the Navigator. Since the Navigator is zero-RAM and pure-DOM, this adds no RAM cost. This makes terminal injection reliable regardless of the player's current page — a prerequisite for unattended autonomy. (The MCP control channel's own injection has the same dependency; a small resident helper can `ensureTerminal()` on demand — see open questions.)

---

## §7 Build sequence (milestone)

1. **(this note + design/07)** — doc-first capture. ✅
2. `src/lib/navigator.ts` — `GamePage`, `goTo`, `currentPage`, `ensureTerminal` (+ helpers). Typecheck.
3. Fix `config_dashboard.tsx` gear selectors per §4.
4. `launcher.ts` — `ensureTerminal()` before injecting (§6).
5. **Verify live** (design/07): Sonnet subagents drive Playwright at `localhost:8000` (fresh game, no save) → confirm DOM matches source, exercise `goTo` for several pages, confirm gear sits beside Kill-all, panel opens/drags/toggles, settings round-trip. Screenshot evidence.
6. Commit to `main`.
7. Later: import save for SF4/progression behavior tests; extend Navigator to complex pages when a feature needs them.

---

## §8 Open questions / TODO(design)
- **MCP control-channel inject vs Terminal page:** the launcher fix covers in-game injection; does the MCP `terminal` op also need a resident "ensureTerminal" helper it can trigger over a port before injecting? (Likely yes — add a tiny port-driven helper.)
- **Navigator RAM/where it runs:** pure-DOM, zero RAM — confirm it imports cleanly into both `launcher.ts` (hot path) and UI scripts without dragging cost.
- **`clickPage` fiber resolution stability** across game updates — verify the prop name `clickPage` and fiber-walk live in Chrome; keep the DOM-click fallback as the safety net.
- **currentPage active-class probe** — verify the computed-border detection live (tss-hashed class).
- **Page-constant drift:** `GamePage` mirrors `Enums.ts` by hand — note to re-check on game version bumps.
