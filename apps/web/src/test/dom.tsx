/** Component-test helpers; registers the DOM globals first, then loads react-dom. */
import './domInstall.ts';
import { afterAll, beforeAll } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installDomGlobals, restoreDomGlobals } from './domGlobals.ts';

// react-dom is loaded; nothing else in the process should see a DOM until a test file asks for it.
restoreDomGlobals();

/** Call at the top of a DOM test file: the DOM globals exist for that file's tests only. */
export function withDomGlobals(): void {
  beforeAll(installDomGlobals);
  afterAll(restoreDomGlobals);
}

export interface Mounted {
  readonly container: HTMLElement;
  render(ui: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

/** Mounts into a fresh container; every render is wrapped in `act` so effects and state updates have run. */
export async function mount(ui: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root: Root = createRoot(container);
  const mounted: Mounted = {
    container,
    async render(next) {
      await act(async () => root.render(next));
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  await mounted.render(ui);
  return mounted;
}

/** Clicks the element matching a CSS selector, or the first button/link whose text matches a RegExp. */
export async function click(container: HTMLElement, match: string | RegExp): Promise<void> {
  const candidates = [...container.querySelectorAll('button, a, [role="button"]')];
  const target =
    typeof match === 'string'
      ? container.querySelector(match)
      : candidates.find((element) => match.test(element.textContent ?? ''));
  if (!target) throw new Error(`nothing to click for ${String(match)}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
