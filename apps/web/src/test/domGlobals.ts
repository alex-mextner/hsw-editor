/**
 * Minimal DOM for component tests: happy-dom's window mounted on the globals React DOM needs.
 * `fetch`, `Response` and friends are deliberately left to Bun's own implementations, so tests that
 * stub the network behave the same with and without this module loaded. Import it BEFORE react-dom
 * (see dom.tsx), which reads `window` when it is first evaluated.
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

for (const name of GLOBALS) {
  Object.defineProperty(globalThis, name, {
    value: happy[name],
    configurable: true,
    writable: true,
  });
}
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
