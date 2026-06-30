# Design 10 — Parallel Build Playbook (reusable)

**Status:** ACTIVE process doc. Distilled from [[09-parallel-build-plan]] (console v1, BUILT 2026-06-30). Use this for every *wide* multi-agent build so we don't re-learn the same lessons.

**Companions:** [[07-dev-loop-tooling]] (verify tiers), [[manager-delegation-pattern]] (delegate-and-wait).

---

## §1 When to use

Wide scope, many **disjoint** files, and we want "build everything, *then* debug" (one consolidated Tier-2 pass at the end) rather than build-while-debug. If the work is one file or tightly coupled, just build it inline — the orchestration overhead isn't worth it.

## §2 The wave structure

```
Wave 0 (me, solo)   → freeze the shared contract: final types / seams / shared
                      libs, and STUB every new file so the project compiles.
                      ONE commit. Everything typechecks with stubs.
Wave 1 (N agents,   → each agent owns DISJOINT file(s) only, built against the
        worktrees)    frozen contract. No agent touches a shared/contract file
                      or another agent's file.
Wave 2 (me, solo)   → integrate, do the cross-cutting / shell-level polish, full
                      verify, then the SINGLE Tier-2 pass (user drives).
```

Why freeze first: worktrees isolate filesystems but **not semantic conflicts** — two agents editing the same `interface` still collide at merge. Freezing the contract in Wave 0 makes Wave 1 genuinely independent.

## §3 ⚠️ Worktree base — the bug we hit, and the fix

**Symptom (console v1):** all five Wave-1 worktrees branched from `7ce9d9e` (a *pre-seam* commit), not the Wave-0 commit `2ac43ef`. Agents lacked the frozen contract → they re-derived types, made defensive casts, and the two existing-file edits landed on a stale base that **could not be git-merged without reverting Wave 0 + the prior step**.

**Root cause:** worktree isolation defaults to `worktree.baseRef: "fresh"` = branches from **`origin/<default-branch>`**, NOT your local HEAD. Wave 0 was committed locally but **unpushed**, so `origin/main` was still the old tip and every agent inherited it.

**Fix — do ONE of these *before* spawning Wave 1:**
1. **Push the Wave-0 commit to origin first** so `origin/<default-branch>` already contains the seam. (Recommended — keeps the default `fresh` behavior; matches normal git flow.)
2. **OR set `worktree.baseRef: "head"`** in `.claude/settings.json` so worktrees branch from local HEAD (no push needed; durable against forgetting).

**Verify before fan-out** (cheap insurance): after spawning one agent, confirm its worktree has the seam —
```
git -C .claude/worktrees/agent-<id> rev-parse HEAD     # == your Wave-0 commit
ls  .claude/worktrees/agent-<id>/<a-new-seam-file>     # exists
```
If it's wrong, stop and re-spawn after applying the fix — don't let four more agents build on sand.

## §4 Integration (Wave 2)

- **New files** (panels, new modules): copy content onto `main`, fix imports to the *real* contract (agents built against their worktree's view, which may differ from the integrated seam).
- **Existing-file edits**: `git merge` the branch ONLY if its base matches `main`. Otherwise **re-apply the agent's diff/hunks by hand** onto `main`'s current file (extract with `git -C <worktree> diff -- <file>`). A naive merge of a stale-based branch reverts whatever landed after its base.
- **Verify in the MAIN tree, not the worktree.** Worktrees lack `node_modules`, so agent-side `tsc` reports phantom `@ns`/`react` "module not found" errors — their "tsc passed" claims are unreliable. Authoritative gate: `npx tsc --noEmit` → `npx tsc` (emit) → `node --check` on each changed `dist/*.js`.

## §5 Agent prompt checklist

- Name the **ONE** file it owns; say explicitly "do not edit any other file."
- Paste the **frozen contract** (the types/functions it consumes) inline — don't make it guess or discover them.
- State the **rules**: capability boundary, ns-from-callback (panels never call `ns.*`, only `dispatch`), match existing style (name the files to read first).
- "Run `npx tsc --noEmit`; **do not commit / do not touch git**; leave changes in the working tree."
- Ask for a concise summary: what it built + any API/contract uncertainty it had to resolve.
- Model: Sonnet is fine for well-scoped single-file work with a detailed prompt; the solo integrator (me) catches issues in Wave 2.

## §6 Cleanup (end of build)

```
git worktree remove --force .claude/worktrees/agent-<id>   # each
git worktree prune
git branch -D worktree-agent-<id>                          # each
```
Commit per wave; push when the user OKs (lean toward *after* Tier-2 so origin only sees verified state — unless the seam must be pushed first per §3 option 1).
