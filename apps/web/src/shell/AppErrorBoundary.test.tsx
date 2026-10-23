import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { CLIENT_ERRORS_ROUTE, resetClientErrorThrottle } from '@/api/clientErrors.ts';
import { click, mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';
import { installFetch, restoreFetch } from '@/test/fetchStub.ts';
import { localeStore } from '@/i18n/index.ts';
import { AppErrorBoundary, crashDetails } from './AppErrorBoundary.tsx';

/** Throws while `broken.current` is set; mounts a counter so a real re-mount is observable. */
let mounts = 0;
function App({ broken }: { readonly broken: { current: boolean } }) {
  if (broken.current) throw new Error('Could not load /bank/assets/glb/a47bacef44e3f4f4.glb: boom');
  mounts++;
  return <p data-testid="app">editor</p>;
}

const posted: unknown[] = [];
let mounted: Mounted | null = null;

beforeEach(() => {
  localeStore.set('en');
  resetClientErrorThrottle();
  posted.length = 0;
  mounts = 0;
  installFetch((url, init) => {
    if (url === CLIENT_ERRORS_ROUTE) posted.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  restoreFetch();
});

withDomGlobals();

describe('AppErrorBoundary', () => {
  test('an error in the tree shows the recover panel instead of a blank page, and is logged as render', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    mounted = await mount(
      <AppErrorBoundary>
        <App broken={{ current: true }} />
      </AppErrorBoundary>,
    );
    consoleError.mockRestore();

    const panel = mounted.container.querySelector('[role="alert"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Something went wrong');
    expect(panel?.textContent).toContain('a47bacef44e3f4f4.glb: boom');
    for (const label of ['Recover', 'Reload page', 'Copy details']) {
      expect(panel?.textContent).toContain(label);
    }
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: 'render', message: expect.stringContaining('boom') });
  });

  test('Recover re-mounts the app without a page reload once the cause is gone', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = { current: true };
    mounted = await mount(
      <AppErrorBoundary>
        <App broken={broken} />
      </AppErrorBoundary>,
    );
    expect(mounted.container.querySelector('[data-testid="app"]')).toBeNull();

    broken.current = false;
    await click(mounted.container, /^Recover$/);
    consoleError.mockRestore();

    expect(mounted.container.querySelector('[data-testid="app"]')?.textContent).toBe('editor');
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    expect(mounts).toBeGreaterThan(0);
  });

  test('Recover on a still-broken app shows the panel again rather than looping or blanking', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    mounted = await mount(
      <AppErrorBoundary>
        <App broken={{ current: true }} />
      </AppErrorBoundary>,
    );
    await click(mounted.container, /^Recover$/);
    consoleError.mockRestore();
    expect(mounted.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  test('a healthy tree renders untouched', async () => {
    mounted = await mount(
      <AppErrorBoundary>
        <App broken={{ current: false }} />
      </AppErrorBoundary>,
    );
    expect(mounted.container.querySelector('[data-testid="app"]')?.textContent).toBe('editor');
    expect(posted).toHaveLength(0);
  });
});

describe('crashDetails', () => {
  test('contains message, page, stack and component stack for pasting into a ticket', () => {
    const error = new Error('kaput');
    const text = crashDetails(error, '\n    at Viewport', 'http://localhost/#wall');
    expect(text).toContain('Error: kaput');
    expect(text).toContain('page: http://localhost/#wall');
    expect(text).toContain('component stack:\n    at Viewport');
  });
});
