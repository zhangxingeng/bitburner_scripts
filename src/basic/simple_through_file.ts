import { NS } from '@ns';

// Type definitions for special value serialization
interface SpecialValue {
    $type: string;
    $value?: string | number | boolean | null;
}

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

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
    const funcName = command.replace(/^ns\./, '').split('(')[0];
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
                
                // Handle void/undefined results explicitly
                if (result === undefined) {
                    await ns.write("${outputFile}", "SUCCESS:VOID", "w");
                } else {
                    const serialized = JSON.stringify(result, jsonReplacer);
                    await ns.write("${outputFile}", serialized, "w");
                }
            } catch(err) {
                // Get RAM cost of the function and available RAM
                const ramCost = ns.getFunctionRamCost(\`${funcName}\`);
                const maxRam = ns.getServerMaxRam('home');
                const usedRam = ns.getServerUsedRam('home');
                const availableRam = maxRam - usedRam;
                
                // Print RAM info directly to terminal
                ns.tprint(\`RAM info: Function ${funcName} costs \${ramCost}GB. Available RAM: \${availableRam}GB\`);
                
                // Still write error to file so main script knows it failed
                await ns.write("${outputFile}", "ERROR: " + String(err), "w");
            }
        }
    `;
    await ns.write(scriptFile, script, 'w');
    const pid = ns.run(scriptFile);
    if (pid === 0) {
        ns.print(`ERROR: Failed to execute command: ${command}`);
        return undefined as unknown as T;
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
        ns.print(`ERROR: Command timed out: ${command}`);
        return undefined as unknown as T;
    }

    const fileContent = ns.read(outputFile);
    if (fileContent.startsWith('ERROR:')) {
        ns.print(`ERROR: Command execution failed: ${command}`);
        return undefined as unknown as T;
    }

    // Handle special case for void/undefined return values
    if (fileContent === 'SUCCESS:VOID') {
        return undefined as unknown as T;
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
        if (fileContent === 'SUCCESS:VOID') return undefined as unknown as T;
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
