import { NS } from '@ns';
import { findAllServers } from './lib/utils';
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
    const allServers = useMemo(() => findAllServers(ns), [ns]);
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