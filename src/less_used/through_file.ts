import { NS } from '@ns';
import { formatRam, formatTime } from '../lib/util_low_ram';

// Type definitions
type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [key: string]: JsonValue };
type JsonArray = JsonValue[];

// Custom JSON types for special values
type MapEntry = [unknown, unknown];
type SerializedSpecialValue = {
    $type: 'number' | 'bigint' | 'Map' | 'Set';
    $value: string | unknown[] | MapEntry[];
};
type SerializedValue = JsonValue | SerializedSpecialValue;

// More specific type definitions
type RunFunction = (script: string, options: RunOptions, ...args: (string | number | boolean)[]) => number;
type IsAliveFunction = (pid: number) => Promise<boolean>;
type ErrorContext = string | ((result: unknown) => string | Promise<string>);
type ToastStyle = '' | 'success' | 'warning' | 'error' | 'info';

interface RunOptions {
    temporary?: boolean;
}

/**
 * Ensures a valid NS instance is provided
 * @param {NS} ns - The NS instance
 * @param {string} fnName - Function name for error message
 * @returns {NS} The validated NS instance
 */
export function checkNsInstance(ns: NS, fnName = 'this function'): NS {
    if (ns === undefined || !ns.print) {
        throw new Error(`The first argument to function ${fnName} should be a 'ns' instance.`);
    }
    return ns;
}

/**
 * Disables logs for specified log types
 * @param {NS} ns - The NS instance
 * @param {string[]} logTypes - Log types to disable
 */
export function disableLogs(ns: NS, logTypes: string[]): void {
    ['disableLog'].concat(...logTypes).forEach(log => checkNsInstance(ns, '"disableLogs"').disableLog(log));
}

/**
 * Convert a command name to a default file path
 * @param {string} command - Command to convert
 * @param {string} ext - File extension
 * @returns {string} Default file path
 */
function getDefaultCommandFileName(command: string, ext = '.txt'): string {
    // If prefixed with "ns.", strip that out
    let fname = command;
    if (fname.startsWith('await ')) fname = fname.slice(6);
    if (fname.startsWith('ns.')) fname = fname.slice(3);
    // Remove anything between parentheses
    fname = fname.replace(/ *\([^)]*\) */g, '');
    // Replace any dereferencing (dots) with dashes
    fname = fname.replace('.', '-');
    return `/Temp/${fname}${ext}`;
}

/**
 * Joins path components
 * @param {string[]} args - Path components
 * @returns {string} Joined path
 */
export function pathJoin(...args: string[]): string {
    return args.filter(s => !!s).join('/').replace(/\/\/+/g, '/');
}

/**
 * Gets file path taking into account optional subfolder relocation
 * @param {string} file - File path
 * @returns {string} Full file path
 */
export function getFilePath(file: string): string {
    const subfolder = '';  // git-pull.js optionally modifies this when downloading
    return pathJoin(subfolder, file);
}

// Cache for exported functions
const _cachedExports: string[] = [];

/**
 * Get all exported functions from helpers.js
 * @param {NS} ns - The NS instance
 * @returns {string[]} List of exported function names
 */
function getExports(ns: NS): string[] {
    if (_cachedExports.length > 0) return _cachedExports;
    const scriptHelpersRows = ns.read(getFilePath('helpers.js')).split('\n');
    for (const row of scriptHelpersRows) {
        if (!row.startsWith('export')) continue;
        const funcNameStart = row.indexOf('function') + 'function'.length + 1;
        const funcNameEnd = row.indexOf('(', funcNameStart);
        _cachedExports.push(row.substring(funcNameStart, funcNameEnd));
    }
    return _cachedExports;
}

/**
 * Allows serialization of special types not supported by JSON
 * @param {string} key - The key
 * @param {unknown} val - The value
 * @returns {SerializedValue} Serialized value
 */
export function jsonReplacer(key: string, val: unknown): SerializedValue {
    if (val === Infinity)
        return { $type: 'number', $value: 'Infinity' };
    if (val === -Infinity)
        return { $type: 'number', $value: '-Infinity' };
    if (Number.isNaN(val))
        return { $type: 'number', $value: 'NaN' };
    if (typeof val === 'bigint')
        return { $type: 'bigint', $value: val.toString() };
    if (val instanceof Map) {
        // Create an array of [key, value] pairs
        const entries: MapEntry[] = Array.from(val.entries());
        return { $type: 'Map', $value: entries };
    }
    if (val instanceof Set)
        return { $type: 'Set', $value: [...val] };
    return val as SerializedValue;
}

/**
 * Deserializes special values created by jsonReplacer
 * @param {string} key - The key
 * @param {unknown} val - The value
 * @returns {unknown} Deserialized value
 */
export function jsonReviver(key: string, val: unknown): unknown {
    if (val == null || typeof val !== 'object' || (val as { $type?: string }).$type == null)
        return val;

    const typedVal = val as SerializedSpecialValue;

    if (typedVal.$type === 'number')
        return Number.parseFloat(typedVal.$value as string);
    if (typedVal.$type === 'bigint')
        return BigInt(typedVal.$value as string);
    if (typedVal.$type === 'Map') {
        // Cast to array of MapEntry to satisfy TypeScript
        const entries = typedVal.$value as MapEntry[];
        return new Map(entries);
    }
    if (typedVal.$type === 'Set') {
        return new Set(typedVal.$value as unknown[]);
    }

    return val;
}

/**
 * Converts error to Error object if it's not already
 * @param {unknown} error - The error
 * @returns {Error} Error object
 */
function asError(error: unknown): Error {
    return error instanceof Error ? error :
        new Error(typeof error === 'string' ? error :
            JSON.stringify(error, jsonReplacer));
}

/**
 * Extract error information from an error
 * @param {Error|string|unknown} err - Error object or string
 * @returns {string} Error information
 */
export function getErrorInfo(err: Error | string | unknown): string {
    if (err === undefined || err == null) return '(null error)';
    if (typeof err === 'string') return err;

    let strErr: string | null = null;

    if (err instanceof Error) {
        if (err.stack)
            strErr = '  ' + err.stack.split('\n')
                .filter(s => !s.includes('bitburner-official'))
                .join('\n    ');
        if (err.cause)
            strErr = (strErr ? strErr + '\n' : '') + getErrorInfo(err.cause);
    }

    const typedErr = err as { toString?: () => string; stack?: string; constructor: { name: string } };

    const defaultToString = typedErr.toString === undefined ? null : typedErr.toString();
    if (defaultToString && defaultToString != '[object Object]') {
        if (!strErr)
            strErr = defaultToString;
        else if (!typedErr.stack || !typedErr.stack.includes(defaultToString))
            strErr = `${defaultToString}\n  ${strErr}`;
    }

    if (strErr) return strErr.trimEnd();

    const typeName = typeof err === 'object'
        ? `object (${typedErr.constructor.name})`
        : typeof err;

    return `non-Error type thrown: ${typeName}` +
        ' { ' + Object.keys(typedErr as object).map(key => `${key}: ${(typedErr as Record<string, unknown>)[key]}`).join(', ') + ' }';
}

/**
 * Log message to script, terminal, and/or toast
 * @param {NS} ns - The NS instance
 * @param {string} message - Message to log
 * @param {boolean} alsoPrintToTerminal - Whether to print to terminal
 * @param {ToastStyle} toastStyle - Toast style if showing toast
 * @param {number} maxToastLength - Maximum toast length
 * @returns {string} The logged message
 */
export function log(
    ns: NS,
    message = '',
    alsoPrintToTerminal = false,
    toastStyle: ToastStyle = '',
    maxToastLength = Number.MAX_SAFE_INTEGER
): string {
    checkNsInstance(ns, '"log"');
    ns.print(message);

    if (toastStyle) {
        ns.toast(
            message.length <= maxToastLength
                ? message
                : message.substring(0, maxToastLength - 3) + '...',
            toastStyle as 'success' | 'warning' | 'error' | 'info'
        );
    }

    if (alsoPrintToTerminal) {
        ns.tprint(message);
    }

    return message;
}

/**
 * Retry a function until success or max retries reached
 * @param {NS} ns - The NS instance
 * @param {Function} fnFunctionThatMayFail - Function to retry
 * @param {Function} fnSuccessCondition - Success condition
 * @param {ErrorContext} errorContext - Error context
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} initialRetryDelayMs - Initial retry delay
 * @param {number} backoffRate - Backoff rate
 * @param {boolean} verbose - Whether to be verbose
 * @param {boolean} tprintFatalErrors - Whether to print fatal errors
 * @param {boolean} silent - Whether to be silent
 * @returns {Promise<unknown>} Result of the function
 */
export async function autoRetry(
    ns: NS,
    fnFunctionThatMayFail: () => unknown | Promise<unknown>,
    fnSuccessCondition: (result: unknown) => boolean | Promise<boolean>,
    errorContext: ErrorContext = 'Success condition not met',
    maxRetries = 5,
    initialRetryDelayMs = 50,
    backoffRate = 3,
    verbose = false,
    tprintFatalErrors = true,
    silent = false
): Promise<unknown> {
    // Set default values for null/undefined arguments
    if (errorContext == null) errorContext = 'Success condition not met';
    if (maxRetries == null) maxRetries = 5;
    if (initialRetryDelayMs == null) initialRetryDelayMs = 50;
    if (backoffRate == null) backoffRate = 3;
    if (verbose == null) verbose = false;
    if (tprintFatalErrors == null) tprintFatalErrors = true;
    if (silent == null) silent = false;

    checkNsInstance(ns, '"autoRetry"');
    let retryDelayMs = initialRetryDelayMs;
    let attempts = 0;
    let successConditionMet: boolean | Promise<boolean>;

    while (attempts++ <= maxRetries) {
        // Sleep between attempts
        if (attempts > 1) {
            await ns.sleep(retryDelayMs);
            retryDelayMs *= backoffRate;
        }

        try {
            successConditionMet = true;
            const result = await fnFunctionThatMayFail();

            // Check if this is considered a successful result
            successConditionMet = fnSuccessCondition(result);
            if (successConditionMet instanceof Promise)
                successConditionMet = await successConditionMet;

            if (!successConditionMet) {
                // If we have not yet reached max retries, continue
                if (attempts < maxRetries) {
                    if (!silent) {
                        log(
                            ns,
                            `INFO: Attempt ${attempts} of ${maxRetries} failed. Trying again in ${retryDelayMs}ms...`,
                            false,
                            !verbose ? '' : 'info'
                        );
                    }
                    continue;
                }

                // Otherwise, throw an error
                let errorMessage = typeof errorContext === 'string'
                    ? errorContext
                    : errorContext(result);

                if (errorMessage instanceof Promise)
                    errorMessage = await errorMessage;

                throw asError(errorMessage);
            }

            return result;
        }
        catch (error) {
            const fatal = attempts >= maxRetries;
            if (!silent) {
                log(
                    ns,
                    `${fatal ? 'FAIL' : 'INFO'}: Attempt ${attempts} of ${maxRetries} raised an error` +
                    (fatal ? `: ${getErrorInfo(error)}` : `. Trying again in ${retryDelayMs}ms...`),
                    tprintFatalErrors && fatal,
                    !verbose ? '' : (fatal ? 'error' : 'info')
                );
            }

            if (fatal) throw asError(error);
        }
    }

    throw new Error('Unexpected return from autoRetry');
}

/**
 * Wait for a process to complete
 * @param {NS} ns - The NS instance
 * @param {IsAliveFunction} fnIsAlive - Function to check if process is alive
 * @param {number} pid - Process ID
 * @param {boolean} verbose - Whether to be verbose
 */
export async function waitForProcessToComplete(
    ns: NS,
    fnIsAlive: IsAliveFunction,
    pid: number,
    verbose = false
): Promise<void> {
    checkNsInstance(ns, '"waitForProcessToComplete"');
    if (!verbose) disableLogs(ns, ['sleep']);

    // Wait for the PID to stop running
    const start = Date.now();
    let sleepMs = 1;
    let done = false;

    for (let retries = 0; retries < 1000; retries++) {
        if (!(await fnIsAlive(pid))) {
            done = true;
            break; // Script is done running
        }

        if (verbose && retries % 100 === 0) {
            ns.print(`Waiting for pid ${pid} to complete... (${formatTime(Date.now() - start)})`);
        }

        await ns.sleep(sleepMs);
        sleepMs = Math.min(sleepMs * 2, 200);
    }

    // Make sure that the process has shut down
    if (!done) {
        const errorMessage = `run-command pid ${pid} is running much longer than expected. Max retries exceeded.`;
        ns.print(errorMessage);
        throw new Error(errorMessage);
    }
}

/**
 * Run a command and return its PID
 * @param {NS} ns - The NS instance
 * @param {RunFunction} fnRun - Function to run the command
 * @param {string} command - Command to run
 * @param {string} fileName - File name
 * @param {(string|number|boolean)[]} args - Arguments for the command
 * @param {boolean} verbose - Whether to be verbose
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} retryDelayMs - Retry delay
 * @param {boolean} silent - Whether to be silent
 * @returns {Promise<number>} Process ID
 */
export async function runCommand(
    ns: NS,
    fnRun: RunFunction,
    command: string,
    fileName: string | null,
    args: (string | number | boolean)[] = [],
    verbose = false,
    maxRetries = 5,
    retryDelayMs = 50,
    silent = false
): Promise<number> {
    checkNsInstance(ns, '"runCommand"');
    if (!Array.isArray(args)) throw new Error(`args specified were a ${typeof args}, but an array is required.`);
    if (!verbose) disableLogs(ns, ['sleep']);

    // Auto-import any helpers that the temp script attempts to use
    const importFunctions = getExports(ns)
        .filter(e => command.includes(`${e}`))
        .filter(e => new RegExp(`(^|[^\\w])${e}([^\\w]|$)`).test(command));

    const script = (importFunctions.length > 0
        ? `import { ${importFunctions.join(', ')} } from 'helpers.js'\n`
        : '') + `export async function main(ns) { ${command} }`;

    fileName = fileName || getDefaultCommandFileName(command, '.js');

    if (verbose) {
        log(
            ns,
            `INFO: Using a temporary script (${fileName}) to execute the command:` +
            `\n  ${command}\nWith the following arguments: ${JSON.stringify(args)}`
        );
    }

    // It's possible for the file to be deleted while we're trying to execute it
    return await autoRetry(
        ns,
        async () => {
            // Don't re-write the temp script if it's already in place with the correct contents
            const oldContents = ns.read(fileName!);
            if (oldContents != script) {
                if (oldContents) {
                    ns.tprint(
                        `WARNING: Had to overwrite temp script ${fileName}\nOld Contents:\n${oldContents}\nNew Contents:\n${script}` +
                        '\nThis warning is generated as part of an effort to switch over to using only \'immutable\' temp scripts. ' +
                        'Please paste a screenshot in Discord at https://discord.com/channels/415207508303544321/935667531111342200'
                    );
                }

                ns.write(fileName!, script, 'w');

                // Wait for the script to appear and be readable
                await autoRetry(
                    ns,
                    () => ns.read(fileName!),
                    c => c == script,
                    () => `Temporary script ${fileName} is not available, ` +
                        'despite having written it. (Did a competing process delete or overwrite it?)',
                    maxRetries,
                    retryDelayMs,
                    undefined,
                    verbose,
                    verbose,
                    silent
                );
            }

            // Run the script
            const options: RunOptions = { temporary: true };
            return fnRun(fileName!, options, ...args);
        },
        pid => pid !== 0,
        async () => {
            if (silent) return '(silent = true)';

            let reason = ' (likely due to insufficient RAM)';

            // Find out how much RAM this script requires vs what we have available
            try {
                const reqRam = await execNsCommand(
                    ns, fnRun, 'ns.getScriptRam(ns.args[0])', null, [fileName!], false, 1, 0, true
                ) as number;
                const homeMaxRam = await execNsCommand(
                    ns, fnRun, 'ns.getServerMaxRam(ns.args[0])', null, ['home'], false, 1, 0, true
                ) as number;
                const homeUsedRam = await execNsCommand(
                    ns, fnRun, 'ns.getServerUsedRam(ns.args[0])', null, ['home'], false, 1, 0, true
                ) as number;

                if (reqRam > homeMaxRam)
                    reason = ` as it requires ${formatRam(reqRam)} RAM, but home only has ${formatRam(homeMaxRam)}`;
                else if (reqRam > homeMaxRam - homeUsedRam)
                    reason = ` as it requires ${formatRam(reqRam)} RAM, but home only has ${formatRam(homeMaxRam - homeUsedRam)} of ${formatRam(homeMaxRam)} free.`;
                else
                    reason = `, but the reason is unclear. (Perhaps a syntax error?) This script requires ${formatRam(reqRam)} RAM, and ` +
                        `home has ${formatRam(homeMaxRam - homeUsedRam)} of ${formatRam(homeMaxRam)} free, which appears to be sufficient. ` +
                        'If you wish to troubleshoot, you can try manually running the script with the arguments listed below:';
            } catch (ex) { /* It was worth a shot. Stick with the generic error message. */ }

            return `The temp script was not run${reason}.` +
                `\n  Script:  ${fileName}\n  Args:    ${JSON.stringify(args)}\n  Command: ${command}` +
                '\nThe script that ran this will likely recover and try again later.';
        },
        maxRetries,
        retryDelayMs,
        undefined,
        verbose,
        verbose,
        silent
    ) as number;
}

/**
 * Execute an NS command and get its result
 * @param {NS} ns - The NS instance
 * @param {RunFunction} fnRun - Function to run the command
 * @param {string} command - Command to execute
 * @param {string|null} fName - Filename for results
 * @param {(string|number|boolean)[]} args - Arguments for the command
 * @param {boolean} verbose - Whether to be verbose
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} retryDelayMs - Retry delay
 * @param {boolean} silent - Whether to be silent
 * @returns {Promise<unknown>} Result of the command
 */
export async function execNsCommand<T>(
    ns: NS,
    fnRun: RunFunction,
    command: string,
    fName: string | null = null,
    args: (string | number | boolean)[] = [],
    verbose = false,
    maxRetries = 5,
    retryDelayMs = 50,
    silent = false
): Promise<T> {
    checkNsInstance(ns, '"execNsCommand"');

    // Set default values for null/undefined arguments
    if (args == null) args = [];
    if (verbose == null) verbose = false;
    if (maxRetries == null) maxRetries = 5;
    if (retryDelayMs == null) retryDelayMs = 50;
    if (silent == null) silent = false;

    if (!verbose) disableLogs(ns, ['read']);
    fName = fName || getDefaultCommandFileName(command);
    const fNameCommand = fName + '.js';

    // Pre-write contents to detect if temp script never ran
    const initialContents = '<Insufficient RAM>';
    ns.write(fName, initialContents, 'w');

    // Workaround for v2.3.0 deprecation
    if (command === 'ns.getPlayer()') {
        command = `( ()=> { 
            let player = ns.getPlayer();
            const excludeProperties = ['playtimeSinceLastAug', 'playtimeSinceLastBitnode', 'bitNodeN'];
            return Object.keys(player).reduce((pCopy, key) => {
                if (!excludeProperties.includes(key))
                   pCopy[key] = player[key];
                return pCopy;
            }, {});
        })()`;
    }

    // Prepare a command that will write results to a file
    const commandToFile = 'let r;try{r=JSON.stringify(\n' +
        `    ${command}\n` +
        ', jsonReplacer);}catch(e){r="ERROR: "+(typeof e==\'string\'?e:e?.message??JSON.stringify(e));}\n' +
        `const f="${fName}"; if(ns.read(f)!==r) ns.write(f,r,'w')`;

    // Run the command with auto-retries if it fails
    const pid = await runCommand(ns, fnRun, commandToFile, fNameCommand, args, verbose, maxRetries, retryDelayMs, silent);

    // Wait for the process to complete
    const fnIsAlive = async (ignored_pid: number): Promise<boolean> => {
        return ns.read(fName!) === initialContents;
    };
    await waitForProcessToComplete(ns, fnIsAlive, pid, verbose);

    if (verbose) log(ns, `Process ${pid} is done. Reading the contents of ${fName}...`);

    // Read the file, with auto-retries if it fails
    let lastRead: string;
    const fileData = await autoRetry(
        ns,
        () => ns.read(fName!),
        f => {
            lastRead = f as string;
            return lastRead !== undefined &&
                lastRead !== '' &&
                lastRead !== initialContents &&
                !(typeof lastRead == 'string' && lastRead.startsWith('ERROR: '));
        },
        () => `\nns.read('${fName}') returned a bad result: "${lastRead}".` +
            `\n  Script:  ${fNameCommand}\n  Args:    ${JSON.stringify(args)}\n  Command: ${command}` +
            (lastRead == undefined ?
                '\nThe developer has no idea how this could have happened. Please post a screenshot of this error on discord.' :
                lastRead == initialContents ?
                    '\nThe script that ran this will likely recover and try again later once you have more free ram.' :
                    lastRead == '' ?
                        '\nThe file appears to have been deleted before a result could be retrieved. Perhaps there is a conflicting script.' :
                        lastRead.includes('API ACCESS ERROR') ?
                            '\nThis script should not have been run until you have the required Source-File upgrades. Sorry about that.' :
                            '\nThe script was likely passed invalid arguments. Please post a screenshot of this error on discord.'),
        maxRetries,
        retryDelayMs,
        undefined,
        verbose,
        verbose,
        silent
    );

    if (verbose) log(ns, `Read the following data for command ${command}:\n${fileData}`);

    // Deserialize it back into an object/array and return
    return JSON.parse(fileData as string, jsonReviver);
}

/**
 * Main function to execute NS commands through a temporary file
 * @param {NS} ns - The NS instance
 * @param {string} command - Command to execute
 * @param {string|null} fName - Filename for results
 * @param {(string|number|boolean)[]} args - Arguments for the command
 * @param {boolean} verbose - Whether to be verbose
 * @param {number} maxRetries - Maximum retry attempts
 * @param {number} retryDelayMs - Retry delay
 * @param {boolean} silent - Whether to be silent
 * @returns {Promise<unknown>} Result of the command
 */
export async function executeCommand<T>(
    ns: NS,
    command: string,
    fName: string | null = null,
    args: (string | number | boolean)[] = [],
    verbose = false,
    maxRetries = 5,
    retryDelayMs = 50,
    silent = false
): Promise<T> {
    checkNsInstance(ns, '"executeCommand"');
    if (!verbose) disableLogs(ns, ['run', 'isRunning']);
    return await execNsCommand(ns, ns.run, command, fName, args, verbose, maxRetries, retryDelayMs, silent) as T;
}
