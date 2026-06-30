# Design 07 — Browser Dev Loop & Verification Tooling (Playwright + Sonnet multiplexing)

**Status:** RATIFIED (plan + approach approved 2026-06-30). Setup pending (post-compaction). Doc-first capture so it survives context compaction.

**Companion notes:** [[06-ui-navigation]] (what we verify with this loop), [[05-thread-p-sequencing]] (the brain).

---

## §0 Purpose

Give the developer (me) **real eyes on the live game DOM** instead of the keyhole (terminal-text buffer + RAM-gated probe scripts) that caused repeated mis-diagnoses (see `memory/mcp-act-path-gotchas`). And do it **without burning Opus context on page navigation** — delegate the browser driving to cheaper **Sonnet** subagents over **Playwright MCP**, which multiplexes (isolated contexts), so several can run in parallel and report back concise findings. Opus synthesizes and codes; Sonnet navigates and verifies.

---

## §1 The browser dev loop

- Game source: `/home/shane/workspace/bitburner-src` (`memory/game-source-checkout`). Already provisioned (`node_modules` present, Node 24).
- Dev server: **`npm run start:dev`** (webpack-dev-server) → serves the playable game at **`http://localhost:8000`** (localhost-only). Hot reload of the working tree. **Currently running** in the background (compiled OK, HTTP 200) — keep it alive; restart with the same command if it dies.
- The browser instance runs the **bitburner-src working tree** (the engine), independent of the Steam/Proton instance — they share nothing except via exported/imported save files.

## §2 Playwright MCP setup (replicated from juror_fullstack, adapted)

Source of truth: `juror_fullstack/.mcp.json` + `.claude/settings.local.json`. Package `@playwright/mcp` (system has 0.0.77), fetched on-demand by `npx` (no local dep). Browsers already installed at `~/.cache/ms-playwright` (chromium-1228) — **no `playwright install` needed**. Transport: stdio. Default browser: Chromium.

**A. `bitburner_scripts/.mcp.json`** (create; we need NO auth/storage-state — the game has no login):
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@0.0.77", "--headless", "--isolated"]
    }
  }
}
```
- `--isolated`: each session gets its own browser context (clean state; enables parallel subagents).
- `--headless`: no visible window; screenshots still work for evidence.
- Pin `@0.0.77` for reproducibility (drop the pin to float).
- (Omit `--storage-state` — that was juror's auth-session preload; irrelevant here.)

**B. Enable it — `bitburner_scripts/.claude/settings.local.json`:**
```json
{
  "enabledMcpjsonServers": ["playwright"],
  "enableAllProjectMcpServers": true
}
```
**Note:** adding an MCP server typically needs a Claude Code reload/approval before `mcp__playwright__*` tools appear (to me and to subagents). Do this as the first post-compaction step.

## §3 Sonnet-subagent multiplexing model

**Division of labor (the whole point):**
- **Opus (me):** design, synthesis, code, decisions. Never drives the browser directly (page nav is token-expensive).
- **Sonnet subagents:** open `localhost:8000`, navigate/inspect/verify via `mcp__playwright__*`, return **concise structured findings** (+ screenshot paths). Multiple in parallel (isolated contexts).

**Reporting protocol:** each subagent returns a tight verdict object — what it checked, pass/fail, exact values observed (selectors found, page reached, console output), and a screenshot path under a scratch dir. No raw DOM dumps back to me.

**Tooling note:** subagents reach MCP tools via `ToolSearch` (`select:mcp__playwright__browser_navigate,...`). Likely tools in 0.0.77: `browser_navigate`, `browser_snapshot` (a11y tree), `browser_click`, `browser_type`, `browser_evaluate` (run JS in page — key for us), `browser_take_screenshot`, `browser_console_messages`.

## §4 Two-tier verification (resolves "how do our scripts get into the browser game?")

The dev instance loads the **engine**, not our `bitburner_scripts/dist`. We do NOT need to deploy our scripts to verify the hard part:

- **Tier 1 — DOM-logic verification (no script deploy needed).** Use `browser_evaluate` to run the *candidate* navigation/injection JS (the Navigator's fiber `clickPage` resolution, the §06.4 gear selectors, the active-page probe, the body-portal panel mount) directly against the live `localhost:8000` DOM. This validates design/06 §2–§4 — selectors, fiber bridge, `goTo`, gear anchoring — independent of the game's script system. This is where most risk lives, and it's cheap.
- **Tier 2 — full script integration.** Run the actual compiled `config_dashboard.js` / Navigator inside a real game instance and watch the ns-loop + UI end-to-end. Two routes: (a) the **Steam instance via the existing game-bridge** (RFA on :12525, already wired by `watch:remote`) — simplest, it's already connected; or (b) the **browser instance** with its Remote API pointed at a bridge. Prefer (a) for behavior; (b) risks a two-clients-on-:12525 conflict — out of scope until needed.

So: **Tier 1 (Playwright + browser_evaluate) for the DOM/Navigator/gear logic; Tier 2 (Steam + bridge) for live script behavior.**

## §5 Save / instance-canonicality workflow

- Saves are fully file-portable; the importer auto-detects the Steam base64 format (`bitburner-src/src/SaveObject.ts`). Export from one, Import into the other.
- **Fresh game (no save) suffices for UI/nav/gear structural verification** — the sidebar, terminal, toolbar, and overview hooks all exist in a new game → **zero divergence risk.** Use this for design/06 verification.
- **Import the Steam save** only for progression/SF4-gated behavior (faction join, aug surfacing, the Reset button). Discipline: **one canonical instance at a time** — don't let both autosave the same progression or they diverge (last export wins). `exportGame()` grants a small export bonus (harmless, noted).
- A fresh dev instance may open on a "new game / import" screen or tutorial; the verification subagent must get to the main UI first (note in its brief).

## §6 Operational lifecycle

- Dev server: `cd /home/shane/workspace/bitburner-src && npm run start:dev` (run in background; port 8000). It's already up this session.
- It runs indefinitely; kill via the background-task controls if needed. First compile ~10 s; incremental fast.
- The dev server and the MCP browser are independent — restarting one doesn't require restarting the other.

## §7 Build/verify sequence (ties into design/06 §7)

1. Post-compaction: create `.mcp.json` + `.claude/settings.local.json` (§2); reload so `mcp__playwright__*` appears.
2. Build `src/lib/navigator.ts` (design/06 §3).
3. **Tier-1 verify (Sonnet + Playwright):** dispatch subagent(s) to `localhost:8000`, `browser_evaluate` the Navigator's `goTo`/`currentPage` + gear-anchor selectors against the live DOM; report pass/fail + screenshots. Iterate on any selector/fiber mismatch.
4. Fix `config_dashboard.tsx` gear selectors (design/06 §4); harden `launcher.ts` (design/06 §6).
5. **Tier-2 verify:** run compiled scripts in the Steam instance via the bridge; confirm gear beside Kill-all, panel open/drag/toggle, settings round-trip, navigation.
6. Commit to `main`.

## §8 Open questions / TODO(design)
- Confirm the exact `mcp__playwright__*` tool names/params for 0.0.77 at setup time (esp. `browser_evaluate`).
- MCP reload mechanics: does enabling the server need an explicit approval prompt? Handle at setup.
- Whether to also stand up a second bridge port so the browser instance can run our scripts (Tier-2 route b) — defer.
- Headless vs headed for the rare case I want to *watch* a flow — `--headless` default; can drop it temporarily.
