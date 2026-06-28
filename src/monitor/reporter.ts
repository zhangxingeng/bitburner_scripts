import { NS } from '@ns';

/**
 * Status Reporter — temp script that snapshots game state and exits.
 *
 * Runs briefly every 5s (launched by game_agent or strategy_agent).
 * Writes status/*.txt files for MCP monitoring, then exits to free RAM.
 *
 * RAM: ~3.5 GB (write + getPlayer + scan + RAM + ps + ports)
 *       Temp script — RAM freed after exit.
 *
 * Launch: ns.run('/monitor/reporter.js', 1)
 */

const STATUS_DIR = 'status';

// ── BFS network scanner (inline, no imports) ──

function scanAll(ns: NS): string[] {
  const visited = new Set<string>(['home']);
  const queue: string[] = ['home'];
  const result: string[] = ['home'];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of ns.scan(current)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
        result.push(neighbor);
      }
    }
  }

  return result;
}

// ── Snapshots ──

interface PlayerSnapshot {
  hacking: number;
  money: number;
  income: number;
  playtime: number;
  hp: { current: number; max: number };
  skills: Record<string, number>;
  location: string;
  factions: string[];
}

function snapshotPlayer(ns: NS): PlayerSnapshot {
  const player = ns.getPlayer();
  return {
    hacking: player.skills.hacking,
    money: player.money,
    income: (player as any).workMoneyGainRate ?? 0,
    playtime: player.totalPlaytime,
    hp: player.hp,
    skills: { ...player.skills },
    location: player.city,
    factions: [...(player.factions ?? [])],
  };
}

interface RamSnapshot {
  hostname: string;
  maxRam: number;
  usedRam: number;
  freeRam: number;
  admin: boolean;
}

function snapshotRam(ns: NS): { servers: RamSnapshot[]; totals: { totalMaxRam: number; totalUsedRam: number; totalFreeRam: number } } {
  const servers: RamSnapshot[] = [];
  let totalMaxRam = 0;
  let totalUsedRam = 0;

  for (const hostname of scanAll(ns)) {
    if (hostname === 'home') continue; // Only report non-home
    const maxRam = ns.getServerMaxRam(hostname);
    // Skip servers with no RAM (not rooted / not useful)
    if (maxRam <= 0) continue;
    const usedRam = ns.getServerUsedRam(hostname);
    const admin = ns.hasRootAccess(hostname);
    servers.push({
      hostname,
      maxRam,
      usedRam,
      freeRam: Math.max(0, maxRam - usedRam),
      admin,
    });
    if (admin) {
      totalMaxRam += maxRam;
      totalUsedRam += usedRam;
    }
  }

  return {
    servers,
    totals: {
      totalMaxRam,
      totalUsedRam,
      totalFreeRam: Math.max(0, totalMaxRam - totalUsedRam),
    },
  };
}

interface ProcessSnapshot {
  filename: string;
  threads: number;
  pid: number;
  host: string;
}

function snapshotProcesses(ns: NS): ProcessSnapshot[] {
  const result: ProcessSnapshot[] = [];

  for (const hostname of scanAll(ns)) {
    if (!ns.hasRootAccess(hostname)) continue;
    try {
      for (const p of ns.ps(hostname)) {
        result.push({
          filename: p.filename,
          threads: p.threads,
          pid: p.pid,
          host: hostname,
        });
      }
    } catch {
      // Some servers reject ps()
    }
  }

  return result;
}

// ── Port Mirroring ──

interface PortMirrorResult {
  heartbeat: { alive: boolean; lastSeen: number; data: string };
  decisions: unknown[];
}

function mirrorPorts(ns: NS): PortMirrorResult {
  // Heartbeat from port 3 (peek, don't consume)
  const heartbeat = ns.peek(3);
  const alive = heartbeat !== null && heartbeat !== 'NULL PORT DATA';

  // Decisions from port 4 (drain all entries)
  const decisions: unknown[] = [];
  let entry = ns.readPort(4);
  while (entry !== null && entry !== 'NULL PORT DATA') {
    decisions.push(entry);
    entry = ns.readPort(4);
  }

  return {
    heartbeat: {
      alive,
      lastSeen: Date.now(),
      data: alive ? String(heartbeat) : 'NULL PORT DATA',
    },
    decisions,
  };
}

// ── Write helpers ──

function writeJson(ns: NS, path: string, data: unknown): void {
  ns.write(path, JSON.stringify(data, null, 2), 'w');
}

// ── Main ──

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');

  // Player
  writeJson(ns, `${STATUS_DIR}/player.txt`, snapshotPlayer(ns));

  // RAM
  writeJson(ns, `${STATUS_DIR}/ram.txt`, snapshotRam(ns));

  // Processes
  writeJson(ns, `${STATUS_DIR}/processes.txt`, snapshotProcesses(ns));

  // Port mirroring
  const mirror = mirrorPorts(ns);
  writeJson(ns, `${STATUS_DIR}/heartbeat.txt`, mirror.heartbeat);
  if (mirror.decisions.length > 0) {
    // Append to decisions file (don't overwrite)
    try {
      let existing: unknown[] = [];
      if (ns.fileExists(`${STATUS_DIR}/decisions.json`)) {
        const raw = ns.read(`${STATUS_DIR}/decisions.json`);
        if (raw && raw.trim()) {
          existing = JSON.parse(raw as string);
        }
      }
      existing.push(...mirror.decisions);
      if (existing.length > 1000) {
        existing = existing.slice(existing.length - 1000);
      }
      writeJson(ns, `${STATUS_DIR}/decisions.json`, existing);
    } catch {
      writeJson(ns, `${STATUS_DIR}/decisions.json`, mirror.decisions);
    }
  }

  ns.print(`Reporter done: player + ${mirror.decisions.length} decisions`);
}
