import { NS } from '@ns';
/**
 * Use BFS to discover all servers
 * @param {NS} ns 
 * @param {string} fromServer - Server to start from
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
    return Array.from((findAllPaths(ns, fromServer)).keys());
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


/**
 * Format RAM to human-readable string
 */
export function formatRam(ram: number): string {
    const units = ['GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    let unit = units[0];
    for (let i = 0; i < units.length; i++) {
        if (ram >= Math.pow(1024, i + 1)) {
            unit = units[i];
        }
    }
    return `${(ram / Math.pow(1024, units.indexOf(unit))).toFixed(2)}${unit}`;
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
 * @param precise - Whether to show milliseconds (default: false)
 * @returns Formatted duration string in HH:MM:SS or HH:MM:SS:UUU format
 */
export function formatTime(ms: number, precise = false): string {
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((ms % (1000 * 60)) / 1000);
    const milliseconds = ms % 1000;
    const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    let msStr = '';
    if (precise) { msStr = `:${String(seconds).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`; }
    return `${timeStr}${msStr}`;
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
 * Get servers that can be hacked by the player based on hacking level
 * @param {NS} ns - Netscript API
 * @param {string[]} servers - List of servers to filter
 * @returns {string[]} List of hackable servers sorted by hacking level
 */
export function getHackableServers(ns: NS, servers?: string[]): string[] {
    const serverList = servers || findAllServers(ns);
    const hackLevel = ns.getHackingLevel();
    const purchasedServers = ns.getPurchasedServers();

    // Filter servers that can be hacked
    const hackableServers = [];
    const serverLevels = new Map(); // Store hacking levels to avoid duplicate calls during sorting

    for (const server of serverList) {
        // Skip purchased servers and home
        if (server === 'home' || purchasedServers.includes(server)) {
            continue;
        }

        // Only include rooted servers with money that we can hack
        const requiredLevel = ns.getServerRequiredHackingLevel(server);
        const maxMoney = ns.getServerMaxMoney(server);
        const hasRootAccess = ns.hasRootAccess(server);

        // Store the required level for sorting later
        serverLevels.set(server, requiredLevel);

        if (hasRootAccess && maxMoney > 0 && requiredLevel <= hackLevel) {
            hackableServers.push(server);
        }
    }

    // Sort by required hacking level (ascending) using the cached levels
    return hackableServers.sort((a, b) => serverLevels.get(a) - serverLevels.get(b));
}


/**
 * Calculate the value of a server for targeting purposes
 * @param {NS} ns - The Netscript API
 * @param {string} target - Target server
 * @returns {number} Server value score
 */
export function calculateServerValue(ns: NS, target: string): number {
    const maxMoney = ns.getServerMaxMoney(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const hackChance = ns.hackAnalyzeChance(target);
    const hackTime = ns.getHackTime(target);

    // Calculate a balanced score based on multiple factors
    const moneyScore = maxMoney;
    const securityScore = 1 / (minSecurity + 1); // Lower security is better
    const timeScore = 1 / (hackTime / 1000 + 1); // Faster hack time is better
    const chanceScore = hackChance;

    // Combined score with weights
    const score = moneyScore * securityScore * timeScore * chanceScore;
    return score;
}

/**
 * Calculate threads needed for a weaken operation to reach min security
 * @param {NS} ns - Netscript API
 * @param {string} target - Target server
 * @param {number} securityDecrease - Amount of security decreased per thread
 * @returns {number} - Number of threads needed
 */
export function calculateWeakenThreads(ns: NS, target: string): number {
    const currentSecurity = ns.getServerSecurityLevel(target);
    const minSecurity = ns.getServerMinSecurityLevel(target);
    const securityDiff = Math.max(0, currentSecurity - minSecurity);
    return Math.ceil(securityDiff / ns.weakenAnalyze(1));
}


/**
 * Calculate threads needed for a grow operation to reach max money
 * @param {NS} ns - Netscript API
 * @param {string} target - Target server
 * @returns {number} - Number of threads needed
 */
export function calculateGrowThreads(ns: NS, target: string): number {
    const currentMoney = Math.max(1, ns.getServerMoneyAvailable(target));
    const maxMoney = ns.getServerMaxMoney(target);
    const growthFactor = maxMoney / currentMoney;
    return Math.ceil(ns.growthAnalyze(target, growthFactor));
}

/**
 * Calculate the number of threads needed to hack money from a server
 * 
 * @param {NS} ns - Netscript API
 * @param target - Target server name
 * @param hackFraction - Fraction of money to hack per thread
 * @returns Number of threads needed
 */
export function calculateHackThreads(ns: NS, target: string, hackFraction: number = 0.5): number {
    const hackPerThread = ns.hackAnalyze(target);
    return Math.max(1, Math.floor(hackFraction / hackPerThread));
}
