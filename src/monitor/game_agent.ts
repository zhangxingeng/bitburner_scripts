import { NS } from '@ns';

/**
 * Game Agent — file↔port relay daemon on home.
 *
 * FILE RELAY:  Reads /status/.cmd.json, processes commands, writes /status/.result.json.
 *              This is the bridge between MCP tools (file I/O via bridge RPC) and
 *              in-game port-based IPC.
 *
 * PORT MIRROR: Peeks port 3 (heartbeat) → status/heartbeat.txt.
 *              Drains port 4 (decisions) → appends to status/decisions.json.
 *
 * REPORTER:    Launches /monitor/reporter.js every 5s (temp script — exits after snapshot).
 *
 * RAM: ~6.9 GB — fits on 8 GB home with 1.1 GB free.
 *      write(1.0) + read(1.0) + rm(1.0) + run(1.0) + kill(0.5) + ps(0.2)
 *      + getPlayer(0.3) + getServer(0.3) + getHostname(0.05)
 *      + fileExists(0) + readPort(0) + writePort(0) + peek(0)
 *      + sleep(0) + print(0) + disableLog(0)
 *      = 1.6 + 5.35 = 6.95 GB
 *
 * Launch: ns.run('/monitor/game_agent.js', 1)
 */

// ── Types ──

interface GameCommand {
  id: string;
  method: 'run' | 'kill' | 'ps' | 'getPlayer' | 'getServer' | 'readPort' | 'writePort' | 'peekPort';
  script?: string;
  host?: string;
  threads?: number;
  args?: (string | number | boolean)[];
  target?: string;
  port?: number;
  data?: unknown;
  pid?: number;
}

interface CommandResult {
  id: string;
  success: boolean;
  pid?: number;
  data?: unknown;
  error?: string;
}

// ── Config ──

const STATUS_DIR = 'status';
const CMD_FILE = `${STATUS_DIR}/.cmd.json`;
const RESULT_FILE = `${STATUS_DIR}/.result.json`;
// Reporter is a temp script that can be launched manually or by strategy_agent
// once home RAM is upgraded. See /monitor/reporter.js
const LOOP_SLEEP_MS = 200;

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

function mirrorPorts(ns: NS): void {
  try {
    // Heartbeat from port 3 (peek, don't consume)
    const heartbeat = ns.peek(3);
    const alive = heartbeat !== null && heartbeat !== 'NULL PORT DATA';
    writeJson(ns, `${STATUS_DIR}/heartbeat.txt`, {
      alive,
      lastSeen: Date.now(),
      data: alive ? String(heartbeat) : 'NULL PORT DATA',
    });

    // Decisions from port 4 (drain all entries)
    const decisions: unknown[] = [];
    let entry = ns.readPort(4);
    while (entry !== null && entry !== 'NULL PORT DATA') {
      decisions.push(entry);
      entry = ns.readPort(4);
    }
    if (decisions.length > 0) {
      // Append to existing decisions file
      let existing: unknown[] = [];
      try {
        if (ns.fileExists(`${STATUS_DIR}/decisions.json`)) {
          const raw = ns.read(`${STATUS_DIR}/decisions.json`);
          if (raw && raw.trim()) {
            existing = JSON.parse(raw as string);
          }
        }
      } catch { /* start fresh */ }
      existing.push(...decisions);
      if (existing.length > 1000) {
        existing = existing.slice(existing.length - 1000);
      }
      writeJson(ns, `${STATUS_DIR}/decisions.json`, existing);
    }
  } catch (e) {
    ns.print(`WARN: mirrorPorts error: ${String(e)}`);
  }
}

// ── Command Execution ──

function executeCommand(ns: NS, cmd: GameCommand): CommandResult {
  const result: CommandResult = { id: cmd.id, success: false };

  try {
    switch (cmd.method) {
      case 'run': {
        if (!cmd.script) { result.error = 'Missing script'; break; }
        const pid = ns.run(cmd.script, cmd.threads ?? 1, ...(cmd.args ?? []));
        result.success = pid > 0;
        result.pid = pid;
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
          hacking: player.skills.hacking,
          money: player.money,
          income: (player as any).workMoneyGainRate ?? 0,
          playtime: player.totalPlaytime,
          skills: { ...player.skills },
          hp: player.hp,
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
          hostname: server.hostname,
          maxRam: server.maxRam,
          usedRam: server.ramUsed ?? 0,
          moneyAvailable: server.moneyAvailable ?? 0,
          moneyMax: server.moneyMax ?? 0,
          hackDifficulty: server.hackDifficulty ?? 0,
          minDifficulty: server.minDifficulty ?? 0,
          requiredHacking: server.requiredHackingSkill ?? 0,
          hasAdminRights: server.hasAdminRights,
          backdoorInstalled: server.backdoorInstalled ?? false,
          cpuCores: server.cpuCores,
        };
        result.success = true;
        break;
      }

      case 'readPort': {
        result.data = ns.readPort(Number(cmd.port ?? 1));
        result.success = true;
        break;
      }

      case 'writePort': {
        if (cmd.data === undefined) { result.error = 'Missing data'; break; }
        const written = ns.writePort(
          Number(cmd.port ?? 1),
          typeof cmd.data === 'string' ? cmd.data : JSON.stringify(cmd.data),
        );
        result.data = written;
        result.success = written !== null;
        if (!result.success) result.error = 'Port full';
        break;
      }

      case 'peekPort': {
        result.data = ns.peek(Number(cmd.port ?? 1));
        result.success = true;
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

// ── Main ──

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');
  ns.print(`Game Agent started on ${ns.getHostname()} — file relay + port mirroring`);

  while (true) {
    try {
      // Mirror ports 3/4 → status files (heartbeat + decisions)
      mirrorPorts(ns);

      // Check for incoming MCP command
      const cmd = readJson<GameCommand>(ns, CMD_FILE);
      if (cmd?.id && cmd?.method) {
        ns.print(`Agent: executing ${cmd.id} [${cmd.method}]`);
        const result = executeCommand(ns, cmd);
        writeJson(ns, RESULT_FILE, result);
        deleteFile(ns, CMD_FILE);
      }

      await ns.sleep(LOOP_SLEEP_MS);
    } catch (e) {
      ns.print(`ERROR: ${String(e)}`);
      await ns.sleep(5000);
    }
  }
}
