import { NS } from '@ns';

/**
 * Boot Agent — lightweight command relay running on home.
 *
 * Reads JSON commands from port 1 (written by Claude via MCP writePort),
 * executes them via ns.* APIs, writes results to port 2.
 * Monitors strategy_agent heartbeat on port 3.
 *
 * Launch:  run /monitor/boot_agent.js  (one-time manual step)
 * RAM:     ~4.65 GB (run+exec+kill+ps+getHostname = 3.05 GB + ~1.6 GB base)
 *          Port-based IPC (readPort/writePort/peek: all 0 GB). No file I/O.
 */

// ── Command / Result Types ──

interface BootCommand {
  id: string;
  method: 'exec' | 'run' | 'kill' | 'getState' | 'ps';
  script?: string;
  host?: string;
  threads?: number;
  args?: (string | number | boolean)[];
  pid?: number;
}

interface BootResult {
  id: string;
  success: boolean;
  pid?: number;
  data?: unknown;
  error?: string;
}

// ── Constants (Audit F9) ──

const PORT_CMD = 1;
const PORT_RESULT = 2;
const PORT_HEARTBEAT = 3;
const HEARTBEAT_TIMEOUT_MS = 30000;
const LOOP_INTERVAL_MS = 500;
const PORT_CLEAR_INTERVAL = 50; // Clear heartbeat port every 50 ticks (~25s) to prevent overflow

// ── Command Execution ──

function executeCommand(ns: NS, cmd: BootCommand): BootResult {
  const result: BootResult = { id: cmd.id, success: false };

  switch (cmd.method) {
    case 'run': {
      if (!cmd.script) { result.error = 'Missing script'; break; }
      const pid = ns.run(cmd.script, cmd.threads ?? 1, ...(cmd.args ?? []));
      result.success = pid > 0;
      result.pid = pid;
      if (!result.success) result.error = 'ns.run failed';
      break;
    }

    case 'exec': {
      if (!cmd.script || !cmd.host) { result.error = 'Missing script or host'; break; }
      const pid = ns.exec(cmd.script, cmd.host, cmd.threads ?? 1, ...(cmd.args ?? []));
      result.success = pid > 0;
      result.pid = pid;
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
      result.data = { hostname: ns.getHostname(), pid: ns.pid };
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

    // 1. Read command from port 1 (non-blocking)
    const cmdStr = ns.readPort(PORT_CMD);
    if (cmdStr !== 'NULL PORT DATA' && cmdStr !== null && cmdStr !== '') {
      try {
        const cmd = JSON.parse(String(cmdStr)) as BootCommand;
        ns.print(`Processing command: ${cmd.method} [${cmd.id}]`);
        const result = executeCommand(ns, cmd);
        ns.writePort(PORT_RESULT, JSON.stringify(result));
      } catch (e) {
        ns.writePort(PORT_RESULT, JSON.stringify({
          id: 'error', success: false, error: String(e),
        }));
      }
    }

    // 2. Check heartbeat from port 3 (peek, doesn't consume)
    const heartbeat = ns.peek(PORT_HEARTBEAT);
    if (heartbeat !== 'NULL PORT DATA' && heartbeat !== null) {
      lastHeartbeat = Date.now();
    }

    // 3. Periodic clear of heartbeat port to prevent overflow
    //    Port holds 50 entries; heartbeat every 5s from strategy_agent would fill
    //    in ~250s without consumption. Clear periodically to stay safe.
    if (tick % PORT_CLEAR_INTERVAL === 0) {
      ns.clearPort(PORT_HEARTBEAT);
    }

    // 4. Alert if heartbeat stale
    if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      ns.print('WARNING: No strategy agent heartbeat for 30s');
    }

    await ns.sleep(LOOP_INTERVAL_MS);
  }
}
