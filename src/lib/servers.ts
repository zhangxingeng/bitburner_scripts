import type { NS } from '@ns';

// ── Module-level cache (reset once per main loop tick via resetCaches()) ──────

let _serverListCache: string[] | null = null;

/**
 * Reset per-loop caches. Call once at the top of each main loop iteration
 * to ensure stale server lists are not reused across ticks.
 */
export function resetCaches(): void {
    _serverListCache = null;
}

// ── BFS network discovery (canonical — from lib/network.ts) ──────────────────

/** BFS scan yielding each discovered path. Single source of truth for network traversal. */
export function* scanNetwork(ns: NS, fromServer = 'home'): Generator<string[]> {
    const visited = new Set<string>();
    const queue: [string, string[]][] = [[fromServer, [fromServer]]];

    while (queue.length > 0) {
        const [current, path] = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        yield path;
        for (const neighbor of ns.scan(current)) {
            if (!visited.has(neighbor)) {
                queue.push([neighbor, [...path, neighbor]]);
            }
        }
    }
}

/** Match a regex against a list of strings (case-insensitive). */
export function regexMatch(regexStr: string, strList: string[]): string[] {
    const regex = new RegExp(regexStr, 'i');
    return strList.filter(str => regex.test(str));
}

/** Check whether a server exists on the network. */
export function serverExists(ns: NS, server: string): boolean {
    for (const path of scanNetwork(ns)) {
        if (path.at(-1) === server) return true;
    }
    return false;
}

/** Get the BFS path to a server. Returns empty array if not found. */
export function getServerPath(ns: NS, toServer: string, fromServer = 'home'): string[] {
    for (const path of scanNetwork(ns, fromServer)) {
        if (path.at(-1) === toServer) return path;
    }
    return [];
}

/** Build a map of server → path for every reachable server. */
export function findAllPaths(ns: NS, fromServer = 'home'): Map<string, string[]> {
    const routes = new Map<string, string[]>();
    for (const path of scanNetwork(ns, fromServer)) {
        routes.set(path.at(-1)!, path);
    }
    return routes;
}

/**
 * List every reachable server hostname.
 * Results from the default (home) origin are cached per loop tick — call
 * resetCaches() at the top of each iteration.
 */
export function findAllServers(ns: NS, fromServer = 'home'): string[] {
    if (fromServer === 'home' && _serverListCache !== null) return _serverListCache;
    const result = Array.from(findAllPaths(ns, fromServer).keys());
    if (fromServer === 'home') _serverListCache = result;
    return result;
}

/** Get paths for servers matching a regex. Accepts an optional path cache. */
export function getPaths(
    ns: NS,
    regexStr: string,
    pathCache?: Map<string, string[]>,
): Map<string, string[]> {
    const serverPaths = pathCache ?? findAllPaths(ns);
    const matches = regexMatch(regexStr, Array.from(serverPaths.keys()));
    const paths = new Map<string, string[]>();
    for (const match of matches) {
        paths.set(match, serverPaths.get(match)!);
    }
    return paths;
}

/** Ensure only one instance of the calling script is running on this host. */
export function isSingleInstance(ns: NS): boolean {
    const running = ns.ps(ns.getHostname());
    const scriptName = ns.getScriptName();
    const currentPid = ns.pid;
    return !running.some(p => p.filename === scriptName && p.pid !== currentPid);
}

// ── Server scoring and thread calculations (from lib/server.ts) ──────────────

/** Score a server's value as a hack target. Higher = better. */
export function calculateServerValue(ns: NS, target: string): number {
    const maxMoney = ns.getServerMaxMoney(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const hackChance = ns.hackAnalyzeChance(target);
    const hackTime = ns.getHackTime(target);
    const growthFactor = ns.getServerGrowth(target);

    // Combined score with weights; lower security and faster hack time are better
    const moneyScore = maxMoney;
    const securityScore = 1 / (minSecurity + 1);
    const timeScore = 1 / (hackTime / 1000 + 1);
    const chanceScore = hackChance;
    const growthScore = growthFactor / 100;

    return moneyScore * securityScore * timeScore * chanceScore * growthScore;
}

/** Threads needed to weaken a server to its minimum security level. */
export function calculateWeakenThreads(ns: NS, target: string): number {
    const currentSecurity = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const securityDiff = Math.max(0, currentSecurity - minSecurity);
    return Math.ceil(securityDiff / ns.weakenAnalyze(1));
}

/** Threads needed to grow a server from current money to max money. */
export function calculateGrowThreads(ns: NS, target: string): number {
    const currentMoney = Math.max(1, ns.getServerMoneyAvailable(target));
    const maxMoney = ns.getServerMaxMoney(target);
    return Math.ceil(ns.growthAnalyze(target, maxMoney / currentMoney));
}

/** Threads needed to hack a given fraction of a server's money (default 50%). */
export function calculateHackThreads(ns: NS, target: string, hackFraction = 0.5): number {
    const hackPerThread = ns.hackAnalyze(target);
    return Math.max(1, Math.floor(hackFraction / hackPerThread));
}

/** Filter to servers the player can hack right now, sorted by required level ascending. */
export function getHackableServers(ns: NS, servers?: string[]): string[] {
    const serverList = servers ?? findAllServers(ns);
    const hackLevel = ns.getHackingLevel();
    const purchased = ns.cloud.getServerNames();
    const levels = new Map<string, number>();

    const hackable: string[] = [];
    for (const server of serverList) {
        if (server === 'home' || purchased.includes(server)) continue;
        const level = ns.getServerRequiredHackingLevel(server);
        levels.set(server, level);
        if (ns.hasRootAccess(server) && ns.getServerMaxMoney(server) > 0 && level <= hackLevel) {
            hackable.push(server);
        }
    }
    return hackable.sort((a, b) => levels.get(a)! - levels.get(b)!);
}

// ── Botnet / available-server enumeration (consolidated from engine/batch_util.ts) ──

/**
 * Get rooted servers that can run scripts, along with their available RAM.
 *
 * @param ns             NetScript API
 * @param minServerRam   Minimum server RAM (GB) required to be included
 * @param useHomeRam     Whether to include home in the worker pool
 * @param homeRamReserve GB to keep free on home (not allocated to workers)
 * @returns servers, available RAM per server, and available thread slots (at 1.75 GB/thread)
 */
export function getAvailableServers(
    ns: NS,
    minServerRam = 2,
    useHomeRam = true,
    homeRamReserve = 100,
): { servers: string[]; rams: number[]; allocs: number[] } {
    const allServers = findAllServers(ns);
    const availableServers = allServers.filter(server => {
        if (!ns.hasRootAccess(server)) return false;
        if (ns.getServerMaxRam(server) < minServerRam) return false;

        if (server === 'home') {
            if (!useHomeRam) return false;
            const maxRam = ns.getServerMaxRam(server);
            const usedRam = ns.getServerUsedRam(server);
            return (maxRam - usedRam - homeRamReserve) > minServerRam;
        }

        return true;
    });

    const availableRams = availableServers.map(server => {
        if (server === 'home') {
            return Math.max(0, ns.getServerMaxRam(server) - ns.getServerUsedRam(server) - homeRamReserve);
        }
        return ns.getServerMaxRam(server) - ns.getServerUsedRam(server);
    });

    const scriptBaseCost = 1.75; // base RAM cost per worker thread
    const availableAllocs = availableRams.map(ram => Math.floor(ram / scriptBaseCost));

    return { servers: availableServers, rams: availableRams, allocs: availableAllocs };
}
