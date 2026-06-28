import { NS } from '@ns';

/**
 * Strategy Agent — autonomous brain on best available non-home server.
 *
 * RAM-SLIMMED: Removed ns.singularity.* (BUY_PROGRAM logs intent only),
 *              removed ns.write/ns.read (decisions via port 4 only),
 *              removed ns.hasTorRouter (unnecessary).
 *
 * 5 phases: BOOTSTRAP → SNOWBALL → EXPANSION → PREPARATION → BATCH
 * Phase transitions use hysteresis (PHASE_STABILITY_TICKS = 5).
 *
 * Launch: ns.exec('/monitor/strategy_agent.js', 'foodnstuff', 1)
 */

// ============================================================
// Constants
// ============================================================

const BOOT_AGENT_RAM = 4.45;
const STRATEGY_AGENT_RAM = 6.0;
const WORKER_SCRIPT_RAM = 1.75;
const MAX_PREP_TARGETS = 4;
const MAX_AUTOGROW_PER_SERVER = 2;
const HOME_RAM_RESERVE_FRACTION = 0.25;
const PHASE_STABILITY_TICKS = 5;
const HEARTBEAT_INTERVAL_MS = 5000;
const LOOP_INTERVAL_MS = 1000;
const SCAN_NUKE_COOLDOWN = 60000;

const PORT_HEARTBEAT = 3;
const PORT_DECISION = 4;

const MONEY_THRESHOLD = 0.9;
const SECURITY_THRESHOLD = 3;

// ============================================================
// Enums & Interfaces
// ============================================================

enum Phase {
  BOOTSTRAP,
  SNOWBALL,
  EXPANSION,
  PREPARATION,
  BATCH,
}

interface GameState {
  hackingLevel: number;
  money: number;
  incomeRate: number;

  homeMaxRam: number;
  homeUsedRam: number;
  homeFreeRam: number;

  relayRunningOn: string | null;
  relayPid: number;

  rootedServers: string[];
  rootedCount: number;
  unrootedServers: string[];
  unrootedNukable: number;

  serverFreeRam: Map<string, number>;
  hasDeployScripts: Map<string, boolean>;

  hasBruteSSH: boolean;
  hasFtpCrack: boolean;
  hasRelaySmtp: boolean;
  hasHttpWorm: boolean;
  hasSqlInject: boolean;
  hasAnyPortOpener: boolean;
  maxPorts: number;

  hackableServers: string[];
  bestTarget: string | null;
  preparedTargets: string[];
  unpreparedTargets: number;

  isBatchHackRunning: boolean;

  totalRamPool: number;
  totalMaxRam: number;

  hasFormulas: boolean;
}

interface PhaseStability {
  candidate: Phase | null;
  consecutiveTicks: number;
  readonly REQUIRED_TICKS: number;
}

interface AgentAPI {
  log: (message: string) => void;
  lastScanNukeTime: number;
}

type Action =
  | { type: 'RUN'; script: string; threads?: number; args?: (string | number)[] }
  | { type: 'EXEC'; script: string; host: string; threads?: number; args?: (string | number)[] }
  | { type: 'KILL'; script: string; host: string }
  | { type: 'SCP'; script: string; dest: string; source?: string }
  | { type: 'BUY_INTENT'; program: string; cost: number }
  | { type: 'DEPLOY'; host: string };

interface DecisionLogEntry {
  tick: number;
  phase: string;
  decision: string;
  details?: Record<string, unknown>;
  ts: number;
}

// ============================================================
// Helpers
// ============================================================

function findAllServers(ns: NS): string[] {
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

function countAvailablePortOpeners(state: Pick<GameState, 'hasBruteSSH' | 'hasFtpCrack' | 'hasRelaySmtp' | 'hasHttpWorm' | 'hasSqlInject'>): number {
  let c = 0;
  if (state.hasBruteSSH) c++;
  if (state.hasFtpCrack) c++;
  if (state.hasRelaySmtp) c++;
  if (state.hasHttpWorm) c++;
  if (state.hasSqlInject) c++;
  return c;
}

function countNukable(ns: NS, unrooted: string[], maxPorts: number): number {
  let c = 0;
  for (const host of unrooted) {
    const sv = ns.getServer(host);
    if ((sv.numOpenPortsRequired ?? 99) <= maxPorts) c++;
  }
  return c;
}

function findBestTarget(ns: NS, servers: string[]): string | null {
  let best: string | null = null;
  let bestVal = -1;
  for (const host of servers) {
    const sv = ns.getServer(host);
    const val = sv.moneyMax ?? 0;
    if (val > bestVal) { bestVal = val; best = host; }
  }
  return best;
}

// ============================================================
// snapshotGameState
// ============================================================

function snapshotGameState(ns: NS, myHostname: string): GameState {
  const state = {} as GameState;

  // Player
  const player = ns.getPlayer();
  state.hackingLevel = player.skills.hacking;
  state.money = player.money;
  state.incomeRate = (player as any).workMoneyGainRate ?? 0;

  // Home
  const homeInfo = ns.getServer('home');
  state.homeMaxRam = homeInfo.maxRam ?? 0;
  state.homeUsedRam = homeInfo.ramUsed ?? 0;
  state.homeFreeRam = Math.max(0, state.homeMaxRam - state.homeUsedRam);

  // Network
  const allServers = findAllServers(ns);
  const rooted: string[] = [];
  const unrooted: string[] = [];
  const hackable: string[] = [];
  const prepared: string[] = [];
  const serverFreeRam = new Map<string, number>();
  const hasDeployScripts = new Map<string, boolean>();
  let totalRamPool = 0;
  let totalMaxRam = 0;

  for (const host of allServers) {
    if (host === 'home') continue;

    const sv = ns.getServer(host);
    if (sv.hasAdminRights) {
      rooted.push(host);
      const maxRam = sv.maxRam ?? 0;
      const usedRam = sv.ramUsed ?? 0;
      const freeRam = Math.max(0, maxRam - usedRam);

      serverFreeRam.set(host, freeRam);
      totalRamPool += freeRam;
      totalMaxRam += maxRam;

      const h = ns.fileExists('/deploy/hack.js', host);
      const g = ns.fileExists('/deploy/grow.js', host);
      const w = ns.fileExists('/deploy/weaken.js', host);
      hasDeployScripts.set(host, h && g && w);

      if ((sv.moneyMax ?? 0) > 0 && state.hackingLevel >= (sv.requiredHackingSkill ?? Infinity)) {
        hackable.push(host);

        const moneyPct = (sv.moneyAvailable ?? 0) / (sv.moneyMax ?? 1);
        const securityDiff = (sv.hackDifficulty ?? 100) - (sv.minDifficulty ?? 1);
        if (moneyPct >= MONEY_THRESHOLD && securityDiff <= SECURITY_THRESHOLD) {
          prepared.push(host);
        }
      }
    } else {
      unrooted.push(host);
    }
  }

  state.rootedServers = rooted;
  state.rootedCount = rooted.length;
  state.unrootedServers = unrooted;
  state.serverFreeRam = serverFreeRam;
  state.hasDeployScripts = hasDeployScripts;
  state.totalRamPool = totalRamPool;
  state.totalMaxRam = totalMaxRam;

  // Port openers
  state.hasBruteSSH = ns.fileExists('BruteSSH.exe', 'home');
  state.hasFtpCrack = ns.fileExists('FTPCrack.exe', 'home');
  state.hasRelaySmtp = ns.fileExists('relaySMTP.exe', 'home');
  state.hasHttpWorm = ns.fileExists('HTTPWorm.exe', 'home');
  state.hasSqlInject = ns.fileExists('SQLInject.exe', 'home');
  state.hasAnyPortOpener = state.hasBruteSSH || state.hasFtpCrack || state.hasRelaySmtp
    || state.hasHttpWorm || state.hasSqlInject;
  state.maxPorts = countAvailablePortOpeners(state);
  state.unrootedNukable = countNukable(ns, unrooted, state.maxPorts);

  // Targets
  state.hackableServers = hackable;
  state.bestTarget = findBestTarget(ns, hackable);
  state.preparedTargets = prepared;
  state.unpreparedTargets = hackable.length - prepared.length;

  // Running state
  state.isBatchHackRunning = ns.isRunning('/contracts/batch_hack.js', 'home');

  // Programs
  state.hasFormulas = ns.fileExists('Formulas.exe', 'home');

  // Relay tracking
  state.relayRunningOn = myHostname;
  state.relayPid = ns.pid;

  return state;
}

// ============================================================
// detectPhase
// ============================================================

function detectPhase(s: GameState, prev: Phase, stab: PhaseStability): Phase {
  let target: Phase;

  if (s.homeMaxRam <= 16 && !s.relayRunningOn) {
    target = Phase.BOOTSTRAP;
  } else if (!s.hasAnyPortOpener || s.unrootedNukable > 0 || s.rootedCount < 5) {
    target = Phase.SNOWBALL;
  } else if (s.unrootedNukable > 0) {
    target = Phase.EXPANSION;
  } else if (s.unpreparedTargets > 0 && prev === Phase.PREPARATION) {
    target = Phase.PREPARATION;
  } else if (s.unpreparedTargets > 0) {
    target = Phase.PREPARATION;
  } else {
    target = Phase.BATCH;
  }

  if (target !== prev) {
    if (stab.candidate === target) {
      stab.consecutiveTicks++;
      if (stab.consecutiveTicks >= stab.REQUIRED_TICKS) {
        stab.candidate = null;
        stab.consecutiveTicks = 0;
        return target;
      }
      return prev;
    } else {
      stab.candidate = target;
      stab.consecutiveTicks = 1;
      return prev;
    }
  }

  stab.candidate = null;
  stab.consecutiveTicks = 0;
  return target;
}

// ============================================================
// Strategy Functions
// ============================================================

function strategyBootstrap(state: GameState, api: AgentAPI): Action[] {
  if (state.relayRunningOn) return [];

  const candidates = state.rootedServers
    .filter(h => h !== 'home')
    .filter(h => (state.serverFreeRam.get(h) ?? 0) > STRATEGY_AGENT_RAM)
    .sort((a, b) => (state.serverFreeRam.get(b) ?? 0) - (state.serverFreeRam.get(a) ?? 0));

  if (candidates.length > 0) {
    const target = candidates[0];
    api.log(`BOOTSTRAP: Deploying strategy agent to ${target}`);
    return [
      { type: 'SCP', script: '/monitor/strategy_agent.js', dest: target },
      { type: 'EXEC', script: '/monitor/strategy_agent.js', host: target, threads: 1 },
    ];
  }

  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN) {
    api.lastScanNukeTime = Date.now();
    return [
      { type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 },
    ];
  }

  return [];
}

function strategySnowball(state: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  // Periodic scan_nuke
  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  // Port opener purchase intent (one per cycle, affordable only)
  const openers = [
    { file: 'BruteSSH.exe', cost: 500000, key: 'hasBruteSSH' as const },
    { file: 'FTPCrack.exe', cost: 1500000, key: 'hasFtpCrack' as const },
    { file: 'relaySMTP.exe', cost: 5000000, key: 'hasRelaySmtp' as const },
    { file: 'HTTPWorm.exe', cost: 30000000, key: 'hasHttpWorm' as const },
    { file: 'SQLInject.exe', cost: 250000000, key: 'hasSqlInject' as const },
  ];
  for (const opener of openers) {
    if (!(state as any)[opener.key] && state.money > opener.cost * 1.5) {
      // Log purchase intent — player must buy manually from darkweb
      actions.push({ type: 'BUY_INTENT', program: opener.file, cost: opener.cost });
      api.log(`SNOWBALL: Purchase ${opener.file} from darkweb ($${opener.cost.toLocaleString()})`);
      break;
    }
  }

  // Hack best target
  if (state.bestTarget) {
    if (!state.preparedTargets.includes(state.bestTarget)) {
      actions.push({ type: 'EXEC', script: '/deploy/auto_grow.js', host: 'home', threads: 1, args: [state.bestTarget] });
    } else {
      actions.push({ type: 'EXEC', script: '/deploy/simple_hack_loop.js', host: 'home', threads: 1, args: [state.bestTarget] });
    }
  } else if (state.hackableServers.length === 0) {
    api.log('SNOWBALL: No hackable servers. Waiting for scan_nuke...');
  }

  // Deploy workers to servers that need them
  for (const host of state.rootedServers) {
    if (!(state.hasDeployScripts.get(host) ?? false)) {
      actions.push({ type: 'DEPLOY', host });
    }
  }

  return actions;
}

function strategyExpansion(state: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  for (const host of state.rootedServers) {
    if (!(state.hasDeployScripts.get(host) ?? false)) {
      actions.push({ type: 'DEPLOY', host });
    }
  }

  return actions;
}

function strategyPreparation(state: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  const targetsToPrep = state.hackableServers
    .filter(t => !state.preparedTargets.includes(t))
    .slice(0, MAX_PREP_TARGETS);

  const perServerCount = new Map<string, number>();

  for (const target of targetsToPrep) {
    for (const host of state.rootedServers) {
      const current = perServerCount.get(host) ?? 0;
      if (current >= MAX_AUTOGROW_PER_SERVER) continue;

      const freeRam = state.serverFreeRam.get(host) ?? 0;
      const threads = Math.floor(freeRam / WORKER_SCRIPT_RAM / (MAX_AUTOGROW_PER_SERVER + 1));
      if (threads > 0) {
        actions.push({ type: 'EXEC', script: '/deploy/auto_grow.js', host, threads, args: [target] });
        perServerCount.set(host, current + 1);
      }
    }
  }

  if (targetsToPrep.length > 0) {
    api.log(`PREPARATION: ${targetsToPrep.length} targets across servers`);
  }

  return actions;
}

function strategyBatch(state: GameState, api: AgentAPI): Action[] {
  const actions: Action[] = [];

  if (!state.isBatchHackRunning) {
    const minRam = WORKER_SCRIPT_RAM;
    if (state.homeFreeRam > minRam) {
      actions.push({
        type: 'RUN',
        script: '/contracts/batch_hack.js',
        threads: 1,
        args: ['--homeRam', String(Math.floor(state.homeMaxRam * HOME_RAM_RESERVE_FRACTION))],
      });
      api.log('BATCH: Starting HWGW batch hack system');
    } else {
      api.log(`BATCH: Insufficient RAM (need ${minRam}GB, have ${state.homeFreeRam}GB free)`);
    }
  }

  if (Date.now() - api.lastScanNukeTime > SCAN_NUKE_COOLDOWN) {
    actions.push({ type: 'EXEC', script: '/tools/scan_nuke.js', host: 'home', threads: 1 });
    api.lastScanNukeTime = Date.now();
  }

  return actions;
}

// ============================================================
// executeActions
// ============================================================

function executeActions(ns: NS, actions: Action[], api: AgentAPI): void {
  for (const action of actions) {
    switch (action.type) {
      case 'RUN': {
        const pid = ns.run(action.script, action.threads ?? 1, ...(action.args ?? []));
        api.log(pid > 0 ? `RUN: ${action.script} pid=${pid}` : `WARN: RUN failed — ${action.script}`);
        break;
      }

      case 'EXEC': {
        const pid = ns.exec(action.script, action.host, action.threads ?? 1, ...(action.args ?? []));
        api.log(pid > 0 ? `EXEC: ${action.script} on ${action.host} pid=${pid}` : `WARN: EXEC failed — ${action.script} on ${action.host}`);
        break;
      }

      case 'KILL': {
        const ok = ns.kill(action.script, action.host);
        if (!ok) api.log(`WARN: KILL failed — ${action.script} on ${action.host}`);
        break;
      }

      case 'SCP': {
        const ok = ns.scp(action.script, action.dest, action.source ?? 'home');
        api.log(ok ? `SCP: ${action.script} -> ${action.dest}` : `WARN: SCP failed — ${action.script} -> ${action.dest}`);
        break;
      }

      case 'BUY_INTENT': {
        // Purchase intent only — ns.singularity is NOT referenced (saves ~15+ GB)
        // Player sees this in the log and buys manually via darkweb
        api.log(`BUY_INTENT: ${action.program} ($${action.cost.toLocaleString()}) — buy from darkweb`);
        break;
      }

      case 'DEPLOY': {
        const scripts = ['/deploy/hack.js', '/deploy/grow.js', '/deploy/weaken.js'];
        let copied = 0;
        for (const script of scripts) {
          if (ns.scp(script, action.host, 'home')) copied++;
        }
        api.log(copied === scripts.length
          ? `DEPLOY: All 3 scripts -> ${action.host}`
          : `WARN: DEPLOY partial — ${copied}/3 -> ${action.host}`);
        break;
      }
    }
  }
}

// ============================================================
// Main
// ============================================================

export async function main(ns: NS): Promise<void> {
  ns.disableLog('ALL');
  const myHostname = ns.getHostname();
  ns.print('Strategy agent starting on ' + myHostname);

  let prevPhase = Phase.BOOTSTRAP;
  const stability: PhaseStability = {
    candidate: null,
    consecutiveTicks: 0,
    REQUIRED_TICKS: PHASE_STABILITY_TICKS,
  };
  const api: AgentAPI = {
    log: (message: string) => { ns.print(message); },
    lastScanNukeTime: 0,
  };
  let tickNumber = 0;

  while (true) {
    tickNumber++;
    const loopStart = Date.now();

    try {
      // Heartbeat to port 3 (every HEARTBEAT_INTERVAL_MS)
      if (tickNumber % (HEARTBEAT_INTERVAL_MS / LOOP_INTERVAL_MS) === 0) {
        ns.clearPort(PORT_HEARTBEAT);
        ns.writePort(PORT_HEARTBEAT, 'alive');
      }

      // Snapshot
      const state = snapshotGameState(ns, myHostname);

      // Phase detection
      const phase = detectPhase(state, prevPhase, stability);

      // Strategy actions
      let actions: Action[] = [];
      switch (phase) {
        case Phase.BOOTSTRAP:   actions = strategyBootstrap(state, api); break;
        case Phase.SNOWBALL:    actions = strategySnowball(state, api); break;
        case Phase.EXPANSION:   actions = strategyExpansion(state, api); break;
        case Phase.PREPARATION: actions = strategyPreparation(state, api); break;
        case Phase.BATCH:       actions = strategyBatch(state, api); break;
      }

      // Execute
      executeActions(ns, actions, api);

      // Log decision to port 4 (file mirroring handled by game_agent)
      if (phase !== prevPhase || actions.length > 0) {
        const entry: DecisionLogEntry = {
          tick: tickNumber,
          ts: Date.now(),
          phase: Phase[phase],
          decision: actions.length > 0 ? `${actions.length} action(s)` : 'idle',
          details: {
            rooted: state.rootedCount,
            money: Math.floor(state.money),
            batchRunning: state.isBatchHackRunning,
          },
        };
        if (phase !== prevPhase) {
          entry.details!.transitionedFrom = Phase[prevPhase];
        }
        const logStr = JSON.stringify(entry);
        ns.print(logStr);

        // Write to port 4 for game_agent to mirror to file
        try {
          ns.writePort(PORT_DECISION, logStr);
        } catch {
          // Port 4 may be full
        }
      }

      prevPhase = phase;
    } catch (error) {
      ns.print('ERROR in main loop: ' + String(error));
      if (prevPhase !== Phase.SNOWBALL) {
        ns.print('REGRESSION: falling back to SNOWBALL');
        prevPhase = Phase.SNOWBALL;
        stability.candidate = null;
        stability.consecutiveTicks = 0;
      }
    }

    const elapsed = Date.now() - loopStart;
    await ns.sleep(Math.max(50, LOOP_INTERVAL_MS - elapsed));
  }
}
