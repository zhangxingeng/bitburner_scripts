import { NS } from '@ns';
import { runTerminalCommandEnsured, readScreen } from './launcher';
import { PORT_HEARTBEAT, PORT_DECISION, PORT_LAUNCHER, PORT_NOTIFY, popPort, peekPort, pushPort } from '../lib/ports';
import { loadPending, pushReply, type PendingDecision, type Verdict } from '../lib/decisions';

/**
 * Game Agent — real-time control channel + file↔port relay daemon on home.
 *
 * DUAL ROLE (see docs/mcp/plan-mcp-realtime-control.md §1 for architecture):
 *   CONTROL CHANNEL: Opens an outbound WebSocket to the bridge (:12527) for
 *     sub-10ms bidirectional control.  Bridge forwards MCP control.cmd frames
 *     as {t:'cmd'} over this socket; agent responds {t:'res'}; agent pushes
 *     {t:'state'} frames (screen/notifications/heartbeat/decisions) unsolicited.
 *     Wire protocol is FROZEN in §2a — do not rename fields.
 *   RFA FALLBACK: When the control channel is down, the file-relay
 *     (status/.cmd.json ↔ status/.result.json) and port mirrors remain active.
 *
 * MOVED from monitor/game_agent.ts (Phase 3 cross-cutting migration).
 * Path update required: redeploy this script from /cross/game_agent.js (not /monitor/).
 *
 * FILE RELAY:  Reads /status/.cmd.json, processes commands, writes /status/.result.json.
 *              This is the bridge between MCP tools (file I/O via bridge RPC) and
 *              in-game port-based IPC.
 *
 * PORT MIRROR: Peeks PORT_HEARTBEAT (port 3) → status/heartbeat.txt + WS state push.
 *              Drains PORT_DECISION (port 4) → appends to status/decisions.json + WS push.
 *              Drains PORT_NOTIFY (port 9) → status/notifications.txt + WS state push.
 *
 * SCREEN MIRROR: readScreen() tail → status/screen.txt + WS state push (~1 s cadence).
 *
 * RAM: ~6.9 GB — fits on 8 GB home with 1.1 GB free.
 *      write(1.0) + read(1.0) + rm(1.0) + run(1.0) + kill(0.5) + ps(0.2)
 *      + getPlayer(0.3) + getServer(0.3) + getHostname(0.05)
 *      + fileExists(0) + readPort(0) + writePort(0) + peek(0)
 *      + sleep(0) + print(0) + disableLog(0)
 *      = 1.6 + 5.35 = 6.95 GB
 *      readScreen() import adds 0 GB (eval-hidden DOM; pure string ops).
 *      eval('WebSocket') adds 0 GB (browser global; static analyzer never sees the token).
 *      ns.write for screen mirror already counted above.
 *      isRunning(0.1) added for processLauncherCommands double-spawn guard.
 *      In-game validated: 6.55 GB (screen mirror); 6.65 GB (step 5, est.).
 *
 * Launch: ns.run('/cross/game_agent.js', 1)
 */

// ── Types ──

interface GameCommand {
    id:       string;
    method:   'run' | 'kill' | 'ps' | 'getPlayer' | 'getServer' | 'readPort' | 'writePort' | 'peekPort' | 'terminal' | 'ping' | 'decide';
    script?:  string;
    host?:    string;
    threads?: number;
    args?:    (string | number | boolean)[];
    target?:  string;
    port?:    number;
    data?:    unknown;
    pid?:     number;
    command?: string;
}

interface CommandResult {
    id:       string;
    success:  boolean;
    pid?:     number;
    data?:    unknown;
    error?:   string;
}

// ── Control channel wire protocol types (§2a of plan-mcp-realtime-control.md) ──
// Field names are FROZEN — do not rename; the bridge and MCP implement against these exactly.

interface ControlCmd {
    t:      'cmd';
    id:     number;
    method: string;
    params: Record<string, unknown>;
}

// ── Config ──

const STATUS_DIR    = 'status';
const CMD_FILE      = `${STATUS_DIR}/.cmd.json`;
const RESULT_FILE   = `${STATUS_DIR}/.result.json`;
// The control-command queue is drained every DRAIN_SLEEP_MS (low latency), while the
// heavier mirror/state work runs only every MIRROR_EVERY drains (≈200 ms, unchanged).
// This keeps control.cmd round-trips at ~10 ms without flooding file I/O at 100 Hz.
const DRAIN_SLEEP_MS = 10;
const MIRROR_EVERY   = 20;   // 10 ms × 20 = ~200 ms mirror/heartbeat cadence

// Control channel
const CONTROL_WS_URL  = 'ws://localhost:12527';
const RECONNECT_DELAY = 1000;   // ms — throttle reconnect attempts when bridge is down

// WebSocket readyState constants (numeric literals avoid referencing the global at static-analysis time)
const WS_CLOSED = 3;

// ── File helpers ──

function writeJson(ns: NS, path: string, data: unknown): void {
    try {
        ns.write(path, JSON.stringify(data, null, 2), 'w');
    } catch (e) {
        ns.print(`WARN: write failed ${path}: ${String(e)}`);
    }
}

function readJson<T>(ns: NS, path: string): T | null {
    try {
        if (!ns.fileExists(path)) return null;
        const raw = ns.read(path);
        if (!raw || raw.trim() === '') return null;
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function deleteFile(ns: NS, path: string): void {
    try {
        if (ns.fileExists(path)) ns.rm(path);
    } catch { /* ignore */ }
}

// ── Port Mirroring ──

/**
 * Mirror heartbeat and decisions ports to status files.
 * Returns drained decisions and peeked heartbeat for WS state push.
 */
function mirrorPorts(ns: NS): { decisions: unknown[]; heartbeat: string | null } {
    const decisions: unknown[] = [];
    let heartbeat: string | null = null;
    try {
        // Heartbeat from PORT_HEARTBEAT (peek, don't consume)
        heartbeat    = peekPort(ns, PORT_HEARTBEAT);
        const alive  = heartbeat !== null;
        writeJson(ns, `${STATUS_DIR}/heartbeat.txt`, {
            alive,
            lastSeen: Date.now(),
            data:     alive ? String(heartbeat) : 'NULL PORT DATA',
        });

        // Decisions from PORT_DECISION (drain all entries)
        let entry = popPort(ns, PORT_DECISION);
        while (entry !== null) {
            decisions.push(entry);
            entry = popPort(ns, PORT_DECISION);
        }
        if (decisions.length > 0) {
            // Append to existing decisions file
            let existing: unknown[] = [];
            try {
                if (ns.fileExists(`${STATUS_DIR}/decisions.json`)) {
                    const raw = ns.read(`${STATUS_DIR}/decisions.json`);
                    if (raw && raw.trim()) existing = JSON.parse(raw as string);
                }
            } catch { /* start fresh */ }
            existing.push(...decisions);
            if (existing.length > 1000) existing = existing.slice(existing.length - 1000);
            writeJson(ns, `${STATUS_DIR}/decisions.json`, existing);
        }
    } catch (e) {
        ns.print(`WARN: mirrorPorts error: ${String(e)}`);
    }
    return { decisions, heartbeat };
}

// ── Screen Mirror (read-side) ──────────────────────────────────────────────────

/**
 * Mirror the rendered terminal tail to `status/screen.txt` at ~1 s cadence.
 *
 * This is the symmetric **read** hand to `processLauncherCommands`'s **write**
 * hand (see player-automation-and-control design §4 "Read-side").  The external
 * agent fetches `status/screen.txt` via the existing MCP `read_file` path.
 *
 * Returns the screen text when a mirror fires (tick % 5 === 0) for the caller
 * to push as a WS state frame; returns null on off-ticks.
 *
 * @param ns   Netscript handle (for `writeJson`).
 * @param tick Loop iteration counter (mirror fires when tick % 5 === 0).
 */
function mirrorScreen(ns: NS, tick: number): string | null {
    if (tick % 5 !== 0) return null;                  // ~1 s cadence (5 × 200 ms)
    try {
        const text = readScreen();
        writeJson(ns, `${STATUS_DIR}/screen.txt`, { ts: Date.now(), text });
        return text;
    } catch (e) {
        ns.print(`WARN: mirrorScreen error: ${String(e)}`);
        return null;
    }
}

// ── Notify Mirror (PORT_NOTIFY → status/notifications.txt) ─────────────────────

/**
 * Drain all queued messages from PORT_NOTIFY, append to `status/notifications.txt`,
 * and return the drained items for WS state push.
 *
 * Messages include LAUNCHER_INJECT receipts (from `processLauncherCommands`) and any
 * notifications pushed by player modules or the notification helper.  Rolling cap of
 * 500 entries — old entries are trimmed from the front.
 *
 * Runs every tick (drain is cheap; writes only when new messages arrive).
 */
function mirrorNotify(ns: NS): unknown[] {
    const notifications: unknown[] = [];
    try {
        let entry = popPort(ns, PORT_NOTIFY);
        while (entry !== null) {
            try { notifications.push(JSON.parse(entry)); } catch { notifications.push(entry); }
            entry = popPort(ns, PORT_NOTIFY);
        }
        if (notifications.length === 0) return notifications;
        let existing: unknown[] = [];
        try {
            if (ns.fileExists(`${STATUS_DIR}/notifications.txt`)) {
                const raw = ns.read(`${STATUS_DIR}/notifications.txt`);
                if (raw?.trim()) existing = JSON.parse(raw as string);
            }
        } catch { /* start fresh on parse error */ }
        existing.push(...notifications);
        if (existing.length > 500) existing = existing.slice(existing.length - 500);
        writeJson(ns, `${STATUS_DIR}/notifications.txt`, existing);
    } catch (e) {
        ns.print(`WARN: mirrorNotify error: ${String(e)}`);
    }
    return notifications;
}

// ── Launcher Command Channel ──

/**
 * Pop ONE queued terminal command from PORT_LAUNCHER and inject it via the
 * contained launcher (UI interfacing only — see player-automation-and-control design §1).
 * One per loop iteration naturally rate-limits the terminal to the loop cadence.
 * Driven externally by the MCP `write_port(12, "<command>")` tool.
 *
 * Guard: if the command is `run <script> [args]` and the script is already
 * running on home, skip the inject and push an ALREADY_RUNNING notification
 * to PORT_NOTIFY.  Prevents double-spawning persistent player modules
 * (faction_manager, crime) triggered via MCP without checking first.
 */
async function processLauncherCommands(ns: NS): Promise<void> {
    const command = popPort(ns, PORT_LAUNCHER);
    if (command === null || command === '') return;

    // Double-spawn guard for persistent modules
    const runMatch = /^run\s+(\S+)/.exec(command);
    if (runMatch) {
        const script = runMatch[1];
        if (ns.isRunning(script, 'home')) {
            ns.print(`Launcher skip (already running): ${command}`);
            pushPort(ns, PORT_NOTIFY, JSON.stringify({
                ts: Date.now(), type: 'ALREADY_RUNNING', script, command,
            }));
            return;
        }
    }

    const ok = await runTerminalCommandEnsured(ns, command);
    ns.print(`Launcher inject ${ok ? 'OK' : 'FAILED'}: ${command}`);
    pushPort(ns, PORT_NOTIFY, JSON.stringify({
        ts: Date.now(), type: 'LAUNCHER_INJECT', command, ok,
    }));
}

// ── Command Execution (RFA file-relay path) ──

async function executeCommand(ns: NS, cmd: GameCommand): Promise<CommandResult> {
    const result: CommandResult = { id: cmd.id, success: false };

    try {
        switch (cmd.method) {
            case 'run': {
                if (!cmd.script) { result.error = 'Missing script'; break; }
                const pid = ns.run(cmd.script, cmd.threads ?? 1, ...(cmd.args ?? []));
                result.success = pid > 0;
                result.pid     = pid;
                if (!result.success) result.error = `Failed to run ${cmd.script}`;
                break;
            }

            case 'kill': {
                if (cmd.pid) {
                    result.success = ns.kill(cmd.pid);
                } else if (cmd.script) {
                    result.success = ns.kill(cmd.script, cmd.host ?? ns.getHostname());
                } else {
                    result.error = 'Missing pid or script';
                }
                if (!result.success && !result.error) result.error = 'kill failed';
                break;
            }

            case 'ps': {
                const host = cmd.host ?? 'home';
                result.data = ns.ps(host).map(p => ({
                    filename: p.filename, threads: p.threads, pid: p.pid,
                }));
                result.success = true;
                break;
            }

            case 'getPlayer': {
                const player = ns.getPlayer();
                result.data = {
                    hacking:  player.skills.hacking,
                    money:    player.money,
                    income:   (player as any).workMoneyGainRate ?? 0,
                    playtime: player.totalPlaytime,
                    skills:   { ...player.skills },
                    hp:       player.hp,
                    location: player.city,
                    factions: player.factions,
                };
                result.success = true;
                break;
            }

            case 'getServer': {
                const target = cmd.target ?? cmd.host ?? 'home';
                const server = ns.getServer(target);
                result.data = {
                    hostname:          server.hostname,
                    maxRam:            server.maxRam,
                    usedRam:           server.ramUsed ?? 0,
                    moneyAvailable:    server.moneyAvailable ?? 0,
                    moneyMax:          server.moneyMax ?? 0,
                    hackDifficulty:    server.hackDifficulty ?? 0,
                    minDifficulty:     server.minDifficulty ?? 0,
                    requiredHacking:   server.requiredHackingSkill ?? 0,
                    hasAdminRights:    server.hasAdminRights,
                    backdoorInstalled: server.backdoorInstalled ?? false,
                    cpuCores:          server.cpuCores,
                };
                result.success = true;
                break;
            }

            case 'readPort': {
                result.data    = ns.readPort(Number(cmd.port ?? 1));
                result.success = true;
                break;
            }

            case 'writePort': {
                if (cmd.data === undefined) { result.error = 'Missing data'; break; }
                const written = ns.writePort(
                    Number(cmd.port ?? 1),
                    typeof cmd.data === 'string' ? cmd.data : JSON.stringify(cmd.data),
                );
                // Phase 0 fix: ns.writePort v3 returns null on a clean write and the evicted
                // element when the port was full.  It never "fails" except by exception
                // (caught by the surrounding try/catch).
                result.success = true;
                result.data    = written;   // null = appended cleanly; non-null = the evicted element
                break;
            }

            case 'peekPort': {
                result.data    = ns.peek(Number(cmd.port ?? 1));
                result.success = true;
                break;
            }

            case 'terminal': {
                if (!cmd.command) { result.error = 'Missing command'; break; }
                // Double-spawn guard: mirrors processLauncherCommands behaviour
                const runMatch = /^run\s+(\S+)/.exec(cmd.command);
                if (runMatch) {
                    const script = runMatch[1];
                    if (ns.isRunning(script, 'home')) {
                        pushPort(ns, PORT_NOTIFY, JSON.stringify({
                            ts: Date.now(), type: 'ALREADY_RUNNING', script, command: cmd.command,
                        }));
                        result.success = true;
                        result.data    = { injected: false };
                        break;
                    }
                }
                const injected = await runTerminalCommandEnsured(ns, cmd.command);
                result.success = true;
                result.data    = { injected };
                break;
            }

            case 'ping': {
                result.success = true;
                result.data    = { pong: Date.now() };
                break;
            }

            case 'decide': {
                // Verdict command: data = { id: string; verdict: 'approve'|'deny'|'defer' }
                const payload    = cmd.data as { id?: unknown; verdict?: unknown } | null | undefined;
                const decisionId = payload && typeof payload.id === 'string' ? payload.id : null;
                const verdict    = payload && typeof payload.verdict === 'string' ? payload.verdict : null;
                if (!decisionId || decisionId === '') { result.error = 'Missing or invalid id'; break; }
                if (verdict !== 'approve' && verdict !== 'deny' && verdict !== 'defer') {
                    result.error = `Invalid verdict: ${String(verdict)}`; break;
                }
                const pushed = pushReply(ns, { id: decisionId, verdict: verdict as Verdict });
                result.success = pushed;
                if (!pushed) result.error = 'Port full';
                break;
            }

            default:
                result.error = `Unknown method: ${(cmd as any).method}`;
        }
    } catch (e) {
        result.error = `Exception: ${String(e)}`;
    }

    return result;
}

// ── Control Channel (WebSocket, outbound to bridge :12527) ────────────────────

// Module-level socket state — shared between connectControl(), handleControlCmd(), and main().
let ws:                WebSocket | null = null;
let connected                          = false;
let lastConnectAttempt                 = 0;

// Commands enqueued by the onmessage callback and drained in the main loop.
// WS callbacks run OUTSIDE the Netscript async context, so they MUST NOT call ns.*
// (an ns call from a callback throws uncaught and the engine kills the script).
// onmessage only parses + enqueues here; the loop does all ns work.
const inbound: ControlCmd[] = [];
let justConnected           = false;   // onopen sets this; the loop prints once (no ns in callbacks)

/**
 * Narrow an unknown WS message to a ControlCmd frame.
 * Trust boundary: WS data is a runtime value; type as unknown and narrow before use.
 */
function isControlCmd(m: unknown): m is ControlCmd {
    if (typeof m !== 'object' || m === null) return false;
    const o = m as Record<string, unknown>;
    return (
        o['t'] === 'cmd' &&
        typeof o['id'] === 'number' &&
        typeof o['method'] === 'string' &&
        typeof o['params'] === 'object' && o['params'] !== null
    );
}

/**
 * Handle a control command and return the §2a response frame.
 *
 * Called from the MAIN LOOP (after draining the `inbound` queue), NOT from the WS
 * onmessage callback — so it runs inside the Netscript async context and ns.* calls
 * are safe here.  Async: the 'terminal' case awaits `runTerminalCommandEnsured`,
 * which polls up to 800ms if the game isn't already on the Terminal page — this
 * blocks the drain of anything else queued behind it in `inbound`, an accepted
 * tradeoff since terminal commands are infrequent and the alternative (bare
 * runTerminalCommand's silent no-op off-page) is worse.
 */
async function handleControlCmd(
    ns:  NS,
    m:   ControlCmd,
): Promise<{ t: 'res'; id: number; ok: boolean; data?: unknown; error?: string }> {
    const { id, method, params } = m;
    try {
        switch (method) {
            case 'terminal': {
                const command = params['command'];
                if (typeof command !== 'string') return { t: 'res', id, ok: false, error: 'Missing command' };
                // Double-spawn guard: if injecting a `run` and the script is already live, skip.
                const runMatch = /^run\s+(\S+)/.exec(command);
                if (runMatch) {
                    const script = runMatch[1];
                    if (ns.isRunning(script, 'home')) {
                        pushPort(ns, PORT_NOTIFY, JSON.stringify({
                            ts: Date.now(), type: 'ALREADY_RUNNING', script, command,
                        }));
                        return { t: 'res', id, ok: true, data: { injected: false } };
                    }
                }
                const injected = await runTerminalCommandEnsured(ns, command);
                return { t: 'res', id, ok: true, data: { injected } };
            }

            case 'run': {
                const script = params['script'];
                if (typeof script !== 'string') return { t: 'res', id, ok: false, error: 'Missing script' };
                const threads = typeof params['threads'] === 'number' ? params['threads'] : 1;
                const rawArgs = params['args'];
                const args    = Array.isArray(rawArgs) ? rawArgs as (string | number | boolean)[] : [];
                const pid     = ns.run(script, threads, ...args);
                if (pid === 0) return { t: 'res', id, ok: false, error: `Failed to run ${script}` };
                return { t: 'res', id, ok: true, data: { pid } };
            }

            case 'kill': {
                let killed: boolean;
                if (typeof params['pid'] === 'number') {
                    killed = ns.kill(params['pid']);
                } else if (typeof params['script'] === 'string') {
                    const host = typeof params['host'] === 'string' ? params['host'] : ns.getHostname();
                    killed = ns.kill(params['script'], host);
                } else {
                    return { t: 'res', id, ok: false, error: 'Missing pid or script' };
                }
                return { t: 'res', id, ok: true, data: { killed } };
            }

            case 'ps': {
                const host  = typeof params['host'] === 'string' ? params['host'] : 'home';
                const procs = ns.ps(host).map(p => ({
                    filename: p.filename, threads: p.threads, pid: p.pid,
                }));
                return { t: 'res', id, ok: true, data: procs };
            }

            case 'getPlayer': {
                const player = ns.getPlayer();
                return { t: 'res', id, ok: true, data: {
                    hacking:  player.skills.hacking,
                    money:    player.money,
                    income:   (player as any).workMoneyGainRate ?? 0,
                    playtime: player.totalPlaytime,
                    skills:   { ...player.skills },
                    hp:       player.hp,
                    location: player.city,
                    factions: player.factions,
                }};
            }

            case 'getServer': {
                const target = typeof params['target'] === 'string' ? params['target']
                             : typeof params['host']   === 'string' ? params['host']
                             : 'home';
                const server = ns.getServer(target);
                return { t: 'res', id, ok: true, data: {
                    hostname:          server.hostname,
                    maxRam:            server.maxRam,
                    usedRam:           server.ramUsed ?? 0,
                    moneyAvailable:    server.moneyAvailable ?? 0,
                    moneyMax:          server.moneyMax ?? 0,
                    hackDifficulty:    server.hackDifficulty ?? 0,
                    minDifficulty:     server.minDifficulty ?? 0,
                    requiredHacking:   server.requiredHackingSkill ?? 0,
                    hasAdminRights:    server.hasAdminRights,
                    backdoorInstalled: server.backdoorInstalled ?? false,
                    cpuCores:          server.cpuCores,
                }};
            }

            case 'readPort': {
                const port = Number(params['port'] ?? 1);
                return { t: 'res', id, ok: true, data: ns.readPort(port) };
            }

            case 'writePort': {
                const port    = Number(params['port'] ?? 1);
                const rawData = params['data'];
                const data    = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
                // v3: returns null on a clean write; the evicted element when the port was full.
                const evicted: unknown = ns.writePort(port, data);
                return { t: 'res', id, ok: true, data: { evicted } };
            }

            case 'peekPort': {
                const port = Number(params['port'] ?? 1);
                return { t: 'res', id, ok: true, data: ns.peek(port) };
            }

            case 'ping':
                return { t: 'res', id, ok: true, data: { pong: Date.now() } };

            case 'decide': {
                // Verdict command: params = { id: string; verdict: 'approve'|'deny'|'defer' }
                const decisionId = params['id'];
                const verdict    = params['verdict'];
                if (typeof decisionId !== 'string' || decisionId === '') {
                    return { t: 'res', id, ok: false, error: 'Missing or invalid id' };
                }
                if (verdict !== 'approve' && verdict !== 'deny' && verdict !== 'defer') {
                    return { t: 'res', id, ok: false, error: `Invalid verdict: ${String(verdict)}` };
                }
                const pushed = pushReply(ns, { id: decisionId, verdict: verdict as Verdict });
                return { t: 'res', id, ok: pushed, data: { pushed }, ...(pushed ? {} : { error: 'Port full' }) };
            }

            default:
                return { t: 'res', id, ok: false, error: `Unknown method: ${method}` };
        }
    } catch (e) {
        return { t: 'res', id, ok: false, error: `Exception: ${String(e)}` };
    }
}

/**
 * Open the outbound control WebSocket to the bridge (:12527).
 *
 * Throttled to RECONNECT_DELAY ms between attempts so a downed bridge is not
 * hammered.  Guards against duplicate sockets: exits early if ws is non-null
 * and not CLOSED.
 *
 * Stealth eval pattern: same as launcher.ts's eval('docu'+'ment') — keeps the
 * literal token 'WebSocket' out of source so the static RAM analyzer never
 * charges the 25 GB DOM penalty.
 */
function connectControl(ns: NS): void {
    // Guard: do not open a second socket if one is already live or connecting
    if (ws !== null && ws.readyState !== WS_CLOSED) return;

    const now = Date.now();
    if (now - lastConnectAttempt < RECONNECT_DELAY) return;
    lastConnectAttempt = now;

    try {
        // eslint-disable-next-line no-eval
        const WS = eval('WebSocket') as typeof WebSocket;
        ws = new WS(CONTROL_WS_URL);

        // ── CALLBACKS RUN OUTSIDE THE NETSCRIPT ASYNC CONTEXT ──
        // They must NOT call ns.* — an ns call from here throws uncaught and the
        // engine kills the script (this was the startup-crash root cause). They only
        // mutate plain JS state / enqueue; the main loop does all ns work + ws.send.
        ws.onopen = () => {
            connected     = true;
            justConnected = true;
        };

        ws.onmessage = (ev: MessageEvent) => {
            let m: unknown;
            try { m = JSON.parse(ev.data as string); } catch { return; }
            if (isControlCmd(m)) inbound.push(m);   // drained in the main loop
        };

        ws.onclose = () => {
            connected = false;
            ws = null;
        };

        ws.onerror = () => {
            connected = false;
            ws = null;
        };
    } catch (e) {
        // connectControl() runs in the main loop, so ns.print here is safe.
        ns.print(`[control] Connect failed: ${String(e)}`);
        ws = null;
        connected = false;
    }
}

/** Send a §2a state frame over the control socket. No-op when disconnected. */
function pushState(channel: string, data: unknown): void {
    if (!connected || ws === null) return;
    try {
        ws.send(JSON.stringify({ t: 'state', channel, ts: Date.now(), data }));
    } catch { /* swallow; onerror/onclose will null ws */ }
}

// ── Main ──

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.print(`Game Agent started on ${ns.getHostname()} — control channel + file relay + port mirroring`);

    // Close the control socket on exit. Netscript does NOT auto-close sockets a
    // killed script opened — without this, every kill/restart leaks a zombie
    // socket whose browser-side callbacks keep firing on a dead ns instance,
    // hijacking the bridge's single controlSocket. atExit guarantees a clean close.
    ns.atExit(() => {
        try { ws?.close(); } catch { /* ignore */ }
        ws = null;
        connected = false;
    });

    let tick      = 0;   // mirror cycles; used by mirrorScreen for ~1 s throttle
    let drainTick = 0;   // fast-drain cycles; mirrors run when drainTick % MIRROR_EVERY === 0

    while (true) {
        try {
            // Reconnect control socket if not live (throttled internally by connectControl)
            if (!ws || ws.readyState === WS_CLOSED) connectControl(ns);

            // onopen can only set a flag (no ns in callbacks) — log the connect here.
            if (justConnected) {
                justConnected = false;
                ns.print('[control] Connected to bridge');
            }

            // FAST PATH (every ~10 ms): drain control commands enqueued by onmessage.
            // All ns work happens HERE, inside the Netscript async context — never in the
            // WS callback. ws.send is a browser API (not ns), so replying from the loop is safe.
            while (inbound.length > 0) {
                const cmd = inbound.shift()!;
                const res = await handleControlCmd(ns, cmd);
                try { ws?.send(JSON.stringify(res)); } catch { /* socket dropped; onclose will reset */ }
            }

            // SLOW PATH (every MIRROR_EVERY drains ≈ 200 ms): port/screen mirrors,
            // state pushes, and the RFA file-relay fallback. Decoupled from the fast
            // command drain so control.cmd latency stays ~10 ms without 100 Hz file I/O.
            if (drainTick % MIRROR_EVERY === 0) {
                // Mirror PORT_HEARTBEAT/PORT_DECISION → status files; capture for WS push
                const { decisions, heartbeat } = mirrorPorts(ns);

                // Drain PORT_NOTIFY → status/notifications.txt; capture for WS push
                const notifications = mirrorNotify(ns);

                // Read pending judgment calls from status/decisions_pending.json.
                // loadPending is a pure ns.read — cheap, zero side effects, no ports touched.
                // Exposed to the remote agent via the 'decisions_pending' WS state channel so
                // it can see (and reply to) the same queue the in-game DecisionsPanel shows.
                const pendingDecisions: PendingDecision[] = loadPending(ns);

                // Mirror rendered terminal tail → status/screen.txt (~1 s cadence);
                // returns non-null only on tick % 5 === 0 boundaries
                const screenText = mirrorScreen(ns, tick);

                // Drain one terminal command from PORT_LAUNCHER (RFA fallback path)
                await processLauncherCommands(ns);

                // Push state frames over the control channel when connected.
                // File mirrors above always run so the RFA fallback path keeps working
                // regardless of whether the control socket is up.
                if (connected) {
                    if (notifications.length > 0) pushState('notifications', notifications);
                    if (decisions.length > 0)     pushState('decisions', decisions);
                    if (screenText !== null)       pushState('screen', screenText);
                    // Heartbeat every mirror cycle — cheap peek, conveys liveness to the bridge
                    pushState('heartbeat', heartbeat);
                    // Pending judgment calls — push every cycle (current snapshot, not a diff)
                    // so the remote agent always has an up-to-date view of the queue even when
                    // no new items arrived.  Empty array signals "nothing awaiting verdict."
                    pushState('decisions_pending', pendingDecisions);
                }

                // Check for incoming MCP command (RFA file-relay fallback)
                const fileCmd = readJson<GameCommand>(ns, CMD_FILE);
                if (fileCmd?.id && fileCmd?.method) {
                    ns.print(`Agent: executing ${fileCmd.id} [${fileCmd.method}]`);
                    const result = await executeCommand(ns, fileCmd);
                    writeJson(ns, RESULT_FILE, result);
                    deleteFile(ns, CMD_FILE);
                }

                tick++;
            }

            drainTick++;
            await ns.sleep(DRAIN_SLEEP_MS);
        } catch (e) {
            ns.print(`ERROR: ${String(e)}`);
            await ns.sleep(5000);
        }
    }
}
