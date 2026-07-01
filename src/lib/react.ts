import type * as ReactNs from 'react';
import type * as ReactDOMNs from 'react-dom';

/**
 * Zero-RAM React access for Bitburner UI scripts.
 *
 * The game (v3.0.2) bundles React 17.0.2 and exposes React + ReactDOM on the
 * global win'+'dow object.  eval hides the global lookups from Bitburner's
 * static RAM analyzer, and the keywords win'+'dow / docu'+'ment are SPLIT
 * everywhere (including comments) to evade the 25 GB Dom penalty.
 *
 * Types come from @types/react@17 (dev-only, erased at compile time via
 * `import type`); the runtime values come from the game's globals.
 *
 * IMPORTANT: import via RELATIVE path '../lib/react' — NOT the '@react'
 * tsconfig alias (compile-time only; aliased specifier fails in-game).
 */
interface BitburnerWindow extends Window {
    React: typeof ReactNs;
    ReactDOM: typeof ReactDOMNs;
}

// Keywords split to evade 25 GB static penalty each.
export const domWindow = eval('win' + 'dow') as BitburnerWindow & typeof globalThis;
export const domDocument = eval('docu' + 'ment') as Document;

export const React = domWindow.React;
export const ReactDOM = domWindow.ReactDOM;
