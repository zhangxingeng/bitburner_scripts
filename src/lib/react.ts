import type * as ReactNs from 'react';
import type * as ReactDOMNs from 'react-dom';

/**
 * Zero-RAM React access for Bitburner UI scripts.
 *
 * eval('window') / eval('document') hide the global lookups from Bitburner's
 * static RAM analyzer, so importing React here costs 0 GB. The game (v3.0.2)
 * bundles React 17.0.2 and exposes React + ReactDOM on window; only the legacy
 * ReactDOM.render entrypoint exists (no createRoot) — verified against the
 * running game. UI scripts must use ReactDOM.render / unmountComponentAtNode.
 *
 * Types come from @types/react@17 (dev-only, erased at compile time via
 * `import type`); the runtime values come from the game's globals. This mirrors
 * the community standard (inigo's libReact / the official template).
 *
 * IMPORTANT: import the runtime values (React, ReactDOM, domWindow, domDocument)
 * via the RELATIVE path '../lib/react' — NOT the '@react' tsconfig alias. Path
 * aliases are compile-time only; an aliased specifier would survive into the
 * emitted JS and fail to resolve in-game.
 */

interface BitburnerWindow extends Window {
	React: typeof ReactNs;
	ReactDOM: typeof ReactDOMNs;
}

export const domWindow = eval('window') as BitburnerWindow & typeof globalThis;
export const domDocument = eval('document') as Document;

export const React = domWindow.React;
export const ReactDOM = domWindow.ReactDOM;
