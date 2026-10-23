/**
 * Minimal DOM for component tests: happy-dom's window mounted on the globals React DOM needs.
 * `fetch`, `Response` and friends are deliberately left to Bun's own implementations, so tests that
 * stub the network behave the same with and without this module loaded. Import it BEFORE react-dom
 * (see dom.tsx), which reads `window` when it is first evaluated, so dom.tsx installs them through
 * domInstall.ts before loading it, restores them right after, and each test file turns them on only for its
 * own run with `withDomGlobals()`. Importing this module alone changes nothing.
 */
import { Window } from 'happy-dom';

const happy = new Window({ url: 'http://localhost:5173/' });

const GLOBALS = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLButtonElement',
  'SVGElement',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'FocusEvent',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
  'localStorage',
  'sessionStorage',
] as const;

const originals = new Map<string, PropertyDescriptor | undefined>();

/** Mounts happy-dom on the globals; remembers what was there so `restoreDomGlobals` can undo it exactly. */
export function installDomGlobals(): void {
  for (const name of GLOBALS) {
    if (!originals.has(name))
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: happy[name],
      configurable: true,
      writable: true,
    });
  }
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
}

/** Puts the globals back, so test files in the same Bun process that expect no DOM keep passing. */
export function restoreDomGlobals(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
}
