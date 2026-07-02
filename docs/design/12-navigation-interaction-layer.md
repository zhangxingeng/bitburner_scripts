# Design 12 — Navigation & Interaction Layer (Action Registry + act() Service)

**Status:** NOT NEEDED for any currently-scheduled roadmap item (re-audited 2026-07-02) — do not build the registry/`act()` service/Playwright-recon pipeline below without a concrete new use case. Companion to [[06-ui-navigation]] (page-level nav), [[10-parallel-build-playbook]] (build process), [[05-thread-p-sequencing]] (the brain).

> **2026-07-02 finding:** every action this doc's own registry targets in [[14-roadmap-to-full-autoplay]]'s Round 3 (company work, faction donation, grafting travel) turned out to have a plain `ns.singularity.*` equivalent with no DOM/`isTrusted` involvement at all — reachable through the same `executeCommand()`/`lib/ns_dodge.ts` idiom `faction_manager.ts`/`crime.ts` already use. The `isTrusted` blocks §1 catalogues only gate the **human UI's** onClick handlers, not the parallel Singularity API, and doc 00 already ratifies that pre-SF4 automation of these same actions is out of scope by design. Company work landed directly in `faction_manager.ts` this way (no `act()` layer, no DOM). The one action class that genuinely has no Singularity equivalent — casino blackjack — is a multi-turn interactive loop, not a single named click-action, so this doc's per-action registry shape wouldn't fit it anyway; it isn't on any scheduled round. If a future action class turns up that's genuinely DOM-only, re-evaluate this doc then — don't resurrect it speculatively.

**Capability boundary (ratified):** automate ACTION (invoke the game's own click handlers — same as a human clicking) NOT data access. We drive the UI; we never read hidden game state through the fiber.

---

## §0 Why this layer exists

`lib/navigator.ts` / `design/06` give us `goTo(page)` — zero-RAM sidebar page switching. That is **page-level** navigation. The brain also needs **in-page actions**: click "Travel to Aevum", pick a sleeve task, buy an augmentation, join a faction, donate. These have different DOM shapes across pages, some are gated by `event.isTrusted` (blocked to synthetic clicks), and some are SF4-gated Singularity calls. Without a registry that canonicalises these, every manager hand-rolls its own ad hoc DOM walk — unverifiable, fragile, and inconsistent.

This design establishes:
1. A **typed ACTION REGISTRY** — every action the brain can perform, keyed by ID, with two resolution strategies.
2. A **`act(actionId, params)` service** — the single call-site; chooses DOM vs SF4 automatically.
3. A **dev-time Playwright selector recon** — seeds and validates the registry without runtime cost.
4. **Integration rules** for the brain (sequencer / managers → `act()` by ID, not hand-rolled clicks).
5. A **wave-parallel build plan** following [[10-parallel-build-playbook]].

---

## §1 isTrusted audit — what DOM strategy can and cannot click

React 17 delegates events at `#root`; a native `.click()` fires the synthetic `onClick`. But some game handlers explicitly guard on `event.isTrusted` and silently no-op on untrusted (synthetic) events:

| Component | Handler | isTrusted? | DOM-clickable? |
|---|---|---|---|
| `TravelAgencyRoot.tsx` | `startTravel(city)` | ❌ no check | ✅ yes |
| `FactionRoot.tsx` | `startFieldWork/startHackingContracts/startSecurityWork` | ❌ no check | ✅ yes |
| `FactionRoot.tsx` | `onAugmentations` → Buy button | ❌ no check | ✅ yes |
| `FactionInvitationManager.tsx` | `join()` (popup modal) | ❌ no check | ✅ yes |
| `DonateOption.tsx` | `onDonate()` | ❌ no check | ✅ yes |
| `PersonObjects/Sleeve/ui/SleeveElem.tsx` | `setTask` confirm button | ❌ no check | ✅ yes (but Select manipulation needed) |
| `TorButton.tsx` | `buy()` | ❌ no check | ✅ yes |
| `FactionsRoot.tsx` | `acceptInvitation()` | ✅ **checks** | ❌ BLOCKED |
| `CompanyLocation.tsx` | `work()` | ✅ **checks** | ❌ BLOCKED |
| `CompanyLocation.tsx` | `startInfiltration()` | ✅ **checks** | ❌ BLOCKED |
| `SlumsLocation.tsx` | crime button | ✅ **checks** | ❌ BLOCKED |
| `ProgramsRoot.tsx` | create program | ✅ **checks** | ❌ BLOCKED |
| `HospitalLocation.tsx` | heal | ✅ **checks** | ❌ BLOCKED |

**Rule:** if the handler checks `event.isTrusted`, the action MUST use the SF4 path (or an alternative DOM route if one exists — e.g., the faction invite popup instead of FactionsRoot).

**Navigation to ComplexPages:** the City page buttons (`City.tsx`) call `toLocation(location)` which calls `Router.toPage(Page.Location, { location })`. We reach these via clicking city location buttons — they do NOT check `isTrusted`. This makes many location-level actions reachable via a City→button chain, but it adds a multi-step setup.

---

## §2 Action Registry

### §2.1 TypeScript shape

```ts
// lib/actions/registry.ts

import { GamePageValue } from '../navigator';

/** Params a particular action accepts (keyed by action id). */
export type ActionParams = {
  'travel-to-city':      { city: string };
  'join-faction':        { faction: string };
  'donate-to-faction':   { faction: string; amount: number };
  'buy-augmentation':    { faction: string; augName: string };
  'sleeve-assign-task':  { sleeveIndex: number; task: string; detail1?: string; detail2?: string };
  'apply-for-job':       { company: string; field: string };
  'purchase-tor':        Record<string, never>;
  'start-faction-work':  { faction: string; workType: 'field' | 'hacking' | 'security' };
  'accept-faction-invite':{ faction: string };
  // … extend as new actions are discovered
};

export type ActionId = keyof ActionParams;

/** How to locate and invoke the control via the DOM. null = not available via DOM. */
export interface DomStrategy {
  /** Page(s) to navigate to before attempting. First element = the sidebar page;
   *  subsequent steps are DOM-click traversals to subpages (e.g. City→Location). */
  navSteps: Array<
    | { type: 'goTo'; page: GamePageValue }
    | { type: 'clickText'; selector: string; text: string | ((p: ActionParams[ActionId]) => string) }
  >;
  /**
   * How to find + trigger the target control.
   * Locator strategy: prefer text content or structural DOM position over class names
   * (tss-react hashes MUI classes; they are UNSTABLE across game updates).
   */
  locate: (params: ActionParams[ActionId], doc: Document) => HTMLElement | null;
  /**
   * For controls that need a value set before clicking (e.g. donation amount input,
   * MUI Select dropdowns). Called before `locate` + click.
   */
  prepare?: (params: ActionParams[ActionId], doc: Document) => void;
  /** Human-readable stable selector hint (for Playwright recon and debug logs). */
  selectorHint: string;
}

/** SF4 Singularity fallback — runs via ns_dodge in a temp script so caller pays ~0 RAM. */
export interface Sf4Strategy {
  /** ns command string template, e.g. "ns.singularity.travelToCity(p.city)".
   *  Evaluated with the action params in scope as `p`. */
  command: (params: ActionParams[ActionId]) => string;
  /** GB cost at SF4 level 0/1/2/3 — for budget checks. */
  ramCostGb: { sf4L0: number; sf4L1: number; sf4L2: number; sf4L3: number };
}

export interface ActionResult {
  ok: boolean;
  detail: string;
  strategy: 'dom' | 'sf4' | 'none';
}

export interface ActionEntry<Id extends ActionId> {
  id: Id;
  description: string;
  /** Preconditions checked before attempting. Return null = OK; string = fail reason. */
  preconditions?: (params: ActionParams[Id]) => string | null;
  domStrategy: DomStrategy | null;   // null = no DOM path
  sf4Strategy: Sf4Strategy | null;   // null = no SF4 path
  /** How to confirm the action landed. Should read DOM/state, not rely on return value. */
  verify: (params: ActionParams[Id], doc: Document) => boolean;
}

export type Registry = { [Id in ActionId]: ActionEntry<Id> };
```

### §2.2 Concrete entries (4 examples)

#### Entry 1 — `travel-to-city`

```ts
'travel-to-city': {
  id: 'travel-to-city',
  description: 'Travel the player to a named city via the Travel Agency',
  preconditions: (p) => {
    // Can't check money without ns; verified by caller or by try+verify
    return null;
  },
  domStrategy: {
    navSteps: [{ type: 'goTo', page: 'Travel' }],
    // No confirmation modal when Settings.SuppressTravelConfirmation = true.
    // If false, a dialog appears — handled in domStrategy.prepare.
    prepare: (p, doc) => {
      // TravelAgencyRoot renders buttons with text "Travel to {city}".
      // No isTrusted guard; synthetic click works.
    },
    locate: (p, doc) => {
      // Text-based: find a <button> whose text content includes "Travel to {city}".
      for (const btn of Array.from(doc.querySelectorAll('button'))) {
        if (btn.textContent?.includes(`Travel to ${p.city}`)) return btn as HTMLElement;
      }
      return null;
    },
    selectorHint: 'button[text*="Travel to {city}"] inside Travel page',
  },
  sf4Strategy: {
    command: (p) => `ns.singularity.travelToCity(${JSON.stringify(p.city)})`,
    ramCostGb: { sf4L0: 32, sf4L1: 8, sf4L2: 8, sf4L3: 2 },
  },
  verify: (p, doc) => {
    // After travel, the City page shows the player's city in its heading.
    // Or probe via an ns_dodge call: ns.getPlayer().city === p.city.
    // DOM-only: look for city name in the page heading on the City page.
    const h = doc.querySelector('h4');
    return !!h && h.textContent?.includes(p.city as string) === true;
  },
},
```

#### Entry 2 — `join-faction`

```ts
'join-faction': {
  id: 'join-faction',
  description: 'Accept a pending faction invite and join the faction',
  preconditions: (p) => null,  // checked by verify; invite must exist
  domStrategy: {
    // FactionInvitationManager is a modal that appears when an invite is pending.
    // Its "Join" button does NOT check event.isTrusted.
    // Strategy: navigate to any page (modal is global), then find the modal's "Join" button
    // whose sibling Typography includes the faction name.
    navSteps: [],   // modal is global overlay — no page navigation needed
    locate: (p, doc) => {
      // FactionInvitationManager renders:
      //   <Modal>
      //     <Typography>Would you like to join <b>{name}</b>?</Typography>
      //     <Button>Join</Button>
      //     <Button>Decide later</Button>
      //   </Modal>
      // Stable hook: find the modal div, verify faction name text, return "Join" button.
      for (const btn of Array.from(doc.querySelectorAll('[role="dialog"] button'))) {
        if (btn.textContent?.trim() === 'Join') {
          const dialog = btn.closest('[role="dialog"]');
          if (dialog?.textContent?.includes(p.faction as string)) return btn as HTMLElement;
        }
      }
      return null;
    },
    selectorHint: '[role="dialog"]:contains(faction-name) button:text("Join")',
  },
  sf4Strategy: {
    // joinFaction works even without an invite popup — SF4 accepts the stored invite.
    command: (p) => `ns.singularity.joinFaction(${JSON.stringify(p.faction)})`,
    ramCostGb: { sf4L0: 48, sf4L1: 12, sf4L2: 12, sf4L3: 3 },
  },
  verify: (p, doc) => {
    // Modal should be gone; faction list page should show faction as member.
    // Lightweight: the modal for this faction should no longer be in the DOM.
    for (const dialog of Array.from(doc.querySelectorAll('[role="dialog"]'))) {
      if (dialog.textContent?.includes(p.faction as string)) return false;
    }
    return true;
  },
},
```

#### Entry 3 — `buy-augmentation`

```ts
'buy-augmentation': {
  id: 'buy-augmentation',
  description: 'Purchase an augmentation from a faction via the Augmentations page',
  preconditions: (p) => null,
  domStrategy: {
    // PurchasableAugmentation renders a "Buy" button per aug, no isTrusted check.
    // Path: Factions page → click faction → Purchase Augmentations → buy aug.
    // This is a multi-step DOM traversal; each step is a click + await-render.
    navSteps: [
      { type: 'goTo', page: 'Factions' },
      // Then click the faction's "Augments" button (FactionsRoot renders it).
      // NOTE: "Details" button also works but goes to FactionRoot, which needs
      // another click on "Purchase Augmentations". "Augments" shortcut preferred.
      {
        type: 'clickText',
        selector: 'button',
        text: (p) => 'Augments', // on the row that also contains faction name
      },
    ],
    locate: (p, doc) => {
      // PurchasableAugmentation renders:
      //   <Paper>
      //     <Button disabled={!canPurchase || owned}>Buy</Button>
      //     <Typography>{aug.name}</Typography>
      //   </Paper>
      // Find the Paper whose Typography has text === augName, return its Buy button.
      for (const paper of Array.from(doc.querySelectorAll('.MuiPaper-root'))) {
        const typos = Array.from(paper.querySelectorAll('.MuiTypography-root'));
        const hasName = typos.some(t => t.textContent?.trim() === p.augName);
        if (hasName) {
          const buyBtn = paper.querySelector('button');
          if (buyBtn && buyBtn.textContent?.trim() === 'Buy') return buyBtn as HTMLElement;
        }
      }
      return null;
    },
    selectorHint: '.MuiPaper-root:has(Typography:text("{augName}")) > button:text("Buy")',
  },
  sf4Strategy: {
    command: (p) =>
      `ns.singularity.purchaseAugmentation(${JSON.stringify(p.faction)}, ${JSON.stringify(p.augName)})`,
    ramCostGb: { sf4L0: 80, sf4L1: 20, sf4L2: 20, sf4L3: 5 },
  },
  verify: (p, doc) => {
    // The "Buy" button for this aug should now be disabled (owned) or the aug row
    // should show "Owned". Simple heuristic: look for the aug name next to an "Owned"
    // button or missing "Buy" button.
    for (const paper of Array.from(doc.querySelectorAll('.MuiPaper-root'))) {
      const typos = Array.from(paper.querySelectorAll('.MuiTypography-root'));
      if (typos.some(t => t.textContent?.trim() === p.augName)) {
        const btn = paper.querySelector('button');
        return !btn || btn.textContent?.trim() === 'Owned' || (btn as HTMLButtonElement).disabled;
      }
    }
    return false;
  },
},
```

#### Entry 4 — `sleeve-assign-task`

```ts
'sleeve-assign-task': {
  id: 'sleeve-assign-task',
  description: 'Assign a task to a sleeve (Commit Crime, Work for Faction, etc.)',
  preconditions: (p) => {
    if (p.sleeveIndex < 0) return 'sleeveIndex must be ≥ 0';
    return null;
  },
  domStrategy: {
    navSteps: [{ type: 'goTo', page: 'Sleeves' }],
    // SleeveElem renders per-sleeve cards with:
    //   <TaskSelector .../>   — three MUI <Select> dropdowns (task, detail1, detail2)
    //   <Button onClick={setTask}>Confirm</Button>
    // MUI Select manipulation: set value via the React fiber's onChange prop
    // (simpler than synthesizing a full MUI SelectChangeEvent).
    prepare: (p, doc) => {
      // Locate the N-th sleeve card (0-indexed) and set each Select's value via fiber.
      // Implementation in lib/actions/dom/sleeve.ts (see §6 build plan).
    },
    locate: (p, doc) => {
      // After prepare() has set the Select values, find the Confirm button for
      // the right sleeve card.
      const cards = doc.querySelectorAll('.MuiPaper-root');
      // SleeveRoot renders one card per sleeve; nth card = sleeve N.
      const card = cards[p.sleeveIndex as number];
      if (!card) return null;
      for (const btn of Array.from(card.querySelectorAll('button'))) {
        if (btn.textContent?.trim() === 'Confirm') return btn as HTMLElement;
      }
      return null;
    },
    selectorHint: '.MuiPaper-root:nth-child({N}) button:text("Confirm") after Select manipulation',
  },
  sf4Strategy: {
    // ns.sleeve.setTask(index, taskDesc) — note: sleeve API has its own RAM cost,
    // not in Singularity namespace.
    command: (p) =>
      `ns.sleeve.setTask(${p.sleeveIndex}, ${JSON.stringify(p.task)})`,
    ramCostGb: { sf4L0: 4, sf4L1: 4, sf4L2: 4, sf4L3: 4 },
  },
  verify: (p, doc) => {
    // The sleeve description text should update to mention the assigned task.
    // Lightweight: check that the Confirm button area no longer shows a mismatch.
    // Best effort — sequencer can retry if verify fails.
    return true; // implementation in dom/sleeve.ts verifies via card text
  },
},
```

---

## §3 act() Service — resolution policy

### §3.1 Signature

```ts
// lib/actions/service.ts

import { NS } from '@ns';
import { ActionId, ActionParams, ActionResult } from './registry';

/**
 * Perform any registered action by ID. Chooses DOM-first, SF4-fallback automatically.
 *
 * RAM COST: 0 GB for DOM path (pure eval('document') + no ns.*).
 *           ~0 GB for SF4 path (ns_dodge runs the Singularity call in a temp script).
 *
 * @param ns    NS instance — required only for the SF4 path; pass null for DOM-only callers.
 * @param id    The action ID from the registry.
 * @param params Parameters for this action.
 */
export async function act<Id extends ActionId>(
  ns: NS | null,
  id: Id,
  params: ActionParams[Id],
): Promise<ActionResult>;
```

### §3.2 Resolution policy (DOM-first, SF4-as-separate-script)

```
act(id, params):
  1. PRECONDITIONS — run entry.preconditions(params). If fails → return {ok:false, strategy:'none'}.

  2. DOM PATH (preferred, 0 RAM):
     a. Run navSteps:
        - For each {type:'goTo', page}: call goTo(page) from lib/navigator.ts (0 RAM).
        - For each {type:'clickText', ...}: find element by selector+text, .click() it,
          await short stabilisation (50–100 ms rAF tick) before next step.
     b. If domStrategy.prepare exists: run it (sets inputs, Select values, etc.).
     c. Call domStrategy.locate(params, document). If null → mark DOM failed, skip to step 3.
     d. .click() the element.
     e. Await stabilisation (~100 ms).
     f. Run entry.verify(params, document). If true → return {ok:true, strategy:'dom'}.
     g. If verify fails after 1 retry (wait 500 ms, re-verify) → log warning, fall through to SF4.

  3. SF4 PATH (fallback, ~0 RAM via ns_dodge):
     Conditions to attempt SF4:
       - domStrategy is null OR DOM path failed (step 2g).
       - entry.sf4Strategy is not null.
       - ns is not null (caller must provide it for SF4).
       - SF4 is available: sfLevel(ns) >= 1  (checked via ns_dodge / a pre-computed flag).
       - RAM budget: ns_dodge needs ~0 GB in the calling script; the temp script needs
         at least entry.sf4Strategy.ramCostGb[sfLevel] GB free on home — checked before launch.
     If conditions met:
       - Build the command string: entry.sf4Strategy.command(params).
       - Call executeCommand(ns, command) from lib/ns_dodge.ts.
       - Await result. If result indicates failure → return {ok:false, strategy:'sf4'}.
       - Run entry.verify(params, document) for confirmation.
       - Return {ok: true/false, strategy:'sf4'}.
     If conditions NOT met:
       - Return {ok:false, strategy:'none', detail:'no viable strategy'}.
```

### §3.3 RAM strategy, made explicit

| Path | RAM paid by caller | Notes |
|---|---|---|
| DOM | **0 GB** | `eval('document')` trick from `lib/react.ts`; no `ns.*` in DOM path |
| SF4 | **~0 GB** (caller) | `executeCommand()` in `lib/ns_dodge.ts` spawns a temp script on `home` that pays the real SF4 RAM cost, runs, writes result to file, exits. Caller only uses `ns.run` + `ns.read` + `ns.isRunning` — negligible. The temp script must fit in **available home RAM** at launch time. |

The SF4 RAM check (step 3, bullet 4) queries available home RAM before launching the temp script. If insufficient, the action is deferred and the caller receives `{ok:false, detail:'insufficient RAM for SF4 fallback'}`. The sequencer must then decide: wait, free RAM, or skip.

### §3.4 NS-from-callback rule (unchanged from design/11)

UI panels (React components) and DOM callbacks MUST NOT call `ns.*`. They enqueue `Intent` objects on the outbound queue. The sequencer's NS-holding loop dequeues them and calls `act(ns, id, params)`. The `ns` ref is never passed into React.

---

## §4 Selector seeding via Playwright

### §4.1 Role

Dev-time (NOT a runtime dependency). A single script (`dev/selector_recon.ts`) drives the real game UI at `localhost:8000` via Playwright MCP (`mcp__playwright__*`) to:
1. Navigate to each action's required page.
2. Confirm the DOM element described in `domStrategy.locate`/`selectorHint` is findable.
3. Record the precise stable locator (text content, structural path, fiber property if needed).
4. Check that the element is NOT `event.isTrusted`-guarded (by reading its onClick from fiber props and searching for `isTrusted`).
5. Emit a report: per-action PASS/FAIL + the verified locator string.

Output feeds back into the registry's `selectorHint` field. The registry itself is hand-authored TypeScript; the recon validates it, it doesn't generate it.

### §4.2 Stability contract

**Stable hooks (to use):**
- Button text content (`button.textContent.trim()`)
- `Typography` text content
- `aria-label` attributes (present on some game buttons — confirmed in design/06 §4: `[aria-label="save game"]`)
- DOM structural position where rendered order is semantically meaningful (e.g. sleeve card index)
- React fiber `memoizedProps` values (same technique as navigator.ts `clickPage`)

**Unstable hooks (avoid):**
- `tss-react`-hashed class names (e.g. `makeStyles` output like `.css-abc123-root`) — they change with game rebuilds. The navigator already avoids these; extend the same discipline.
- MUI internal class names starting with `Mui` (e.g. `.MuiButton-containedPrimary`) — these are stable for major MUI versions but not minor; acceptable as **secondary** discriminators only.

### §4.3 Re-validation on game updates

When game version bumps:
1. Run `dev/selector_recon.ts` against the new version.
2. FAIL entries mean the game changed the DOM structure for that action.
3. Cross-reference the new game source in `/home/shane/workspace/bitburner-src` (update game source checkout per `memory/game-source-checkout.md` first).
4. Update the `locate` lambda and `selectorHint` in the registry entry; the entry's TypeScript shape does not change.
5. Re-run recon → all PASS → commit.

**No live runtime re-validation.** The registry is compiled TypeScript; recon is offline. If a locate call returns `null` at runtime, the service falls back to SF4 and logs a warning to flag a stale selector.

### §4.4 Recon script outline

```ts
// dev/selector_recon.ts  (plain TypeScript, runs as a Playwright-driven script)
// NOT a Bitburner NS script — this is a dev tool run outside the game.

// For each ActionEntry in the registry:
//   1. mcp__playwright__browser_navigate → navigate to the required page.
//   2. Wait for the page to stabilize (mcp__playwright__browser_wait_for).
//   3. mcp__playwright__browser_evaluate → run the entry's locate() logic in-page.
//   4. If element found: capture its outerHTML for the report.
//   5. mcp__playwright__browser_evaluate → inspect the element's onClick fiber prop
//      for isTrusted checks (search the function source string).
//   6. Record: PASS/FAIL, locator found, isTrusted-guarded boolean.
// Emit JSON report to dev/selector_recon_report.json.
```

Run via: the existing Playwright MCP setup from design/07 (`localhost:8000` dev server, `--headless --isolated`).

---

## §5 Brain integration

### §5.1 How managers call act()

Managers (from design/11 subsystem managers) replace hand-rolled click sequences with:

```ts
// Before (hand-rolled — fragile):
goTo(GamePage.Travel);
const btn = doc.querySelector(/* some brittle selector */);
btn?.click();

// After (registry-based):
const result = await act(ns, 'travel-to-city', { city: CityName.Aevum });
if (!result.ok) {
  ns.print(`WARN travel failed: ${result.detail}`);
  // enqueue retry intent or choose alternative action
}
```

Managers that are UI callbacks (React panels) CANNOT call `act()` directly (no `ns`). They enqueue an Intent:

```ts
// In a React UI callback (no ns access):
dispatchIntent({ action: 'travel-to-city', params: { city: CityName.Aevum } });

// In the sequencer's NS loop (has ns):
const intent = dequeueIntent();
if (intent) {
  await act(ns, intent.action as ActionId, intent.params);
}
```

### §5.2 player_sequencer / thread-P integration

The sequencer (`src/player/player_sequencer.ts`, design/05) maintains a priority queue of goals. When a goal requires an action:
1. It calls `act(ns, actionId, params)`.
2. On `{ok:false}`: the goal is retried (back-off) or abandoned based on goal priority.
3. On `{ok:true}`: goal state advances; sequencer picks the next action.

The sequencer owns the `ns` reference and is the **only** site that calls `act()` directly. All other subsystems enqueue intents.

### §5.3 Example goal execution (join faction)

```
Goal: join CyberSec
  Precondition check: faction invite received? (read from Factions list via ns_dodge)
    If no invite yet: wait (poll or listen for a port signal)
  act(ns, 'join-faction', { faction: 'CyberSec' })
    → DOM path: locate FactionInvitationManager modal, click "Join" (no isTrusted guard)
    → verify: modal gone
    → {ok:true, strategy:'dom'}
  Goal advances to: WorkForFaction{faction:'CyberSec', target_rep:1000}
```

---

## §6 Build plan — concurrency-ready waves

Follows [[10-parallel-build-playbook]]. Wave 0 freezes the shared contract; Wave 1 files are disjoint; Wave 2 integrates.

### Wave 0 — Freeze the contract (solo, commit + push before Wave 1)

**Files to create (stubs OK):**

| File | Content |
|---|---|
| `src/lib/actions/registry.ts` | Full TypeScript type shapes (§2.1) + stub entries for the 8 initial actions. Exports `Registry`, `ActionEntry`, `DomStrategy`, `Sf4Strategy`, `ActionResult`, `ActionId`, `ActionParams`. |
| `src/lib/actions/service.ts` | `act()` stub (signature only, body `throw 'not implemented'`). Imports from registry + navigator + ns_dodge. |

**Acceptance:** `npx tsc --noEmit` passes. `act()` is callable with the right types from a sample caller.

**RAM budget:** 0 GB (pure types + no ns.* in registry.ts / service.ts skeleton).

---

### Wave 1 — Parallel agent build (disjoint files; see playbook §5)

Each agent owns exactly ONE file. All build against the frozen Wave-0 contract.

**Wave 1A — `src/lib/actions/dom/travel.ts`**
- Implements `locate` and `prepare` for `travel-to-city`.
- DOM: navigate Travel page → find `button` by `textContent.includes('Travel to {city}')` → `.click()`.
- If `SuppressTravelConfirmation` is false (readable from Settings via fiber or by checking for a MUI Dialog), click the "Yes" confirm button in `TravelConfirmationModal`.
- `verify`: after a 200ms wait, check that a brief "You are now in {city}" dialog appeared (check for dialog text in DOM) OR that the City heading changed. Fallback: always return true (sequencer handles retry).
- **RAM:** 0 GB DOM, 2–32 GB SF4 (via ns_dodge).
- **Acceptance:** navigate Travel page, `locate()` returns a button element for a known city, `.click()` triggers travel (verified via Playwright Tier-1 check).

**Wave 1B — `src/lib/actions/dom/faction.ts`**
- Implements `locate` for: `join-faction`, `start-faction-work`, `donate-to-faction`.
- `join-faction`: find `[role="dialog"]` containing faction name text → `button:text("Join")` (FactionInvitationManager).
- `start-faction-work`: navigate to Factions page → click "Details" for named faction → click work-type button by text (`"Field Work"` / `"Hacking Contracts"` / `"Security Work"`).
- `donate-to-faction`: navigate to Factions page → click "Details" → locate `NumberInput` (find `input[placeholder="Donation amount"]`) → set value via `.value = amount` + fire `input` event → click "donate" button.
- **RAM:** 0 GB DOM.
- **Acceptance:** Playwright Tier-1: `join-faction` locates the modal Join button; `start-faction-work` locates the work button; `donate-to-faction` sets the input and locates donate button.

**Wave 1C — `src/lib/actions/dom/augmentation.ts`**
- Implements `locate` for `buy-augmentation`.
- Navigate Factions page → click "Augments" button on the right faction row → locate `.MuiPaper-root` whose inner Typography text === augName → return its `Buy` button.
- If `Settings.SuppressBuyAugmentationConfirmation` is false, a `PurchaseAugmentationModal` appears — locate "Purchase" button in the modal and click it.
- `verify`: the "Buy" button for this aug becomes disabled (`HTMLButtonElement.disabled === true`) or shows "Owned".
- **RAM:** 0 GB DOM.
- **Acceptance:** Playwright Tier-1 with a known aug name in a known faction.

**Wave 1D — `src/lib/actions/dom/sleeve.ts`**
- Implements `prepare` + `locate` for `sleeve-assign-task`.
- Navigate Sleeves page → find the Nth `.MuiPaper-root` sleeve card.
- Set task type via the first `<select>` in the card: read its fiber (`__reactProps$xxx`) to get `onChange`; call `onChange({target:{value: task}})` directly on the fiber. Do the same for detail1/detail2 selects if needed.
- Then locate the "Confirm" button in that card.
- `verify`: the sleeve description paragraph text changes to mention the new task.
- **RAM:** 0 GB DOM, 4 GB SF4 via ns_dodge (sleeve API not SF4-gated but still ns.* RAM).
- **Acceptance:** Playwright Tier-1: Select value changes, Confirm button found.

**Wave 1E — `src/lib/actions/sf4.ts`**
- Implements the SF4 fallback bridge used by service.ts.
- Thin wrapper over `executeCommand()` from `lib/ns_dodge.ts`: receives a command string, invokes `executeCommand(ns, cmd)`, returns `{ok, detail}`.
- Adds a pre-flight RAM check: `ns.getServerMaxRam('home') - ns.getServerUsedRam('home') >= ramCostGb` before launching.
- Adds SF4-level detection: probe via `executeCommand(ns, 'ns.getPlayer().sourceFiles')` (cached per sequencer tick, not per call).
- **RAM:** ~1.6 GB in the calling script (ns.getServerMaxRam + ns.getServerUsedRam + ns.run + ns.read).
- **Acceptance:** `executeCommand` round-trip works for `ns.singularity.travelToCity`; RAM check rejects if home RAM is insufficient.

**Wave 1F — `dev/selector_recon.ts`**
- Dev-only Playwright recon script (not a Bitburner NS script).
- For each action in the registry, calls Playwright MCP tools to navigate to the right page and run `locate()` logic in-page via `browser_evaluate`.
- Emits `dev/selector_recon_report.json`: per-action PASS/FAIL + element outerHTML excerpt.
- **Acceptance:** running the script against `localhost:8000` produces a report with all initial actions marked PASS.

---

### Wave 2 — Integration (solo)

1. Implement `act()` body in `service.ts` per §3.2 (uses Wave-1 output).
2. Wire `act()` call-site in `player_sequencer.ts`: replace any existing ad hoc DOM clicks.
3. Confirm `npx tsc --noEmit` → `npx tsc` (emit) clean.
4. **Tier-1 verify** (Playwright + browser_evaluate): exercise `act('travel-to-city', {city:'Aevum'})`, `act('join-faction', …)`, `act('buy-augmentation', …)` against `localhost:8000`.
5. **Tier-2 verify** (Steam instance via RFA bridge): run the integrated sequencer; confirm actions execute in the live game.
6. Commit to `main`.

---

## §7 Acceptance criteria per component

| Component | RAM budget | Acceptance gate |
|---|---|---|
| `lib/actions/registry.ts` | 0 GB | TypeScript compiles; all action types correctly constrain params |
| `lib/actions/service.ts` | 0 GB DOM / ~1.6 GB SF4 path | `act()` round-trips for travel, join, donate, buy-aug, sleeve; verify returns true |
| `lib/actions/dom/travel.ts` | 0 GB | Playwright Tier-1: button found + click lands travel |
| `lib/actions/dom/faction.ts` | 0 GB | Playwright Tier-1: all 3 actions locate their targets |
| `lib/actions/dom/augmentation.ts` | 0 GB | Playwright Tier-1: Buy button found; modal handled |
| `lib/actions/dom/sleeve.ts` | 0 GB | Playwright Tier-1: Select fiber-set + Confirm found |
| `lib/actions/sf4.ts` | ~1.6 GB (caller) | Singularity round-trip passes; RAM check rejects on low RAM |
| `dev/selector_recon.ts` | dev-only | Report: all initial actions PASS |

---

## §8 Open questions / TODO(design)

1. **Travel confirmation dialog** — if `Settings.SuppressTravelConfirmation` is false, a dialog appears. Our DOM path must detect and dismiss it. Alternatively: the sequencer can set `Settings.SuppressTravelConfirmation = true` via fiber before traveling (technically state mutation — borderline on capability boundary; the setting is user-controlled). Prefer: just handle the confirm dialog in the DOM path.

2. **Apply-for-job** (isTrusted-blocked) — `CompanyLocation.tsx work()` checks `event.isTrusted`. But `JobListings` (the sub-component showing available positions and "Apply" buttons) needs a separate isTrusted audit (not checked above). If unblocked, a DOM path is possible. Until confirmed: use SF4 (`ns.singularity.applyToCompany`). Add to Wave 1 once `JobListings.tsx` is read.

3. **MUI Select manipulation via fiber** — `sleeve.ts` proposes firing `onChange` directly on the fiber's props. This is more robust than synthesizing a SelectChangeEvent but relies on the prop key being `onChange` in `memoizedProps`. Validate live in Tier-1 or fall back to dispatching a `change` event on the underlying `<select>` element.

4. **Multi-step navSteps + render stabilisation** — the City→Location multi-click chain (needed for company apply) requires waiting for React to re-render between clicks. A simple `await sleep(150)` works but is fragile. Alternative: use a MutationObserver on `#root` to await the target element's appearance. Implement as a `waitForElement(selector, timeoutMs)` helper in `service.ts`.

5. **Port-based feedback for SF4 results** — `ns_dodge`'s `executeCommand` polls for a file. An alternative is writing to a named port (`ns.writePort`) in the temp script and reading it in the caller. This avoids file I/O and is slightly faster but requires port reservation. Defer until `executeCommand` latency becomes a bottleneck.

6. **Gang invite acceptance** — the gang-join flow (CreateGangModal.tsx) needs a separate entry. Similar to faction; modal-based.

7. **Selector recon running environment** — `dev/selector_recon.ts` is NOT a Bitburner NS script. It runs as a Node.js/Playwright script using the Playwright MCP server. Confirm it can import Playwright MCP tool schemas via `ToolSearch` and call them from a Node context (vs. from Claude Code's agent context). May need to be a Claude Code agent script instead of a standalone Node script.
