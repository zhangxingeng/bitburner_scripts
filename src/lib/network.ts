import type { NS } from '@ns';

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

/** List every reachable server hostname. */
export function findAllServers(ns: NS, fromServer = 'home'): string[] {
    return Array.from(findAllPaths(ns, fromServer).keys());
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
