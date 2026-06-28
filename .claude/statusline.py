#!/usr/bin/env python3
# /// script
# requires-python = ">=3.14"
# dependencies = []
# ///
"""Claude Code statusline — reads JSON from stdin, prints a multi-line ANSI status.

Uses Python 3.14+ syntax (PEP 758 parenthesis-less `except A, B:`); the
`requires-python` pin above lets `uv run --script` select a 3.14 interpreter
even if the host's default `python`/`python3` is older. Stdlib-only — no deps.
"""

import contextlib
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import TypedDict
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# Claude Code status JSON schema
# ---------------------------------------------------------------------------
# All TypedDicts are total=False: Claude Code may omit any field during early
# session state (no model picked yet, no cost accumulated, etc.).


class Model(TypedDict, total=False):
    id: str
    display_name: str


class Workspace(TypedDict, total=False):
    current_dir: str
    project_dir: str


class Worktree(TypedDict, total=False):
    name: str
    branch: str
    original_branch: str


class NamedEntity(TypedDict, total=False):
    name: str


class VimState(TypedDict, total=False):
    mode: str


class CurrentUsage(TypedDict, total=False):
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int
    cache_read_input_tokens: int


class ContextWindow(TypedDict, total=False):
    used_percentage: float
    total_input_tokens: int
    total_output_tokens: int
    context_window_size: int
    current_usage: CurrentUsage


class RateWindow(TypedDict, total=False):
    used_percentage: float
    resets_at: int


class RateLimits(TypedDict, total=False):
    five_hour: RateWindow
    seven_day: RateWindow


class Cost(TypedDict, total=False):
    total_cost_usd: float
    total_api_duration_ms: int
    total_lines_added: int
    total_lines_removed: int
    total_duration_ms: int


class RawStatus(TypedDict, total=False):
    session_id: str
    session_name: str
    cwd: str
    model: Model
    workspace: Workspace
    worktree: Worktree
    agent: NamedEntity
    vim: VimState
    output_style: NamedEntity
    context_window: ContextWindow
    exceeds_200k_tokens: bool
    rate_limits: RateLimits
    cost: Cost


BEIJING_TZ = timezone(timedelta(hours=8))  # Current location (UTC+8, no DST)
PT_TZ = ZoneInfo("America/Los_Angeles")  # Peak-hour reference tz (DST-aware: PST/PDT)
GIT_CACHE_MAX_AGE = 5  # seconds

# Peak hours: weekdays 5 AM–11 AM PT (equivalent to 12 PM–6 PM UTC during PDT).
# During peak, rate limits are tightest — RED indicator warns to slow down.
PEAK_START_HOUR_PT = 5
PEAK_END_HOUR_PT = 11

# No expected usage during these BJT hours — the 7d optimal pace treats them
# as zero-elapsed so late-night deltas don't misleadingly flash red/yellow.
SLEEP_START_HOUR_BJT = 23
SLEEP_END_HOUR_BJT = 6

# ---------------------------------------------------------------------------
# Usage history DB
# ---------------------------------------------------------------------------

_DB_PATH = os.path.expanduser("~/.claude/token_usage.db")


# Columns added after the initial schema. CREATE TABLE stays frozen so old rows
# keep their IDs; new fields arrive via idempotent ALTER TABLE. Ordered —
# applied top-to-bottom; safe to run on every statusline render.
_MIGRATIONS: list[tuple[str, str]] = [
    # Session identity. `sse_port` is the pairing key: Claude Code sets
    # CLAUDE_CODE_SSE_PORT in its env before spawning any child, so statusline
    # (via shell wrapper) and MCP server (via `uv`) both inherit the same
    # value. This lets the MCP reliably find "its own" rows.
    ("sse_port", "INTEGER"),
    ("session_name", "TEXT"),
    ("cwd", "TEXT"),
    ("project_dir", "TEXT"),
    # Current-context breakdown — what is sitting in the context window right
    # now. Subject to /clear and rewind; storing components separately lets a
    # future plot show fresh-vs-cache composition over time.
    ("ctx_current_input", "INTEGER"),
    ("ctx_current_output", "INTEGER"),
    ("ctx_current_cache_creation", "INTEGER"),
    ("ctx_current_cache_read", "INTEGER"),
    ("exceeds_200k", "INTEGER"),  # 1 iff 1M window active
    ("cost_api_duration_ms", "INTEGER"),
    ("agent_name", "TEXT"),
    ("worktree_name", "TEXT"),
    # claude_pid retained for debugging only — was an earlier (broken) anchor.
    ("claude_pid", "INTEGER"),
]


def _ensure_db(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS usage_snapshots (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at     REAL    NOT NULL,           -- Unix timestamp (float)
            session_id      TEXT,
            model_id        TEXT,
            -- context window
            ctx_used_pct    REAL,
            ctx_total_input INTEGER,
            ctx_total_output INTEGER,
            ctx_window_size INTEGER,
            -- rate-limit windows (raw %)
            five_h_used_pct REAL,
            five_h_resets_at INTEGER,
            seven_d_used_pct REAL,
            seven_d_resets_at INTEGER,
            -- cost & session metrics
            cost_usd        REAL,
            lines_added     INTEGER,
            lines_removed   INTEGER,
            duration_ms     INTEGER
        )
        """
    )
    # Idempotent migrations: each ALTER is wrapped individually because
    # "column already exists" is the expected case on every render after the
    # first one for a given field.
    for name, sqltype in _MIGRATIONS:
        with contextlib.suppress(sqlite3.OperationalError):
            conn.execute(f"ALTER TABLE usage_snapshots ADD COLUMN {name} {sqltype}")
    # MCP's hot path: "newest row for this Claude Code process".
    conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_sse_time ON usage_snapshots(sse_port, recorded_at DESC)")
    # Future plot panel: "everything for this chat".
    conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_session_time ON usage_snapshots(session_id, recorded_at DESC)")
    conn.commit()


def _record_snapshot(raw: RawStatus, sse_port: int | None, claude_pid: int) -> None:
    """Write one row to the history DB. Runs in a background thread."""
    try:
        conn = sqlite3.connect(_DB_PATH, timeout=2)
        _ensure_db(conn)
        ctx: ContextWindow = raw.get("context_window") or {}
        cur: CurrentUsage = ctx.get("current_usage") or {}
        rl: RateLimits = raw.get("rate_limits") or {}
        five_h: RateWindow = rl.get("five_hour") or {}
        seven_d: RateWindow = rl.get("seven_day") or {}
        cost: Cost = raw.get("cost") or {}
        ws: Workspace = raw.get("workspace") or {}
        wt: Worktree = raw.get("worktree") or {}
        conn.execute(
            """
            INSERT INTO usage_snapshots (
                recorded_at, session_id, session_name, model_id,
                sse_port, claude_pid, cwd, project_dir,
                ctx_used_pct, ctx_total_input, ctx_total_output, ctx_window_size,
                ctx_current_input, ctx_current_output,
                ctx_current_cache_creation, ctx_current_cache_read,
                exceeds_200k,
                five_h_used_pct, five_h_resets_at,
                seven_d_used_pct, seven_d_resets_at,
                cost_usd, cost_api_duration_ms,
                lines_added, lines_removed, duration_ms,
                agent_name, worktree_name
            ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?, ?,?,?,?, ?,?, ?,?,?, ?,?)
            """,
            (
                time.time(),
                raw.get("session_id"),
                raw.get("session_name"),
                (raw.get("model") or Model()).get("id"),
                sse_port,
                claude_pid,
                ws.get("current_dir") or raw.get("cwd"),
                ws.get("project_dir"),
                ctx.get("used_percentage"),
                ctx.get("total_input_tokens"),
                ctx.get("total_output_tokens"),
                ctx.get("context_window_size"),
                cur.get("input_tokens"),
                cur.get("output_tokens"),
                cur.get("cache_creation_input_tokens"),
                cur.get("cache_read_input_tokens"),
                1 if raw.get("exceeds_200k_tokens") else 0,
                five_h.get("used_percentage"),
                five_h.get("resets_at"),
                seven_d.get("used_percentage"),
                seven_d.get("resets_at"),
                cost.get("total_cost_usd"),
                cost.get("total_api_duration_ms"),
                cost.get("total_lines_added"),
                cost.get("total_lines_removed"),
                cost.get("total_duration_ms"),
                (raw.get("agent") or NamedEntity()).get("name"),
                wt.get("name"),
            ),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass  # Never crash the statusline over a DB write


def record_snapshot_async(raw: RawStatus) -> threading.Thread:
    """Fire-and-forget DB write — does not block statusline rendering."""
    # Capture identity in the main thread: the daemon thread could outlive
    # env-sensitive state, and grabbing getppid() from a thread can race if
    # a wrapper process exits.
    sse_raw = os.environ.get("CLAUDE_CODE_SSE_PORT")
    sse_port = int(sse_raw) if sse_raw and sse_raw.isdigit() else None
    claude_pid = os.getppid()
    t = threading.Thread(target=_record_snapshot, args=(raw, sse_port, claude_pid), daemon=True)
    t.start()
    return t


class Color(StrEnum):
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    CYAN = "\033[0;36m"
    GREEN = "\033[0;32m"
    YELLOW = "\033[0;33m"
    RED = "\033[0;31m"
    MAGENTA = "\033[0;35m"


SEP = f" {Color.DIM}\u2502{Color.RESET} "


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _pct_color(pct: float) -> Color:
    """Green <50, yellow 50-75, red >75."""
    if pct > 75:
        return Color.RED
    if pct > 50:
        return Color.YELLOW
    return Color.GREEN


def abbrev_home(path: str) -> str:
    home = os.path.expanduser("~").replace("\\", "/")
    path = path.replace("\\", "/")
    return f"~{path[len(home) :]}" if path.startswith(home) else path


def join(*parts: str | None) -> str:
    return SEP.join(p for p in parts if p is not None)


def fmt_k(n: int) -> str:
    return f"{n / 1000:.1f}k"


# ---------------------------------------------------------------------------
# Git caching
# ---------------------------------------------------------------------------


def _git_cache_path(cwd: str) -> str:
    h = hashlib.md5(cwd.encode()).hexdigest()[:10]
    return f"/tmp/claude-statusline-git-{h}.json"


class GitInfo(TypedDict, total=False):
    branch: str
    staged: int
    modified: int
    untracked: int


def _refresh_git_cache(cwd: str) -> GitInfo:
    """Run git commands and return a cache dict. Returns empty dict on failure."""
    result: GitInfo = {}
    try:
        subprocess.check_output(
            ["git", "-C", cwd, "rev-parse", "--git-dir"],
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError, FileNotFoundError:
        return result

    # Branch / detached HEAD
    try:
        branch = subprocess.check_output(
            ["git", "-C", cwd, "--no-optional-locks", "symbolic-ref", "--short", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except subprocess.CalledProcessError:
        try:
            sha = subprocess.check_output(
                ["git", "-C", cwd, "--no-optional-locks", "rev-parse", "--short", "HEAD"],
                stderr=subprocess.DEVNULL,
                text=True,
            ).strip()
            branch = f"({sha})"
        except subprocess.CalledProcessError:
            return result
    result["branch"] = branch

    # Status counts
    try:
        lines = (
            subprocess.check_output(
                ["git", "-C", cwd, "--no-optional-locks", "status", "--porcelain"],
                stderr=subprocess.DEVNULL,
                text=True,
            )
            .strip()
            .splitlines()
        )
    except subprocess.CalledProcessError:
        lines = []

    staged = 0
    modified = 0
    untracked = 0
    for line in lines:
        if len(line) < 2:
            continue
        x, y = line[0], line[1]
        if x == "?":
            untracked += 1
        else:
            if x in "MADRCT":
                staged += 1
            if y in "MADRCT":
                modified += 1

    result["staged"] = staged
    result["modified"] = modified
    result["untracked"] = untracked
    return result


def _get_git_info(cwd: str) -> GitInfo:
    """Return cached git info, refreshing if stale."""
    if not cwd:
        return {}
    cache_file = _git_cache_path(cwd)
    try:
        if os.path.exists(cache_file) and (time.time() - os.path.getmtime(cache_file)) <= GIT_CACHE_MAX_AGE:
            with open(cache_file) as f:
                cached: GitInfo = json.load(f)
                return cached
    except json.JSONDecodeError, OSError:
        pass

    info = _refresh_git_cache(cwd)
    try:
        with open(cache_file, "w") as f:
            json.dump(info, f)
    except OSError:
        pass
    return info


# ---------------------------------------------------------------------------
# Section renderers
# ---------------------------------------------------------------------------


def _cwd(raw: RawStatus) -> str:
    ws: Workspace = raw.get("workspace") or {}
    return ws.get("current_dir") or raw.get("cwd", "")


def fmt_model(raw: RawStatus) -> str:
    model: Model = raw.get("model") or {}
    name = model.get("display_name", "Claude")
    return f"{Color.CYAN}{Color.BOLD}{name}{Color.RESET}"


def fmt_git(raw: RawStatus) -> str | None:
    info = _get_git_info(_cwd(raw))
    branch = info.get("branch")
    if not branch:
        return None

    parts = [f"{Color.CYAN}{branch}{Color.RESET}"]

    staged = info.get("staged", 0)
    modified = info.get("modified", 0)
    untracked = info.get("untracked", 0)

    if staged:
        parts.append(f"{Color.GREEN}+{staged}{Color.RESET}")
    if modified:
        parts.append(f"{Color.YELLOW}~{modified}{Color.RESET}")
    if untracked:
        parts.append(f"{Color.RED}?{untracked}{Color.RESET}")

    return " ".join(parts)


def fmt_cwd(raw: RawStatus) -> str | None:
    cwd = _cwd(raw)
    return f"{Color.DIM}{abbrev_home(cwd)}{Color.RESET}" if cwd else None


def fmt_worktree(raw: RawStatus) -> str | None:
    wt: Worktree = raw.get("worktree") or {}
    name = wt.get("name")
    if not name:
        return None
    wt_branch = wt.get("branch")
    wt_orig = wt.get("original_branch")
    branch = f" {Color.DIM}({wt_branch}){Color.RESET}" if wt_branch else ""
    orig = f" \u2190 {wt_orig}" if wt_orig else ""
    return f"wt: {name}{branch}{orig}"


def fmt_agent(raw: RawStatus) -> str | None:
    agent: NamedEntity = raw.get("agent") or {}
    name = agent.get("name")
    return f"{Color.MAGENTA}agent: {name}{Color.RESET}" if name else None


def fmt_vim(raw: RawStatus) -> str | None:
    vim: VimState = raw.get("vim") or {}
    mode = vim.get("mode")
    if not mode:
        return None
    color = Color.YELLOW if mode == "NORMAL" else Color.CYAN
    return f"{color}VIM:{mode}{Color.RESET}"


def fmt_output_style(raw: RawStatus) -> str | None:
    style_entity: NamedEntity = raw.get("output_style") or {}
    style = style_entity.get("name", "")
    if not style or style.lower() == "default":
        return None
    return f"{Color.DIM}style:{style}{Color.RESET}"


def _is_peak_hour() -> bool:
    """True when the current PT time is a weekday between 5 AM and 11 AM."""
    now_pt = datetime.now(PT_TZ)
    return now_pt.weekday() < 5 and PEAK_START_HOUR_PT <= now_pt.hour < PEAK_END_HOUR_PT


def fmt_peak_hours() -> str:
    """RED 'peak' during high-demand hours; GREEN 'off-peak' otherwise."""
    if _is_peak_hour():
        return f"{Color.RED}peak{Color.RESET}"
    return f"{Color.GREEN}off-peak{Color.RESET}"


# --- Resource metrics ---


def fmt_context(raw: RawStatus) -> str | None:
    ctx: ContextWindow = raw.get("context_window") or {}
    pct = ctx.get("used_percentage")
    if pct is None:
        return None
    color = _pct_color(pct)
    return f"ctx {color}{pct:.1f}%{Color.RESET}"


def fmt_tokens(raw: RawStatus) -> str | None:
    ctx: ContextWindow = raw.get("context_window") or {}
    cur: CurrentUsage = ctx.get("current_usage") or {}
    used = (
        (cur.get("input_tokens") or 0)
        + (cur.get("output_tokens") or 0)
        + (cur.get("cache_creation_input_tokens") or 0)
        + (cur.get("cache_read_input_tokens") or 0)
    )
    capacity = ctx.get("context_window_size")
    total_in = ctx.get("total_input_tokens") or 0
    total_out = ctx.get("total_output_tokens") or 0
    if not used and not total_in and not total_out:
        return None
    if not used:
        used = total_in + total_out
    cap_str = f"/{fmt_k(capacity)}" if capacity else ""
    return f"{Color.DIM}{fmt_k(used)}{cap_str} ({fmt_k(total_in)}\u2191 {fmt_k(total_out)}\u2193){Color.RESET}"


def fmt_cost(raw: RawStatus) -> str | None:
    cost: Cost = raw.get("cost") or {}
    cost_usd = cost.get("total_cost_usd")
    if not cost_usd:
        return None
    return f"{Color.YELLOW}${cost_usd:.2f}{Color.RESET}"


def fmt_lines_delta(raw: RawStatus) -> str | None:
    cost: Cost = raw.get("cost") or {}
    added = cost.get("total_lines_added")
    removed = cost.get("total_lines_removed")
    if added is None and removed is None:
        return None
    a = added or 0
    r = removed or 0
    return f"{Color.GREEN}+{a}{Color.RESET}/{Color.RED}-{r}{Color.RESET}"


def fmt_duration(raw: RawStatus) -> str | None:
    """Wall-clock lifetime of this session (start → now)."""
    cost: Cost = raw.get("cost") or {}
    total_ms = cost.get("total_duration_ms")
    if not total_ms:
        return None
    total_secs = total_ms // 1000
    hours, rem = divmod(total_secs, 3600)
    mins, secs = divmod(rem, 60)
    if hours:
        return f"{Color.DIM}session {hours}h{mins}m{Color.RESET}"
    if mins:
        return f"{Color.DIM}session {mins}m{secs}s{Color.RESET}"
    return f"{Color.DIM}session {secs}s{Color.RESET}"


def fmt_api_wait(raw: RawStatus) -> str | None:
    """Fraction of session time spent waiting on the model API."""
    cost: Cost = raw.get("cost") or {}
    total_ms = cost.get("total_duration_ms")
    api_ms = cost.get("total_api_duration_ms")
    if not total_ms or not api_ms:
        return None
    pct = int(api_ms / total_ms * 100)
    return f"{Color.DIM}api-bound {pct}%{Color.RESET}"


# --- Rate limits with pace delta ---

# Window durations — used to derive window start from resets_at
WINDOW_SECS = {"5h": 5 * 3600, "7d": 7 * 24 * 3600}


def _is_sleeping_now() -> bool:
    h = datetime.now(BEIJING_TZ).hour
    return h >= SLEEP_START_HOUR_BJT or h < SLEEP_END_HOUR_BJT


def _active_seconds_between(start: float, end: float) -> float:
    """Seconds in [start, end] that fall outside BJT sleep window [23:00, 06:00).

    Walks day-by-day so sleep blocks crossing midnight, and windows that
    begin or end mid-sleep, are handled without off-by-one slop.
    """
    if end <= start:
        return 0.0
    sleep_secs = 0.0
    # Start one day before first_day to catch a sleep block owned by the
    # previous calendar day (23:00 prev → 06:00 today) overlapping [start, end].
    first_day = datetime.fromtimestamp(start, tz=BEIJING_TZ).date()
    last_day = datetime.fromtimestamp(end, tz=BEIJING_TZ).date()
    day = first_day - timedelta(days=1)
    while day <= last_day:
        sleep_begin = datetime(
            day.year,
            day.month,
            day.day,
            SLEEP_START_HOUR_BJT,
            0,
            0,
            tzinfo=BEIJING_TZ,
        )
        sleep_finish = sleep_begin + timedelta(
            hours=(24 - SLEEP_START_HOUR_BJT) + SLEEP_END_HOUR_BJT,
        )
        o_start = max(sleep_begin.timestamp(), start)
        o_end = min(sleep_finish.timestamp(), end)
        if o_end > o_start:
            sleep_secs += o_end - o_start
        day += timedelta(days=1)
    return (end - start) - sleep_secs


def _elapsed_pct(
    resets_at: int | None,
    window_secs: int,
    sleep_aware: bool = False,
) -> float | None:
    """Percent of window elapsed. If sleep_aware, counts only active BJT hours."""
    if resets_at is None:
        return None
    window_start = resets_at - window_secs
    now = time.time()
    if now <= window_start or now >= resets_at:
        return None
    if sleep_aware:
        elapsed = _active_seconds_between(window_start, now)
        total = _active_seconds_between(window_start, resets_at)
    else:
        elapsed = now - window_start
        total = window_secs
    return (elapsed / total) * 100 if total > 0 else None


def _optimal_delta(
    used_pct: float,
    resets_at: int | None,
    window_secs: int,
    sleep_aware: bool = False,
) -> float | None:
    """Percentage points spent above (+) or below (−) the optimal pace."""
    elapsed_pct = _elapsed_pct(resets_at, window_secs, sleep_aware)
    return None if elapsed_pct is None else used_pct - elapsed_pct


def _projected_final_pct(
    used_pct: float,
    resets_at: int | None,
    window_secs: int,
    sleep_aware: bool = False,
) -> float | None:
    """Extrapolate usage to reset time at current per-(active-)minute pace."""
    if resets_at is None:
        return None
    window_start = resets_at - window_secs
    now = time.time()
    if now <= window_start or now >= resets_at:
        return None
    if sleep_aware:
        elapsed = _active_seconds_between(window_start, now)
        total = _active_seconds_between(window_start, resets_at)
    else:
        elapsed = now - window_start
        total = window_secs
    if elapsed <= 0:
        return None
    return used_pct * (total / elapsed)


def _delta_color(delta: float) -> Color:
    """Only overspend is urgent: ≤0 green, 0<Δ≤10 yellow, >10 red."""
    if delta > 10:
        return Color.RED
    if delta > 0:
        return Color.YELLOW
    return Color.GREEN


def _fmt_remaining(epoch: int | None) -> str:
    """Time until reset, as two largest non-zero units: `Xd:Yh` / `Xh:Ym` / `Xm`."""
    if not epoch:
        return ""
    remaining = int(epoch - time.time())
    if remaining <= 0:
        return " reset now"
    days, rem = divmod(remaining, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days > 0:
        return f" {days}d:{hours}h left"
    if hours > 0:
        return f" {hours}h:{minutes}m left"
    return f" {minutes}m left"


def _fmt_rate_window(
    label: str,
    used_pct: float,
    resets_at: int | None,
    window_secs: int,
    sleep_aware: bool = False,
) -> str:
    """Format one rate-limit window: current usage + delta from optimal pace."""
    color = _pct_color(used_pct)
    base = f"{label} {color}{used_pct:.1f}%{Color.RESET}"
    delta = _optimal_delta(used_pct, resets_at, window_secs, sleep_aware)
    if delta is not None:
        dc = _delta_color(delta)
        base += f" {dc}({delta:+.1f}%){Color.RESET}"
    # During BJT sleep, the delta above is naturally frozen (sleep-aware math
    # treats these hours as zero-elapsed). Append a forward projection so the
    # user sees where the window lands if the current active-hour pace holds.
    if sleep_aware and _is_sleeping_now():
        final = _projected_final_pct(used_pct, resets_at, window_secs, sleep_aware)
        if final is not None:
            base += f" {Color.DIM}[sleep \u2192 est {final:.1f}%]{Color.RESET}"
    base += f"{Color.DIM}{_fmt_remaining(resets_at)}{Color.RESET}"
    return base


def fmt_rate_limits(raw: RawStatus) -> str | None:
    rl: RateLimits = raw.get("rate_limits") or {}
    five_h: RateWindow = rl.get("five_hour") or {}
    seven_d: RateWindow = rl.get("seven_day") or {}
    parts: list[str] = []
    if (five := five_h.get("used_percentage")) is not None:
        parts.append(_fmt_rate_window("5h", five, five_h.get("resets_at"), WINDOW_SECS["5h"]))
    if (week := seven_d.get("used_percentage")) is not None:
        parts.append(
            _fmt_rate_window(
                "7d",
                week,
                seven_d.get("resets_at"),
                WINDOW_SECS["7d"],
                sleep_aware=True,
            )
        )
    return SEP.join(parts) if parts else None


# ---------------------------------------------------------------------------
# Composition
# ---------------------------------------------------------------------------


def main() -> None:
    raw: RawStatus = json.load(sys.stdin)

    # Record usage snapshot to history DB (async, non-blocking)
    db_thread = record_snapshot_async(raw)

    # Line 1: identity — model, git branch+status, cwd, peak-hour indicator
    line1 = join(
        fmt_model(raw),
        fmt_git(raw),
        fmt_cwd(raw),
        fmt_peak_hours(),
    )

    # Line 2: session state — worktree, agent, vim, style
    line2 = join(
        fmt_worktree(raw),
        fmt_agent(raw),
        fmt_vim(raw),
        fmt_output_style(raw),
    )

    # Line 3: resource usage — context, tokens, cost, lines, duration, api wait
    line3 = join(
        fmt_context(raw),
        fmt_tokens(raw),
        fmt_cost(raw),
        fmt_lines_delta(raw),
        fmt_duration(raw),
        fmt_api_wait(raw),
    )

    # Line 4: rate limits
    line4 = fmt_rate_limits(raw)

    lines: list[str | None] = [line1, line2, line3, line4]
    print("\n".join(line for line in lines if line), end="")

    # Let DB write finish (daemon thread) — brief wait, never blocks long
    db_thread.join(timeout=0.5)


if __name__ == "__main__":
    main()
