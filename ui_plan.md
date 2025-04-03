
## ✅ Goal

Build a custom **Bitburner UI component** with two main features:

1. **Script Runner Interface** – input a script name (located anywhere under `/home`) and execute it from any server.
2. **Server Navigator Interface** – input a server name (like `CSEC`), validate it, and auto-connect to it.

Both features should have:

- **Reactive input suggestions** (based on live input)
- **Status-aware buttons**:
  - **Default**: Neutral color (e.g., gray)
  - **Valid input found**: Blue
  - **Success**: Green
  - **Failure**: Red

---

## 🔧 Technical Requirements

- **Framework**: React (DOM-injected for Bitburner)
- **DOM injection style**: Use Bitburner’s method (e.g., `getReactFromDom`, `injectReactComponent`)
- **UI Behavior**:
  - Both tools should be usable from *any server* in-game.
  - Live-reactive input with fuzzy match suggestions.
  - Execute logic behind buttons asynchronously (color reflects execution result).
  - Common color states (gray = idle, blue = ready, green = success, red = error).
  - Optionally abstract the button logic as a **reusable component**.

---

## 🎯 Feature 1: **Script Runner Interface**

### Description

Allows user to type the name of a script, automatically searches `/home` recursively for it, and runs it from *wherever* the user is.

### Behavior

- Input box for script name (with live fuzzy suggestions).
- Button labeled `ROM`.
- On click:
  1. Go to `home`.
  2. Search recursively for the script path.
  3. If found, run it.
  4. Color response:
     - **Red** = not found / error
     - **Blue** = script found, ready to run
     - **Green** = successfully ran

### To Implement

- Recursive file search under `/home`.
- Use `ns.singularity.connect('home')` and `ns.run(script, ...)`.
- Real-time file list for suggestions.
- Handle errors and script not found cases.

---

## 🎯 Feature 2: **Server Navigator Interface**

### Description

Allows typing in a server keyword (e.g., `CSEC`) and auto-connects to it using pathfinding logic (via an existing CLI tool you have).

### Behavior

- Input box for server name (with live suggestions).
- Button labeled `GO`.
- On click:
  1. Validate server name.
  2. If valid:
     - Show blue.
     - If clicked again, run connection path logic.
     - If success: green.
     - If failed to connect: red.

### To Implement

- Autocomplete/fuzzy matching on server list.
- Validate via `getServer` or custom graph traversal.
- Modify your existing command-line connect script for internal function use.
- Handle unreachable/invalid names gracefully.

---

## 💡 Shared Components and Enhancements

### 🔁 Reusable Button Component

Build a single button component that takes in:

- `defaultLabel`
- `onClick`
- `statusState` → handles gray, blue, green, red
- Optional tooltips for feedback

### ⚡ Live Reactive Input

Use a simple input + filtered list pattern for both:

- `onChange` triggers a live filter from:
  - `ns.ls("home", true)` for scripts
  - `scanServerBFS()` or precomputed map for servers

---

## 📦 Deliverables

1. A single React component that includes:
   - Script Runner Input + ROM Button
   - Server Navigator Input + GO Button
   - Optional extracted `StatusButton` component
2. Uses Bitburner-safe DOM injection (`getReactFromDom`)
3. Input with live filtering for scripts and server names
4. Fully working async logic behind each button
5. Color-based UI feedback (Gray → Blue → Green/Red)
6. High-quality, clean code that meets best practices

# code piece #1 (insert to overview window)

import { NS } from '@ns';
import { scanServerBFS } from './utils';
const cheatyWindow = eval('window') as Window & typeof globalThis;
const cheatyDocument = eval('document') as Document & typeof globalThis;

const React = cheatyWindow.React;
const ReactDOM = cheatyWindow.ReactDOM;
const { useState, useEffect, useMemo } = React;

export async function main(ns: NS) {
    ns.disableLog('asleep');
    ReactDOM.render(
        <React.StrictMode>
            <Dashboard ns={ns} />
        </React.StrictMode>,
        cheatyDocument.getElementById('overview-extra-hook-0') // there are 3 empty elements provided for players to include their own ui under overview window named (.overview-extra-hook-0, ...-1 ,...-2).
    );
    while (ns.scriptRunning('/ui-example/ui.js', 'home')) {
        await ns.asleep(1000); // script must be running in bitburner for ns methods to function inside our component
    }
}

export interface IDashboardProps {
    ns: NS;
}
export const Dashboard = ({ ns }: IDashboardProps) => {
    const killAllClicked = async () => {
        alert('Killing stuff');
    };

    const runClicked = async () => {
        alert('Running stuff');
    };
    return (
        <div
            style={{
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                flexGrow: 1,
            }}
        >
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'row',
                }}
            >
                <Button
                    bg="red"
                    title="Kill All!"
                    onButtonClick={killAllClicked}
                />
                <Button
                    bg="green"
                    title="Run!"
                    onButtonClick={runClicked}
                />
            </div>
            <MonitorInput ns={ns} />
            <ToggleSection ns={ns} />
        </div>
    );
};

// This module lets you monitor a server's details (money, security, required threads for grow,weaken,hack etc).
//It has a primitive auto - complete feature. Suggestions for server names will appear as you start typing.When there is 1 suggestion left pressing Enter will run a monitor for that server.
export const MonitorInput = ({ ns }: { ns: NS }) => {
    // const Map[allServers, pathAllServers] = useMemo(() => scanServerBFS(ns), []); use the right syntax
    // get keys of scanServerBFS
    const allServers = useMemo(() => Array.from(scanServerBFS(ns).keys()), [ns]);
    const [suggestions, setSuggestions] = useState<string[]>([]);

    const onChangeHandler: React.ChangeEventHandler<HTMLInputElement> = (e) => {
        const query = e.target.value;
        const matchedServers: string[] = [];
        for (const server of allServers) {
            if (queryInString(query, server)) {
                matchedServers.push(server);
            }
        }

        setSuggestions(e.target.value === '' ? [] : matchedServers);
    };

    const onKeyDownHandler = async (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            if (suggestions.length === 1) {
                ns.run('/ui-example/utils/monitor.js', 1, suggestions[0]);
                setSuggestions([]);
            }
        }
    };
    const onFocusHandler = () => {
        // disable Bitburner terminal input so that we can write inside our custom widget instead of game's terminal
        const terminalInput = cheatyDocument.getElementById('terminal-input') as HTMLInputElement;
        if (terminalInput) terminalInput.disabled = true;
    };

    const onFocusOut = () => {
        // enable Bitburner terminal input again after focusing out of our widget input
        const terminalInput = cheatyDocument.getElementById('terminal-input') as HTMLInputElement;
        if (terminalInput) terminalInput.disabled = false;
    };
    const suggestionsSection = suggestions.map((server) => {
        return <div key={server}>{server}</div>;
    });
    return (
        <div
            style={{
                fontFamily: 'Consolas',
                fontSize: '12px',
            }}
        >
            <input
                style={{
                    width: '100px',
                    height: '20px',
                    border: '1px solid yellow',
                    padding: '2px',
                    backgroundColor: 'black',
                    color: 'yellow',
                    margin: '2px',
                }}
                placeholder="Monitor"
                onChange={onChangeHandler}
                onKeyDown={onKeyDownHandler}
                onFocusCapture={onFocusHandler}
                onBlur={onFocusOut}
            />
            <div
                style={{
                    position: 'relative',
                    width: '60px',
                    bottom: '0px',
                    background: '#00000092',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    zIndex: '9999',
                }}
            >
                {suggestions.length > 0 ? suggestionsSection : null}
            </div>
        </div>
    );
};

function queryInString(query: string, string: string) {
    return string.toLowerCase().includes(query.toLowerCase());
}

export const Button = ({ bg, title, onButtonClick }: { bg: string; title: string; onButtonClick: () => void }) => {
    const buttonRef = React.useRef<HTMLDivElement>(null);

    const buttonHovered = useOnHover(buttonRef);
    return (
        <div
            ref={buttonRef}
            onClick={onButtonClick}
            style={{
                backgroundColor: bg,
                border: 'none',
                color: 'white',
                padding: '5px 5px',
                textAlign: 'center',
                textDecoration: 'none',
                display: 'inline-block',
                fontSize: '12px',
                margin: '4px 2px',
                cursor: 'pointer',
                borderRadius: '5px',
                fontFamily: 'Arial Black',
                transition: 'filter 0.1s ease-out',
                filter: buttonHovered ? 'saturate(100%)' : 'saturate(50%)',
            }}
        >
            {title}
        </div>
    );
};

export const useOnHover = (ref: React.RefObject<HTMLElement>) => {
    const [hovered, setHovered] = useState(false);

    const mouseEntered = React.useCallback(() => {
        setHovered(true);
    }, [ref.current]);

    const mouseLeft = React.useCallback(() => {
        setHovered(false);
    }, [ref.current]);

    useEffect(() => {
        if (!ref.current) return;

        ref.current.addEventListener('mouseenter', mouseEntered);
        ref.current.addEventListener('mouseleave', mouseLeft);

        return () => {
            if (!ref.current) return;

            ref.current.removeEventListener('mouseenter', mouseEntered);
            ref.current.removeEventListener('mouseleave', mouseLeft);
        };
    }, [ref.current]);

    return hovered;
};

export const ToggleSection = ({ ns }: { ns: NS }) => {
    const [hackActive, setHackActive] = useState(false);
    const [workActive, setWorkActive] = useState(true);
    const [sleepActive, setSleepActive] = useState(false);
    const [repeatActive, setRepeatActive] = useState(true);

    return (
        <div
            style={{
                width: '100px',
                display: 'flex',
                flexDirection: 'column',

                margin: '4px 0px',
                padding: '2px',
                textAlign: 'center',
            }}
        >
            <h4 style={{ marginBottom: '5px' }}>Switches</h4>
            <Switch
                title="Hack"
                onClickHandler={() => {
                    setHackActive(!hackActive);
                }}
                active={hackActive}
            />
            <Switch
                title="Work"
                onClickHandler={() => {
                    setWorkActive(!workActive);
                }}
                active={workActive}
            />
            <Switch
                title="Sleep"
                onClickHandler={() => {
                    setSleepActive(!sleepActive);
                }}
                active={sleepActive}
            />
            <Switch
                title="Sleep"
                onClickHandler={() => {
                    setRepeatActive(!repeatActive);
                }}
                active={repeatActive}
            />
        </div>
    );
};

export const Switch = ({
    title,
    onClickHandler,
    active,
}: {
    title: string;
    onClickHandler: React.MouseEventHandler<HTMLDivElement>;
    active: boolean;
}) => {
    const buttonRef = React.useRef<HTMLDivElement>(null);

    const buttonHovered = useOnHover(buttonRef);

    return (
        <div
            ref={buttonRef}
            onClick={onClickHandler}
            style={{
                width: '100px',
                backgroundColor: active ? 'green' : 'transparent',
                border: 'white solid 1px',
                color: 'white',
                padding: '5px 5px',
                textAlign: 'center',
                textDecoration: 'none',
                display: 'inline-block',
                fontSize: '12px',
                margin: '4px 2px',
                cursor: 'pointer',
                borderRadius: '5px',
                fontFamily: 'Arial Black',
                transition: 'filter 0.1s ease-out',
                filter: buttonHovered ? 'saturate(100%)' : 'saturate(50%)',
            }}
        >
            {title}
        </div>
    );
};

# code piece #2 (insert to script log window)

import type React_Type from 'react';
import { autoConnect, scanDeep } from './utils';
import renderCustomModal, { css, EventHandlerQueue } from './renderCustomModal';

declare var React: typeof React_Type;

function getColorScale(v: number) {
    return `hsl(${Math.max(0, Math.min(1, v)) * 130}, 100%, 50%)`;
}

const toolbarStyles: React_Type.CSSProperties = {
    lineHeight: '30px',
    alignItems: 'center',
    display: 'flex',
    gap: 16,
    margin: 8,
};

export async function main(ns: NS) {
    console.log('Started monitor');

    let showNonRooted = true;
    let showNonHackable = false;

    const eventQueue = new EventHandlerQueue();

    const servers = scanDeep(ns, { depthFirst: true });
    servers.splice(0, 0, { hostname: 'home', route: [] });

    while (true) {
        const player = ns.getPlayer();

        const filteredServers = servers.map(s => ({ ...s, server: ns.getServer(s.hostname) })).filter(({ server }) => (
            (showNonRooted || server.hasAdminRights) &&
            (showNonHackable || server.requiredHackingSkill <= player.hacking)
        ));

        ns.tail();
        renderCustomModal(ns,
            <div id='custom-monitor' style={{ fontSize: '0.75rem' }}>
                <style children={css`
                    #custom-monitor th,
                    #custom-monitor td {
                        padding-right: 12px;
                    }
                    #custom-monitor th {
                        text-align: left;
                    }
                    #custom-monitor thead > * {
                        border-bottom: 1px solid green;
                    }
                    #custom-monitor tr:hover {
                        background: rgba(255, 255, 255, 0.1);
                    }
                `} />
                <div style={toolbarStyles}>
                    <button onClick={() => showNonRooted = !showNonRooted}>
                        {showNonRooted ? 'Show' : 'Hide'} non-rooted
                    </button>
                    <button onClick={() => showNonHackable = !showNonHackable}>
                        {showNonHackable ? 'Show' : 'Hide'} non-hackable
                    </button>
                </div>
                <table style={{ borderSpacing: 0, whiteSpace: 'pre' }}>
                    <thead>
                        <th>Server</th>
                        <th>R</th>
                        <th>BD</th>
                        <th>U-RAM</th>
                        <th>M-RAM</th>
                        <th>$</th>
                        <th>Max $</th>
                        <th>Sec</th>
                        <th>MSec</th>
                        <th>Tools</th>
                    </thead>
                    <tbody>
                        {filteredServers.map(({ hostname, route, server }) => {
                            const onKillAllClick = eventQueue.wrap(() => {
                                ns.ps(hostname).forEach(x => ns.kill(x.pid));
                            });
                            const onConnectClick = eventQueue.wrap(() => {
                                autoConnect(ns, hostname);
                            });
                            return (
                                <tr key={hostname}>
                                    <th>{''.padEnd(route.length * 2, ' ')}{hostname}</th>
                                    <td>{server.hasAdminRights ? 'X' : ' '}</td>
                                    <td>{server.backdoorInstalled ? 'X' : ' '}</td>
                                    <td>{Math.round(server.ramUsed * 10) / 10}</td>
                                    <td>{server.maxRam}</td>
                                    <td style={{ color: getColorScale(server.moneyAvailable / server.moneyMax) }}>
                                        {ns.nFormat(server.moneyAvailable, '$0.00a')}
                                    </td>
                                    <td style={{ color: getColorScale(server.moneyAvailable / server.moneyMax) }}>
                                        {server.moneyMax === 0 ? '' : Math.round(server.moneyAvailable / server.moneyMax * 1000) / 10 + '%'}
                                    </td>
                                    <td>
                                        {ns.nFormat(server.moneyMax, '$0.00a')}
                                    </td>
                                    <td style={{ color: getColorScale(1 - (server.hackDifficulty - server.minDifficulty) / 10) }}>
                                        {Math.round(server.hackDifficulty * 100) / 100}
                                    </td>
                                    <td>
                                        {server.minDifficulty}
                                    </td>
                                    <td>
                                        <button onClick={onConnectClick} title='Connect to this server'>
                                            C
                                        </button>
                                        <button onClick={onKillAllClick} title='Kill all scripts on this server'>
                                            K
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        );
        await eventQueue.executeEvents();
        await ns.sleep(1_000);
    }
}

# finding server path script (it is working, you just need to modify it to my need)

import { NS } from '@ns';
import { scanServerBFS } from './utils';

export async function main(ns: NS): Promise<void> {
    // Check if argument is provided
    if (ns.args.length === 0) {
        ns.tprint('ERROR: Please provide a search term');
        ns.tprint('Usage: run get_server_path.js <search_term>');
        return;
    }

    const searchTerm = ns.args[0].toString();
    // Create a regex that matches the exact substring, case insensitive
    const regex = new RegExp(searchTerm, 'i');
    const serverPaths = scanServerBFS(ns);
    let matchCount = 0;

    // Search through all servers
    for (const [server, path] of serverPaths.entries()) {
        // Only match if the search term exists as a continuous substring
        if (regex.test(server)) {
            matchCount++;
            // Convert path to connect commands, skipping 'home'
            const connectCommand = path
                .slice(1) // Skip 'home'
                .map(s => `connect ${s}`)
                .join(';');

            ns.tprint(`Match #${matchCount} - ${server}: ${connectCommand}`);
        }
    }

    if (matchCount === 0) {
        ns.tprint(`No servers found matching '${searchTerm}'`);
    } else {
        ns.tprint(`Found ${matchCount} server(s) matching '${searchTerm}'`);
    }
}

Write me the code into modules and use react hooks instead of classes for simplcity's sake.
dont be afraid to split things into multiple files and suggest me a overall file structure. I would love it. just make sure your imports are all relevant to the file structure.
all files will reside in a folder UI/ so make sure either use relative import. if you need the netscript type declearations and functions you can just import { NS } from '@ns'; it points to the NetscriptDefinitions.d.ts file (you can also find it on github <https://github.com/bitburner-official/bitburner-src/blob/dev/src/ScriptEditor/NetscriptDefinitions.d.ts> or you can do online search for keyword NetscriptDefinitions.d.ts and the official bitburner script github repo is called bitburner-src)

Write me top tier code and follow the following guideline:

# TypeScript Coding Style Guide

## Structure and Organization

- **Modular design**: Break functionality into small, single-purpose functions
- **Clear function hierarchy**: Helper functions first, main function last
- **Compact formatting**: Avoid unnecessary empty lines while maintaining readability

## Function Design

- **Single responsibility**: Each function does exactly one thing well
- **Short functions**: Keep functions concise and focused
- **Early returns**: Return early to avoid deep nesting
- **Clear parameter and return types**: Use TypeScript typing consistently

## Documentation and Naming

- **Concise JSDoc comments**: Brief description for each function's purpose
- **Descriptive variable names**: Names that clearly convey purpose (e.g., `discoveredServers`, `rootedCount`)
- **Minimal inline comments**: Only comment non-obvious logic
- **Consistent naming convention**: camelCase for variables and functions

## Error Handling and Flow

- **Graceful error handling**: Use try/catch blocks with appropriate scope
- **Silent fails when appropriate**: Catch and continue for non-critical operations
- **Meaningful output**: Clear success/failure messages and summaries
- **Proper validation**: Check conditions before operations (like single instance check)

## Functional Approach

- **Use array methods**: Leverage filter, map, reduce where appropriate
- **Avoid mutation**: Prefer creating new objects/arrays over modifying existing ones
- **Local helper functions**: Define helper functions within scope when they're only used there

Overall, write clean, modular TypeScript with single-purpose functions, minimal commenting, early returns, descriptive naming, and proper error handling.

I dont have to mention but you do know for react code you need to name files with .tsx instead of ts right?

/ui/
├── components/
│   ├── StatusButton.tsx
│   ├── ServerNavigator.tsx
│   ├── ScriptRunner.tsx
│   ├── AutoCompleteInput.tsx
│   └── index.ts
├── hooks/
│   ├── useServerList.ts
│   ├── useScriptList.ts
│   └── index.ts
├── utils/
│   ├── serverUtils.ts
│   ├── scriptUtils.ts
│   └── index.ts
├── Dashboard.tsx
└── main.ts
