import { NS, SourceFileLvl } from '@ns';

/**
 * Use BFS to discover all servers
 * @param {NS} ns 
 * @returns {Generator<string[]>} All servers
 */
export function* scanNetwork(ns: NS, fromServer: string = 'home'): Generator<string[]> {
    const visited = new Set<string>();
    const queue: [string, string[]][] = [[fromServer, [fromServer]]];

    while (queue.length > 0) {
        const [current, path] = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        yield path; // found new, yield path
        for (const neighbor of ns.scan(current)) {
            if (!visited.has(neighbor)) {
                queue.push([neighbor, [...path, neighbor]]);
            }
        }
    }
}

/**
 * Use BFS to discover if a server exists
 * @param {NS} ns   
 * @param {string} server 
 * @returns {boolean} True if server exists, false otherwise
 */
export function serverExists(ns: NS, server: string): boolean {
    for (const path of scanNetwork(ns)) {
        if (path.at(-1) === server) return true;
    }
    return false;
}

/**
 * Use BFS to discover the path to a server
 * @param {NS} ns 
 * @param {string} fromServer 
 * @param {string} toServer 
 * @returns {string[]} Path to the server
 */
export function getServerPath(ns: NS, toServer: string, fromServer: string = 'home'): string[] {
    for (const path of scanNetwork(ns, fromServer)) {
        if (path.at(-1) === toServer) return path;
    }
    return [];
}

/**
 * Find all paths to all servers
 * @param {NS} ns - Netscript API
 * @param {string} fromServer - Server to start from
 * @returns {Map<string, string[]>} All paths to all servers
 */
export function findAllPaths(ns: NS, fromServer: string = 'home'): Map<string, string[]> {
    const routes = new Map<string, string[]>();
    for (const path of scanNetwork(ns, fromServer)) {
        routes.set(path.at(-1)!, path);
    }
    return routes;
}


/**
 * Use BFS to discover all servers
 * @param {NS} ns 
 * @param {string} fromServer - Server to start from
 * @returns {string[]} All servers
 */
export function findAllServers(ns: NS, fromServer: string = 'home'): string[] {
    return Array.from(findAllPaths(ns, fromServer).keys());
}

/**
 * Get all paths to servers that match a regex
 * @param {NS} ns - Netscript API
 * @param {Map<string, string[]>} pathCache - Cache of server paths if provided
 * @returns {Map<string, string[]>} Map of server paths
 */
export function getPaths(ns: NS, regex_str: string, pathCache: Map<string, string[]> | undefined = undefined): Map<string, string[]> {
    const serverPaths = pathCache ?? findAllPaths(ns);
    const matches = regexMatch(regex_str, Array.from(serverPaths.keys()));
    const paths = new Map<string, string[]>();
    for (const match of matches) {
        paths.set(match, serverPaths.get(match)!);
    }
    return paths;
}

export function traverse(ns: NS, path: string[]): boolean {
    if (ns.getHostname() !== path[0]) { throw new Error('invalid path'); }
    for (const server of path.slice(1)) {
        const connected = ns.singularity.connect(server);
        if (!connected) { throw new Error(`Failed to connect to ${server}`); }
    }
    return ns.getHostname() === path.at(-1);
}

/**
 * Match a regex against a list of strings
 * @param regex_str - Regex to match
 * @param strList - List of strings to match against
 * @returns List of strings that match the regex
     */
export function regexMatch(regex_str: string, strList: string[]): string[] {
    const regex = new RegExp(regex_str, 'i');
    return strList.filter(str => regex.test(str));
}


/**
 * Automatically connects to a target server
 * @param ns - Netscript API
 * @param target - Target server name
 * @throws Error if server is not found
 */
export const autoConnect = async (ns: NS, target: string): Promise<void> => {
    const path = findAllPaths(ns).get(target);
    if (!path) throw new Error('Server not found');
    // Connect through each server in the path
    for (const server of path.slice(1)) {
        await ns.singularity.connect(server);
    }
};


/**
 * Ensures only one instance of the script runs
 * @param {NS} ns - Netscript API
 * @returns {void}
 */
export function isSingleInstance(ns: NS, kill_other: boolean = false): boolean {
    const running_pids = ns.ps(ns.getHostname());
    const other_pids = running_pids.filter(s => s.filename === ns.getScriptName() && s.pid !== ns.pid);
    if (kill_other) {
        other_pids.forEach(s => ns.kill(s.pid));
        ns.tprint('All previous instances killed');
    }
    return other_pids.length === 0;
}

/**
 * Attempts to gain root access to a server
 * @param {NS} ns - Netscript API
 * @param {string} server - Target server
 * @returns {boolean} Boolean indicating rooted
 */
export function gainRootAccess(ns: NS, server: string): boolean {
    if (ns.hasRootAccess(server)) return true;
    const portOpeners = getAvailablePortOpeners(ns);
    for (const opener of portOpeners) {
        try { opener(server); } catch { continue; }
    }
    try { return ns.nuke(server); } catch { return false; }
}

/**
 * Get available port opener tools using a modular approach
 * @param {NS} ns - Netscript API
 * @returns {((server: string) => boolean)[]} Array of port opener functions
 */
export function getAvailablePortOpeners(ns: NS): ((server: string) => boolean)[] {
    const portOpenerMap: { [exeName: string]: (server: string) => boolean } = {
        'BruteSSH.exe': ns.brutessh,
        'FTPCrack.exe': ns.ftpcrack,
        'relaySMTP.exe': ns.relaysmtp,
        'HTTPWorm.exe': ns.httpworm,
        'SQLInject.exe': ns.sqlinject,
    };
    const openers: ((server: string) => boolean)[] = [];
    for (const [exeName, openerFn] of Object.entries(portOpenerMap)) {
        if (ns.fileExists(exeName, 'home')) {
            openers.push((server: string) => openerFn(server));
        }
    }
    return openers;
}

/**
 * Scans all servers and nukes them
 * @param {NS} ns - Netscript API
 * @returns {Set<string>} Set of nuked servers
 */
export function scanAndNuke(ns: NS): Set<string> {
    const servers = findAllServers(ns);
    const nukedServers = new Set<string>();
    for (const server of servers) {
        if (gainRootAccess(ns, server)) {
            nukedServers.add(server);
        }
    }
    ns.print(`Nuked ${nukedServers.size} servers`);
    return nukedServers;
}

/**
 * Calculate a score for each server based on money, growth, security
 * @param {NS} ns - Netscript API
 * @param {string} server - Server to calculate score for
 * @returns {number} Score for the server
 */
export function calculateServerScore(ns: NS, server: string): number {
    // Calculate a score for each server based on money, growth, security
    const maxMoney = ns.getServerMaxMoney(server);
    const minSecurity = ns.getServerMinSecurityLevel(server);
    const growthRate = ns.getServerGrowth(server);
    // Calculate hack time at min security (faster hacks are better)
    const hackTime = ns.getHackTime(server);
    // Calculate score: money * growth / (security * hackTime)
    const score = (maxMoney * growthRate) / (minSecurity * hackTime);
    return score;
}

/**
 * Formats RAM amount for display
 * @param ram - RAM amount in GB
 * @returns Formatted RAM string
 */
export function formatRam(ram: number): string {
    if (ram >= 1024) {
        return `${(ram / 1024).toFixed(2)}TB`;
    }
    return `${ram.toFixed(2)}GB`;
}

/**
 * Formats money amount for display
 * @param {number} money - Money amount
 * @returns {string} Formatted money string
 */
export function formatMoney(money: number): string {
    const symbol = money < 0 ? '-$' : '$';
    const numStr = shortNumber(Math.abs(money));
    return `${symbol}${numStr}`;
}

/**
 * Format a number with a shortened representation
 * @param n - Number to format
 * @param sci - Use scientific notation if true, accounting notation if false
 * @returns Formatted string representation
 */
export function shortNumber(n: number, sci: boolean = false): string {
    if (n === 0) return '0';

    const neg = n < 0 ? '-' : '';
    const absN = Math.abs(n);

    if (sci) {
        // Scientific notation format
        const exp = Math.floor(Math.log10(absN));
        const coefficient = n / Math.pow(10, exp);
        return `${coefficient.toFixed(3)}e${exp}`.replace(/\.?0+e/, 'e');
    } else {
        // Accounting notation format with fallback to scientific
        const units = ['', 'K', 'M', 'B', 'T', 'Q', 'H', 'Z', 'Y'];
        const exp = Math.floor(Math.log10(absN) / 3);

        if (exp < units.length) {
            // Use standard units
            const unit = units[exp];
            const value = n / Math.pow(1000, exp);

            // Format with commas and 2 decimal places
            return `${neg}${value.toLocaleString('en-US', {
                maximumFractionDigits: 2,
                minimumFractionDigits: 2
            })}${unit}`;
        } else {
            // Fallback to scientific notation
            const sciExp = Math.floor(Math.log10(absN));
            const coefficient = n / Math.pow(10, sciExp);
            return `${coefficient.toFixed(3)}e${sciExp}`.replace(/\.?0+e/, 'e');
        }
    }
}

/**
 * Format a percentage value
 * @param n - Number to format (0-1)
 * @returns Formatted percentage string
 */
export function formatPercent(n: number): string {
    if (n === 0) return '';

    const clamped = Math.min(Math.max(n, -0.99999), 0.99999);
    const pct = (clamped * 100).toFixed(1) + '%';

    return pct.padStart('-999.9%'.length, ' ');
}

/**
 * Format a duration in milliseconds to a readable string
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatTime(ms: number): string {
    const hours = ms / (1000 * 60 * 60);
    if (hours > 2) {
        return `${hours.toFixed(1)} hr`;
    }
    return `${(ms / (1000 * 60)).toFixed(1)} min`;
}

/**
 * Pad a string to a specific length
 * @param str - String to pad
 * @param len - Target length
 * @returns Padded string
 */
export function pad(str: string | number | undefined, len: number): string {
    const s = str?.toString() || ' ';
    return `| ${s.padEnd(len, ' ')}`;
}
/**
 * Pad a number to a specific length with leading zeros
 * @param {number} num - Number to pad
 * @param {number} len - Target length
 * @returns {string} Padded number
 */
export function padNum(num: number, len: number): string {
    const s = num.toString();
    return s.padStart(len, '0');
}

/**
 * Wait until the player has a specific amount of money
 * @param ns - Netscript API
 * @param targetAmount - Target money amount
 */
export async function awaitMoney(ns: NS, targetAmount: number): Promise<void> {
    const start = performance.now();
    ns.scriptKill('money.js', 'home');
    ns.run('money.js', 1, targetAmount);

    while (ns.getPlayer().money < targetAmount) {
        const remaining = targetAmount - ns.getPlayer().money;
        ns.print(`Waiting for $${shortNumber(remaining)} more money... (${formatTime(performance.now() - start)} elapsed)`);
        await ns.sleep(15000);
    }
}

/**
 * Copies scripts to target servers
 * @param {NS} ns - Netscript API
 * @param {string[]} scripts - Array of script names to copy
 * @param {string} fromServer - Source server
 * @param {string[]} targetList - Array of target servers
 * @returns {boolean} True if all scripts were copied successfully, false otherwise
 */
export function copyScripts(ns: NS, scripts: string[], fromServer: string, targetList: string[]): boolean {
    // first check if all scripts exist on fromServer
    const missingScripts = scripts.filter(script => !ns.fileExists(script, fromServer));
    if (missingScripts.length > 0) {
        throw new Error(`Missing scripts on ${fromServer}: ${missingScripts.join(', ')}`);
    }
    for (const target of targetList) {
        if (ns.getServerMaxRam(target) < 2) { return false; }
        const copyResult = ns.scp(scripts, target, fromServer);
        if (!copyResult) {
            throw new Error(`Failed to copy ${scripts.join(', ')} to ${target} from ${fromServer}`);
        }
    }
    return true;
}

export function checkOwnSF(ns: NS, number: number, lvl: number = 0): boolean {
    const sourceFiles = ns.singularity.getOwnedSourceFiles();
    return sourceFiles.some((sf: SourceFileLvl) => sf.n === number && sf.lvl >= lvl);
}

export function prettyDisplay(ns: NS, lines: string[]): void {
    const max_lines = 20;
    if (lines.length > max_lines) { lines = lines.slice(0, max_lines); }
    const padding_lines = max_lines - lines.length;
    for (let i = 0; i < padding_lines; i++) { ns.print('\n'); }
    for (const line of lines) { ns.print(line); }
}

