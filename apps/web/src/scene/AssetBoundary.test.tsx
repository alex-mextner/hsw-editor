import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from 'bun:test';
import { act, Component, type ReactNode } from 'react';
import { CLIENT_ERRORS_ROUTE, resetClientErrorThrottle } from '@/api/clientErrors.ts';
import { mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';
import { installFetch, restoreFetch } from '@/test/fetchStub.ts';
import { bankElement, bankIndex, readyBankState } from '@/test/fixtures.ts';
import { clearAssetHealth, getFailure } from '@/bank/assetHealth.ts';
import { requestRetry } from '@/bank/assetRecovery.ts';
import { bankStore, type UnavailableElement } from '@/bank/client.ts';
import { localeStore } from '@/i18n/index.ts';
import { AssetBoundary, type FailureView } from './AssetBoundary.tsx';

const URL = '/bank/assets/glb/a47bacef44e3f4f4.glb';
const BANK_ID = 'caliper-cradle-slots1-beamwidth20';
/** The exact error of the incident: R3F wrapping three's FileLoader 404. */
const INCIDENT = `Could not load ${URL}: fetch for "${URL}" responded with 404: Not Found`;

/** Child standing in for `useGLTF(url)`: throws the loader error until the "server" has the file. */
function Model({ available }: { readonly available: { current: boolean } }) {
  if (!available.current) throw new Error(INCIDENT);
  return <p data-testid="model">model drawn</p>;
}

function placeholder(view: FailureView): ReactNode {
  return (
    <p data-testid="placeholder">
      {view.name} | {view.reason} | {view.state} | gone={String(view.gone)}
    </p>
  );
}

/** Stands in for the whole app: if the boundary lets an error out, this is what would blank the page. */
class PageRoot extends Component<{ readonly children: ReactNode }, { crashed: boolean }> {
  override state = { crashed: false };
  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }
  override render(): ReactNode {
    return this.state.crashed ? <p data-testid="blank-page">page crashed</p> : this.props.children;
  }
}

function readyBank(ids: readonly string[], unavailable: readonly UnavailableElement[] = []): void {
  bankStore.set(
    readyBankState(
      bankIndex(
        ids.map((id) => bankElement(id)),
        { unavailable },
      ),
    ),
  );
}

interface Harness {
  readonly mounted: Mounted;
  readonly cleared: string[];
  readonly refreshes: { count: number };
  readonly available: { current: boolean };
}

const posted: { url: string; body: unknown }[] = [];
let unmountAfter: Mounted | null = null;

beforeEach(() => {
  localeStore.set('en');
  clearAssetHealth();
  resetClientErrorThrottle();
  posted.length = 0;
  installFetch((url, init) => {
    if (url !== CLIENT_ERRORS_ROUTE) throw new TypeError('unexpected fetch');
    posted.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  });
  readyBank([BANK_ID]);
});

afterEach(async () => {
  await unmountAfter?.unmount();
  unmountAfter = null;
  restoreFetch();
});

async function setup(initiallyAvailable: boolean): Promise<Harness> {
  const available = { current: initiallyAvailable };
  const cleared: string[] = [];
  const refreshes = { count: 0 };
  const mounted = await mount(
    <PageRoot>
      <AssetBoundary
        url={URL}
        bankId={BANK_ID}
        name="Caliper cradle"
        clearCache={(url) => cleared.push(url)}
        placeholder={placeholder}
        fallback={<p data-testid="loading">loading</p>}
        recovery={{
          refresh: () => {
            refreshes.count++;
            return Promise.resolve();
          },
        }}
      >
        <Model available={available} />
      </AssetBoundary>
    </PageRoot>,
  );
  unmountAfter = mounted;
  return { mounted, cleared, refreshes, available };
}

function text(mounted: Mounted, testId: string): string | null {
  return mounted.container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

withDomGlobals();

describe('AssetBoundary', () => {
  test('a model that 404s renders the named placeholder and the page survives', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const { mounted } = await setup(false);
    consoleError.mockRestore();

    expect(text(mounted, 'blank-page')).toBeNull();
    expect(text(mounted, 'model')).toBeNull();
    expect(text(mounted, 'placeholder')).toBe(
      'Caliper cradle | file not found (404) | retrying | gone=false',
    );
  });

  test('registers one failure record for the URL and logs it as an asset-load error', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    await setup(false);
    consoleError.mockRestore();

    expect(getFailure(URL)).toMatchObject({
      url: URL,
      bankId: BANK_ID,
      elementName: 'Caliper cradle',
      status: 404,
      kind: 'asset-missing',
      attempts: 1,
      state: 'retrying',
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toMatchObject({
      kind: 'asset-load',
      url: URL,
      bankId: BANK_ID,
      status: 404,
    });
  });

  test('a retry after the file is back clears the loader cache and draws the model', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await setup(false);
    expect(text(harness.mounted, 'placeholder')).not.toBeNull();

    harness.available.current = true;
    await act(async () => {
      requestRetry(URL);
    });
    consoleError.mockRestore();

    expect(harness.refreshes.count).toBe(1);
    expect(harness.cleared).toEqual([URL]);
    expect(text(harness.mounted, 'model')).toBe('model drawn');
    expect(text(harness.mounted, 'placeholder')).toBeNull();
    expect(getFailure(URL)).toMatchObject({ state: 'recovered', attempts: 1 });
  });

  test('a retry that fails again keeps the placeholder and counts the attempt', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await setup(false);
    await act(async () => {
      requestRetry(URL);
    });
    consoleError.mockRestore();

    expect(text(harness.mounted, 'blank-page')).toBeNull();
    expect(text(harness.mounted, 'placeholder')).not.toBeNull();
    expect(getFailure(URL)?.attempts).toBe(2);
    // Still one record, still one log entry (repeats of a known URL are not re-reported).
    expect(posted).toHaveLength(1);
  });

  test('if the refreshed index no longer has the element, the placeholder says so and retrying stops', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await setup(false);
    readyBank(['some-other-element']);
    await act(async () => {
      requestRetry(URL);
    });
    consoleError.mockRestore();

    expect(text(harness.mounted, 'placeholder')).toBe(
      'Caliper cradle | removed from the bank | failed | gone=true',
    );
    expect(harness.cleared).toEqual([]);
    expect(getFailure(URL)).toMatchObject({ gone: { kind: 'removed' }, nextRetryAt: null });
  });

  test('an element the index lists as unavailable shows the pipeline reason', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await setup(false);
    readyBank(
      [],
      [{ id: BANK_ID, name: { ru: 'Люлька', en: 'Cradle' }, reason: 'glb file is corrupt' }],
    );
    await act(async () => {
      requestRetry(URL);
    });
    consoleError.mockRestore();

    expect(text(harness.mounted, 'placeholder')).toContain('unavailable: glb file is corrupt');
  });

  test('a new URL from the refreshed index replaces the failed one and loads', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const harness = await setup(false);
    harness.available.current = true;
    const NEW_URL = '/bank/assets/glb/b00000000000000b.glb';
    await harness.mounted.render(
      <PageRoot>
        <AssetBoundary
          url={NEW_URL}
          bankId={BANK_ID}
          name="Caliper cradle"
          clearCache={(url) => harness.cleared.push(url)}
          placeholder={placeholder}
        >
          <Model available={harness.available} />
        </AssetBoundary>
      </PageRoot>,
    );
    consoleError.mockRestore();

    expect(text(harness.mounted, 'model')).toBe('model drawn');
    // The superseded URL leaves the health store, so its toast goes away with it.
    expect(getFailure(URL)).toBeUndefined();
  });

  test('the first automatic retry fires by itself after the backoff delay', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const harness = await setup(false);
      expect(harness.refreshes.count).toBe(0);
      harness.available.current = true;
      await act(async () => {
        vi.advanceTimersByTime(1_300);
      });
      expect(harness.refreshes.count).toBe(1);
      expect(text(harness.mounted, 'model')).toBe('model drawn');
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  test('two boundaries on the same URL are one attempt and one retry loop', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const available = { current: false };
      const refreshes = { count: 0 };
      const recovery = {
        refresh: () => {
          refreshes.count++;
          return Promise.resolve();
        },
      };
      const cleared: string[] = [];
      const one = (key: string) => (
        <AssetBoundary
          key={key}
          url={URL}
          bankId={BANK_ID}
          name="Caliper cradle"
          clearCache={(url) => cleared.push(url)}
          placeholder={placeholder}
          recovery={recovery}
        >
          <Model available={available} />
        </AssetBoundary>
      );
      const mounted = await mount(
        <PageRoot>
          {one('wall')}
          {one('ghost')}
          {one('preview')}
        </PageRoot>,
      );
      unmountAfter = mounted;

      // Three boundaries threw the same error: still attempt 1, still one log entry.
      expect(getFailure(URL)).toMatchObject({ attempts: 1, retries: 0 });
      expect(posted).toHaveLength(1);

      available.current = true;
      await act(async () => {
        vi.advanceTimersByTime(1_300);
      });
      // One timer fired, one refresh served all three boundaries, all three drew the model.
      expect(refreshes.count).toBe(1);
      expect(mounted.container.querySelectorAll('[data-testid="model"]')).toHaveLength(3);
      expect(getFailure(URL)).toMatchObject({ state: 'recovered', attempts: 1 });
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  test('six failed attempts take six real retries, however many boundaries watch the URL', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const refreshes = { count: 0 };
      const recovery = {
        refresh: () => {
          refreshes.count++;
          return Promise.resolve();
        },
      };
      const available = { current: false };
      const one = (key: string) => (
        <AssetBoundary
          key={key}
          url={URL}
          bankId={BANK_ID}
          name="Caliper cradle"
          clearCache={() => undefined}
          placeholder={placeholder}
          recovery={recovery}
        >
          <Model available={available} />
        </AssetBoundary>
      );
      const mounted = await mount(
        <PageRoot>
          {one('a')}
          {one('b')}
        </PageRoot>,
      );
      unmountAfter = mounted;
      for (let n = 0; n < 8; n++) {
        await act(async () => {
          vi.advanceTimersByTime(40_000);
        });
      }
      // Attempts stop at MAX + 1 failures: the initial one plus six retries; nothing is scheduled after that.
      expect(refreshes.count).toBe(6);
      expect(getFailure(URL)).toMatchObject({ attempts: 7, state: 'failed', nextRetryAt: null });
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  test('an element the index no longer lists is not retried automatically at all', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      readyBank(['some-other-element']);
      const refreshes = { count: 0 };
      const mounted = await mount(
        <PageRoot>
          <AssetBoundary
            url={URL}
            bankId={BANK_ID}
            name="Caliper cradle"
            clearCache={() => undefined}
            placeholder={placeholder}
            recovery={{
              refresh: () => {
                refreshes.count++;
                return Promise.resolve();
              },
            }}
          >
            <Model available={{ current: false }} />
          </AssetBoundary>
        </PageRoot>,
      );
      unmountAfter = mounted;
      await act(async () => {
        vi.advanceTimersByTime(120_000);
      });
      expect(refreshes.count).toBe(0);
      expect(text(mounted, 'placeholder')).toBe(
        'Caliper cradle | removed from the bank | failed | gone=true',
      );
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  test('a boundary mounting while a retry prepares reads the stale rejection without spending an attempt', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const { promise: refreshGate, resolve: finishRefresh } = Promise.withResolvers<void>();
    const available = { current: false };
    const recovery = { refresh: () => refreshGate };
    const cleared: string[] = [];
    const boundary = (key: string) => (
      <AssetBoundary
        key={key}
        url={URL}
        bankId={BANK_ID}
        name="Caliper cradle"
        clearCache={(url) => cleared.push(url)}
        placeholder={placeholder}
        recovery={recovery}
      >
        <Model available={available} />
      </AssetBoundary>
    );
    const mounted = await mount(<PageRoot>{boundary('first')}</PageRoot>);
    unmountAfter = mounted;

    // A retry starts; the index refresh is in flight and the loader cache still holds the rejection.
    await act(async () => {
      requestRetry(URL);
    });
    expect(getFailure(URL)).toMatchObject({ attempts: 1, state: 'retrying', nextRetryAt: null });
    // A new placement mounts and hits the same stale cached error.
    await mounted.render(
      <PageRoot>
        {boundary('first')}
        {boundary('late')}
      </PageRoot>,
    );
    expect(getFailure(URL)).toMatchObject({ attempts: 1, nextRetryAt: null });

    // The refresh finishes, the cache is cleared and the load really runs again (still failing): attempt 2.
    await act(async () => {
      finishRefresh();
    });
    consoleError.mockRestore();
    expect(cleared.length).toBeGreaterThan(0);
    expect(getFailure(URL)?.attempts).toBe(2);
    expect(getFailure(URL)?.nextRetryAt).not.toBeNull();
  });

  test('boundaries that left during the countdown and came back re-arm the automatic retry', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const available = { current: false };
      const refreshes = { count: 0 };
      const boundary = (
        <AssetBoundary
          url={URL}
          bankId={BANK_ID}
          name="Caliper cradle"
          clearCache={() => undefined}
          placeholder={placeholder}
          recovery={{
            refresh: () => {
              refreshes.count++;
              return Promise.resolve();
            },
          }}
        >
          <Model available={available} />
        </AssetBoundary>
      );
      const first = await mount(<PageRoot>{boundary}</PageRoot>);
      // Everything unmounts before the 1 s countdown ends (the timer goes with the last boundary)...
      await first.unmount();
      vi.advanceTimersByTime(5_000);
      expect(refreshes.count).toBe(0);
      // ...and a new boundary for the same URL meets the stale rejection: it must pick the retry up again.
      const second = await mount(<PageRoot>{boundary}</PageRoot>);
      unmountAfter = second;
      available.current = true;
      await act(async () => {
        vi.advanceTimersByTime(1_300);
      });
      expect(refreshes.count).toBe(1);
      expect(text(second, 'model')).toBe('model drawn');
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  test('a healthy model never touches the health store or the log', async () => {
    const harness = await setup(true);
    expect(text(harness.mounted, 'model')).toBe('model drawn');
    expect(getFailure(URL)).toBeUndefined();
    expect(posted).toHaveLength(0);
  });

  test('quiet boundaries (hover previews) register the failure without asking for a toast', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const mounted = await mount(
      <PageRoot>
        <AssetBoundary
          url={URL}
          name="Caliper cradle"
          quiet
          clearCache={() => undefined}
          placeholder={placeholder}
        >
          <Model available={{ current: false }} />
        </AssetBoundary>
      </PageRoot>,
    );
    unmountAfter = mounted;
    consoleError.mockRestore();
    expect(getFailure(URL)?.quiet).toBe(true);
    expect(text(mounted, 'placeholder')).not.toBeNull();
  });
});
