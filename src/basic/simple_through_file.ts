import { NS, ProcessInfo, Player } from '@ns';

// Type definitions for special value serialization
interface SpecialValue {
    $type: string;
    $value?: string | number | boolean | null;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

type SerializedValue = JsonValue | SpecialValue;

/**
 * Custom JSON replacer to handle special JavaScript values
 */
function jsonReplacer(key: string, value: unknown): SerializedValue {
    if (value === undefined) return { $type: 'undefined' };
    if (value === Infinity) return { $type: 'number', $value: 'Infinity' };
    if (value === -Infinity) return { $type: 'number', $value: '-Infinity' };
    if (Number.isNaN(value)) return { $type: 'number', $value: 'NaN' };
    return value as SerializedValue;
}

/**
 * Custom JSON reviver to restore special JavaScript values
 */
function jsonReviver(key: string, value: unknown): unknown {
    if (value && typeof value === 'object') {
        const specialValue = value as SpecialValue;
        if (specialValue.$type) {
            if (specialValue.$type === 'undefined') return undefined;
            if (specialValue.$type === 'number') {
                if (specialValue.$value === 'Infinity') return Infinity;
                if (specialValue.$value === '-Infinity') return -Infinity;
                if (specialValue.$value === 'NaN') return NaN;
            }
        }
    }
    return value;
}

/**
 * Execute an NS command by running it in a temp script and getting the result
 * @param {NS} ns - The NS instance
 * @param {string} command - The NS command to execute (e.g. "ns.getServerMaxRam('home')")
 * @returns {Promise<T>} Result of the command
 */
export async function executeCommand<T>(ns: NS, command: string): Promise<T> {
    const outputFile = `/tmp/${Date.now()}.txt`;
    const scriptFile = `/tmp/${Date.now()}.js`;
    const script = `
        export async function main(ns) {
            try {
                // Define custom JSON replacer function within the script
                function jsonReplacer(key, value) {
                    if (value === undefined) return { $type: 'undefined' };
                    if (value === Infinity) return { $type: 'number', $value: 'Infinity' };
                    if (value === -Infinity) return { $type: 'number', $value: '-Infinity' };
                    if (Number.isNaN(value)) return { $type: 'number', $value: 'NaN' };
                    return value;
                }
                
                const result = ${command};
                const serialized = JSON.stringify(result, jsonReplacer);
                await ns.write("${outputFile}", serialized, "w");
            } catch(err) {
                await ns.write("${outputFile}", "ERROR: " + String(err), "w");
            }
        }
    `;
    await ns.write(scriptFile, script, 'w');
    const pid = ns.run(scriptFile);
    if (pid === 0) {
        throw new Error(`Failed to execute command: ${command}`);
    }

    // Wait for the script to complete with better timeout handling
    let completed = false;
    for (let i = 0; i < 50; i++) {
        if (!ns.isRunning(pid)) {
            completed = true;
            break;
        }
        await ns.sleep(100);
    }

    if (!completed) {
        throw new Error(`Command timed out: ${command}`);
    }

    const fileContent = ns.read(outputFile);
    if (fileContent.startsWith('ERROR:')) {
        throw new Error(`Command execution failed: ${fileContent}`);
    }

    // Clean up temp files
    ns.rm(scriptFile);
    ns.rm(outputFile);

    return parseToType<T>(fileContent);
}

/**
 * Parses a string back into its original type
 * @param {string} fileContent - The string to parse
 * @returns {T} The parsed object
 */
function parseToType<T>(fileContent: string): T {
    if (!fileContent) return undefined as unknown as T;

    try {
        // Handle primitive values specially for simple cases
        if (fileContent === 'undefined') return undefined as unknown as T;
        if (fileContent === 'null') return null as unknown as T;
        if (fileContent === 'true') return true as unknown as T;
        if (fileContent === 'false') return false as unknown as T;
        if (fileContent === 'NaN') return NaN as unknown as T;
        if (fileContent === 'Infinity') return Infinity as unknown as T;
        if (fileContent === '-Infinity') return -Infinity as unknown as T;

        // Try to parse as JSON with custom reviver for complex objects
        return JSON.parse(fileContent, jsonReviver) as T;
    } catch (err) {
        // If parsing as JSON fails, handle as primitive
        if (!isNaN(Number(fileContent))) {
            return Number(fileContent) as unknown as T;
        }

        // Last resort, return as string
        return fileContent as unknown as T;
    }
}

/**
 * Converts an object to string representation
 * @param {T} obj - The object to convert
 * @returns {string} String representation of the object
 */
function objectToString<T>(obj: T): string {
    if (obj === undefined) return 'undefined';
    if (obj === null) return 'null';
    if (Number.isNaN(obj)) return 'NaN';
    if (obj === Infinity) return 'Infinity';
    if (obj === -Infinity) return '-Infinity';

    // For arrays and objects, use JSON.stringify with custom replacer
    if (typeof obj === 'object') {
        try {
            return JSON.stringify(obj, jsonReplacer);
        } catch (e) {
            // Fall back to toString if JSON.stringify fails
            return String(obj);
        }
    }

    // For primitive types
    return String(obj);
}

/**
 * Scan for connected servers
 * @param {NS} ns - The NS instance
 * @param {string} server - Server to scan from
 * @returns {Promise<string[]>} Connected servers
 */
export async function scan(ns: NS, server?: string): Promise<string[]> {
    const cmd = server ? `ns.scan("${server}")` : 'ns.scan()';
    return await executeCommand<string[]>(ns, cmd);
}

/**
 * Get the list of purchased servers
 * @param {NS} ns - The NS instance
 * @returns {Promise<string[]>} List of purchased servers
 */
export async function getPurchasedServers(ns: NS): Promise<string[]> {
    return await executeCommand<string[]>(ns, 'ns.getPurchasedServers()');
}

/**
 * Get the process list for a server
 * @param {NS} ns - The NS instance
 * @param {string} hostname - Server name
 * @returns {Promise<ProcessInfo[]>} Process list
 */
export async function getProcessList(ns: NS, hostname: string): Promise<ProcessInfo[]> {
    return await executeCommand<ProcessInfo[]>(ns, `ns.ps("${hostname}")`);
}

/**
 * Get server free RAM
 * @param {NS} ns - The NS instance
 * @param {string} server - Server name
 * @returns {Promise<number>} Server free RAM
 */
export async function getServerFreeRam(ns: NS, server: string): Promise<number> {
    const maxRam = await executeCommand<number>(ns, `ns.getServerMaxRam("${server}")`);
    const usedRam = await executeCommand<number>(ns, `ns.getServerUsedRam("${server}")`);
    return maxRam - usedRam;
}

/**
 * Get player information
 * @param {NS} ns - The NS instance
 * @returns {Promise<Player>} Player information
 */
export async function getPlayer(ns: NS): Promise<Player> {
    return await executeCommand<Player>(ns, 'ns.getPlayer()');
}

// Interface for test object with special values
interface TestObject {
    normal: number;
    inf: number;
    neginf: number;
    nan: number;
    undef: undefined;
    nested: {
        inf: number;
        nan: number;
    };
    arr: (number | undefined)[];
}

export async function main(ns: NS): Promise<void> {
    // test out all common function to make sure the algo works seamlessly
    const maxRam = await executeCommand<number>(ns, 'ns.getServerMaxRam("home")');
    ns.tprint(`new: ${maxRam} original ${ns.getServerMaxRam('home')}`);

    const purchasedServers = await getPurchasedServers(ns);
    ns.tprint(`new: ${JSON.stringify(purchasedServers)} original ${JSON.stringify(ns.getPurchasedServers())}`);

    const processList = await getProcessList(ns, 'home');
    ns.tprint(`new: ${JSON.stringify(processList)} original ${JSON.stringify(ns.ps('home'))}`);

    const serverFreeRam = await executeCommand<number>(ns, 'ns.getServerUsedRam("home")');
    ns.tprint(`new: ${serverFreeRam} original ${ns.getServerUsedRam('home')}`);

    const player = await executeCommand<Player>(ns, 'ns.getPlayer()');
    ns.tprint(`new: ${JSON.stringify(player)} original ${JSON.stringify(ns.getPlayer())}`);

    // Test special values in nested objects
    const testObj = await executeCommand<TestObject>(ns, `
        {
            normal: 123,
            inf: Infinity,
            neginf: -Infinity,
            nan: NaN,
            undef: undefined,
            nested: { 
                inf: Infinity, 
                nan: NaN 
            },
            arr: [1, Infinity, NaN, undefined]
        }
    `);
    ns.tprint(`Special values test: ${JSON.stringify(testObj, jsonReplacer)}`);
}