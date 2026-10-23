import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { BankIndex } from '@hsw-editor/bank';
import { installFetch, restoreFetch } from '@/test/fetchStub.ts';
import { bankElement, bankIndex } from '@/test/fixtures.ts';
import {
  BANK_POLL_INTERVAL_MS,
  bankCheckStore,
  bankRoutes,
  bankStore,
  lastKnownElement,
  refreshBank,
  startBankAutoRefresh,
  unavailableElements,
  type UnavailableElement,
  type AutoRefreshDocument,
  type AutoRefreshWindow,
} from './client.ts';

function indexOf(
  hash: string,
  ids: readonly string[],
  unavailable?: readonly UnavailableElement[],
): BankIndex {
  return bankIndex(
    ids.map((id) => bankElement(id)),
    {
      hash,
      ...(unavailable === undefined ? {} : { unavailable }),
    },
  );
}

interface FetchCall {
  readonly url: string;
  readonly cache: RequestCache | undefined;
}

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  installFetch((url, init) => {
    const call = { url, cache: init?.cache };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  bankStore.set({ status: 'loading' });
  bankCheckStore.set({ lastCheckedAt: null, checking: false });
});
afterEach(() => {
  restoreFetch();
});

describe('refreshBank', () => {
  test('the first load makes the store ready and stamps lastCheckedAt', async () => {
    const calls = stubFetch(() => json(indexOf('h1', ['a', 'b'])));
    await refreshBank();
    const state = bankStore.get();
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect([...state.byId.keys()]).toEqual(['a', 'b']);
    expect(calls).toEqual([{ url: bankRoutes.index, cache: 'no-cache' }]);
    expect(bankCheckStore.get().lastCheckedAt).not.toBeNull();
    expect(bankCheckStore.get().checking).toBe(false);
  });

  test('an unchanged contentHash leaves the store object untouched', async () => {
    stubFetch(() => json(indexOf('h1', ['a'])));
    await refreshBank();
    const before = bankStore.get();
    const checkedBefore = bankCheckStore.get().lastCheckedAt;
    // Same hash, even if the payload object is a different instance.
    await refreshBank();
    expect(bankStore.get()).toBe(before);
    expect(bankCheckStore.get().lastCheckedAt ?? 0).toBeGreaterThanOrEqual(checkedBefore ?? 0);
  });

  test('a changed contentHash replaces the index and remembers trimmed elements', async () => {
    stubFetch(() => json(indexOf('h1', ['a', 'gone'])));
    await refreshBank();
    stubFetch(() => json(indexOf('h2', ['a'])));
    await refreshBank();
    const state = bankStore.get();
    expect(state.status === 'ready' && state.index.contentHash).toBe('h2');
    expect(state.status === 'ready' && state.byId.has('gone')).toBe(false);
    // The wall can still draw "gone" at its real size and name it in the placeholder.
    expect(lastKnownElement('gone')?.id).toBe('gone');
  });

  test('a failed refetch keeps the ready state (network error and HTTP error)', async () => {
    stubFetch(() => json(indexOf('h1', ['a'])));
    await refreshBank();
    const before = bankStore.get();

    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await refreshBank();
    expect(bankStore.get()).toBe(before);

    stubFetch(() => new Response('nope', { status: 503 }));
    await refreshBank();
    expect(bankStore.get()).toBe(before);
    expect(bankCheckStore.get().checking).toBe(false);
  });

  test('a garbage 200 is rejected instead of replacing a good index', async () => {
    stubFetch(() => json(indexOf('h1', ['a'])));
    await refreshBank();
    const before = bankStore.get();
    stubFetch(() => json({ hello: 'world' }));
    await refreshBank();
    expect(bankStore.get()).toBe(before);
  });

  test('only the very first load can put the store into the error state', async () => {
    stubFetch(() => new Response('down', { status: 502 }));
    await refreshBank();
    expect(bankStore.get()).toEqual({ status: 'error', message: 'HTTP 502' });
    // ...and it recovers by itself on the next successful check.
    stubFetch(() => json(indexOf('h1', ['a'])));
    await refreshBank();
    expect(bankStore.get().status).toBe('ready');
  });

  test('concurrent refreshes share one request; a forced one goes again with a full reload', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const calls = stubFetch(async () => {
      await gate;
      return json(indexOf('h1', ['a']));
    });
    const first = refreshBank();
    const second = refreshBank();
    const forced = refreshBank({ force: true });
    release();
    await Promise.all([first, second, forced]);
    expect(calls.map((call) => call.cache)).toEqual(['no-cache', 'reload']);
  });
});

describe('unavailableElements', () => {
  test('is empty when the server does not send the list', () => {
    expect(unavailableElements(indexOf('h', []))).toEqual([]);
  });

  test('returns the listed elements and ignores malformed entries', () => {
    const entry = { id: 'x', name: { ru: 'Икс', en: 'X' }, reason: 'glb missing' };
    // Hand-built wire payload: whatever the server sent, entries that are not objects with an id are dropped.
    const wire = { ...indexOf('h', []), unavailable: [entry, null, 'junk', { nope: 1 }] };
    expect(unavailableElements(wire)).toEqual([entry]);
  });
});

class FakeTarget implements AutoRefreshWindow, AutoRefreshDocument {
  visibilityState = 'visible';
  readonly listeners = new Map<string, Set<() => void>>();
  interval: { handler: () => void; ms: number } | null = null;
  cleared = false;
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  setInterval(handler: () => void, ms: number): number {
    this.interval = { handler, ms };
    return 1;
  }
  clearInterval(): void {
    this.cleared = true;
  }
  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('startBankAutoRefresh', () => {
  /** Resolves when the running check finishes (the store flips `checking` back to false). */
  function checkDone(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const stop = bankCheckStore.subscribe(() => {
      if (!bankCheckStore.get().checking) {
        stop();
        resolve();
      }
    });
    return promise;
  }

  /** A few microtask hops: enough for a check that is NOT supposed to start to have shown itself. */
  async function quiet(): Promise<void> {
    for (let hop = 0; hop < 10; hop++) await Promise.resolve();
  }

  test('revalidates on focus, visibility, online and every five minutes; stop removes everything', async () => {
    const calls = stubFetch(() => json(indexOf('h1', ['a'])));
    const win = new FakeTarget();
    const doc = new FakeTarget();
    let clock = 1_000_000;
    const stop = startBankAutoRefresh(win, doc, () => clock);
    expect(win.interval?.ms).toBe(BANK_POLL_INTERVAL_MS);

    clock += 10_000;
    let done = checkDone();
    win.emit('focus');
    await done;
    await quiet();
    expect(calls).toHaveLength(1);

    clock += 10_000;
    done = checkDone();
    doc.emit('visibilitychange');
    await done;
    await quiet();
    expect(calls).toHaveLength(2);

    clock += 10_000;
    done = checkDone();
    win.emit('online');
    await done;
    await quiet();
    expect(calls).toHaveLength(3);

    done = checkDone();
    win.interval?.handler();
    await done;
    await quiet();
    expect(calls).toHaveLength(4);

    stop();
    expect(win.count('focus') + win.count('online') + doc.count('visibilitychange')).toBe(0);
    expect(win.cleared).toBe(true);
  });

  test('a hidden tab does not poll on visibilitychange, and a burst of events checks once', async () => {
    const calls = stubFetch(() => json(indexOf('h1', ['a'])));
    const win = new FakeTarget();
    const doc = new FakeTarget();
    let clock = 1_000_000;
    startBankAutoRefresh(win, doc, () => clock);

    clock += 60_000;
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    await quiet();
    expect(calls).toHaveLength(0);

    const done = checkDone();
    doc.visibilityState = 'visible';
    doc.emit('visibilitychange');
    win.emit('focus');
    win.emit('online');
    await done;
    await quiet();
    expect(calls).toHaveLength(1);
  });
});
