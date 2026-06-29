import { NS } from '@ns';
import { PORT_CMD, PORT_RESULT, PORT_HEARTBEAT, popPort, pushPort, clearPort } from '../lib/ports';

/**
 * Boot Agent — lightweight command relay running on home.
 *
 * MOVED from monitor/boot_agent.ts (Phase 3 cross-cutting migration).
 * Updated: magic port literals replaced with named constants from lib/ports.
 *
 * Reads JSON commands from PORT_CMD (port 1, written by Claude via MCP writePort),
 * executes them via ns.* APIs, writes results to PORT_RESULT (port 2).
 * Monitors phase_detector heartbeat on PORT_HEARTBEAT (port 3).
 *
 * Launch:  run /cross/boot_agent.js  (one-time manual step on boot)
 * RAM:     ~4.65 GB (run+exec+kill+ps+getHostname = 3.05 GB + ~1.6 GB base)
 *          Port-based IPC (readPort/writePort/peek: all 0 GB). No file I/O.
 */

// ── Command / Result Types ──

interface BootCommand {
    id:       string;
    method:   'exec' | 'run' | 'kill' | 'getState' | 'ps';
    script?:  string;
    host?:    string;
    threads?: number;
    args?:    (string | number | boolean)[];
    pid?:     number;
}

interface BootResult {
    id:       string;
    success:  boolean;
    pid?:     number;
    data?:    unknown;
    error?:   string;
}

// ── Constants ──

const HEARTBEAT_TIMEOUT_MS  = 30000;
const LOOP_INTERVAL_MS      = 500;
const PORT_CLEAR_INTERVAL   = 50;   // Clear heartbeat port every 50 ticks (~25s) to prevent overflow

// ── Command Execution ──

function executeCommand(ns: NS, cmd: BootCommand): BootResult {
    const result: BootResult = { id: cmd.id, success: false };

    switch (cmd.method) {
        case 'run': {
            if (!cmd.script) { result.error = 'Missing script'; break; }
            const pid = ns.run(cmd.script, cmd.threads ?? 1, ...(cmd.args ?? []));
            result.success = pid > 0;
            result.pid     = pid;
            if (!result.success) result.error = 'ns.run failed';
            break;
        }

        case 'exec': {
            if (!cmd.script || !cmd.host) { result.error = 'Missing script or host'; break; }
            const pid = ns.exec(cmd.script, cmd.host, cmd.threads ?? 1, ...(cmd.args ?? []));
            result.success = pid > 0;
            result.pid     = pid;
            if (!result.success) result.error = `ns.exec failed on ${cmd.host}`;
            break;
        }

        case 'kill': {
            if (cmd.pid) {
                result.success = ns.kill(cmd.pid);
            } else if (cmd.script) {
                result.success = ns.kill(cmd.script, cmd.host ?? 'home');
            } else {
                result.error = 'Missing pid or script';
            }
            if (!result.success && !result.error) result.error = 'kill failed';
            break;
        }

        case 'getState': {
            result.data    = { hostname: ns.getHostname(), pid: ns.pid };
            result.success = true;
            break;
        }

        case 'ps': {
            const host = cmd.host ?? 'home';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const processes = ns.ps(host) as any[];
            result.data = processes.map((p: any) => ({
                filename: p.filename, threads: p.threads, pid: p.pid,
            }));
            result.success = true;
            break;
        }

        default:
            result.error = `Unknown method: ${cmd.method}`;
    }

    return result;
}

// ── Main ──

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.print('Boot agent started on home');

    let lastHeartbeat = Date.now();
    let tick = 0;

    while (true) {
        tick++;

        // 1. Read command from PORT_CMD (non-blocking)
        const cmdStr = popPort(ns, PORT_CMD);
        if (cmdStr !== null && cmdStr !== '') {
            try {
                const cmd = JSON.parse(cmdStr) as BootCommand;
                ns.print(`Processing command: ${cmd.method} [${cmd.id}]`);
                const result = executeCommand(ns, cmd);
                pushPort(ns, PORT_RESULT, JSON.stringify(result));
            } catch (e) {
                pushPort(ns, PORT_RESULT, JSON.stringify({
                    id: 'error', success: false, error: String(e),
                }));
            }
        }

        // 2. Check heartbeat from PORT_HEARTBEAT (peek — doesn't consume)
        const heartbeat = ns.peek(PORT_HEARTBEAT);
        if (heartbeat !== 'NULL PORT DATA' && heartbeat !== null) {
            lastHeartbeat = Date.now();
        }

        // 3. Periodic clear of PORT_HEARTBEAT to prevent overflow
        //    Port holds 50 entries; heartbeat every 5s from phase_detector would fill
        //    in ~250s without consumption. Clear periodically to stay safe.
        if (tick % PORT_CLEAR_INTERVAL === 0) {
            clearPort(ns, PORT_HEARTBEAT);
        }

        // 4. Alert if heartbeat stale (phase_detector may be dead)
        if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
            ns.print('WARNING: No phase_detector heartbeat for 30s — /cross/phase_detector.js may be down');
        }

        await ns.sleep(LOOP_INTERVAL_MS);
    }
}
