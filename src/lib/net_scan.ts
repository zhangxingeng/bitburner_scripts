import type { NS } from '@ns';

/**
 * NETWORK TOPOLOGY — pure `ns.scan()`-based discovery, deliberately isolated
 * from server-scoring/thread-math (lib/servers.ts). RAM cost accrues per
 * imported file, not per call site (docs/ram_evasion_rules.md §4) — anything
 * that pulls in lib/servers.ts inherits calculateServerValue's ~1.35 GB of
 * hack-formula calls (hackAnalyzeChance/getHackTime/getServerGrowth/…) even
 * if it only wants findAllServers/isSingleInstance. This file exists so pure
 * scan/discovery consumers pay only for ns.scan/ns.ps/ns.hasRootAccess/
 * ns.getServerMaxRam/ns.getServerUsedRam — no hack-formula tax.
 */

// ── Module-level cache (reset once per main loop tick via resetCaches()) ──────

let _serverListCache: string[] | null = null;

/**
 * Reset per-loop caches. Call once at the top of each main loop iteration
 * to ensure stale server lists are not reused across ticks.
 */
export function resetCaches(): void {
    _serverListCache = null;
}

// ── BFS network discovery (canonical) ──────────────────────────────────────────

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

// ── Botnet / available-server enumeration (cheap: only RAM getters) ───────────

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
