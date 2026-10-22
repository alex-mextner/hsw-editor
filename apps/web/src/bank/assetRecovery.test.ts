import { beforeEach, describe, expect, test, vi } from 'bun:test';
import { installFetch, restoreFetch } from '@/test/fetchStub.ts';
import { bankElement, bankIndex, readyBankState } from '@/test/fixtures.ts';
import { clearAssetHealth, getFailure, recordFailure } from './assetHealth.ts';
import {
  cancelAutoRetry,
  goneReasonFor,
  prepareRetry,
  registerRetryHandler,
  requestRetry,
  scheduleAutoRetry,
} from './assetRecovery.ts';
import { bankStore } from './client.ts';

const URL = '/bank/assets/glb/a47bacef44e3f4f4.glb';
const ID = 'caliper-cradle-slots1-beamwidth20';

function failIt(): void {
  recordFailure({
    url: URL,
    bankId: ID,
    status: 404,
    kind: 'asset-missing',
    message: '404',
  });
}

beforeEach(() => {
  clearAssetHealth();
  bankStore.set(readyBankState(bankIndex([bankElement(ID)])));
});

describe('goneReasonFor', () => {
  test('null while the element is published; null too when the bank is not loaded', () => {
    expect(goneReasonFor(ID)).toBeNull();
    bankStore.set({ status: 'loading' });
    expect(goneReasonFor('whatever')).toBeNull();
  });

  test('removed when absent, unavailable (with reason) when the index lists it', () => {
    expect(goneReasonFor('not-there')).toEqual({ kind: 'removed' });
    bankStore.set(
      readyBankState(
        bankIndex([], {
          unavailable: [{ id: ID, name: { ru: 'а', en: 'a' }, reason: 'glb missing' }],
        }),
      ),
    );
    expect(goneReasonFor(ID)).toEqual({ kind: 'unavailable', detail: 'glb missing' });
  });
});

describe('prepareRetry', () => {
  test('revalidates the index first, then says to reload when the element is still there', async () => {
    failIt();
    const order: string[] = [];
    const outcome = await prepareRetry(
      { url: URL, bankId: ID },
      {
        refresh: () => {
          order.push(`refresh:${getFailure(URL)?.state}`);
          return Promise.resolve();
        },
      },
    );
    expect(outcome).toEqual({ kind: 'reload' });
    // The countdown is over by the time the index is fetched.
    expect(order).toEqual(['refresh:retrying']);
    expect(getFailure(URL)?.nextRetryAt).toBeNull();
  });

  test('uses the index the refresh just delivered: element gone => stop for good and remember why', async () => {
    failIt();
    const outcome = await prepareRetry(
      { url: URL, bankId: ID },
      {
        refresh: () => {
          bankStore.set(readyBankState(bankIndex([])));
          return Promise.resolve();
        },
      },
    );
    expect(outcome).toEqual({ kind: 'gone', gone: { kind: 'removed' } });
    expect(getFailure(URL)).toMatchObject({ state: 'failed', gone: { kind: 'removed' } });
  });

  test('concurrent callers for one URL share one refresh and one outcome', async () => {
    failIt();
    let refreshes = 0;
    const deps = {
      refresh: () => {
        refreshes++;
        return Promise.resolve();
      },
    };
    const [a, b, c] = await Promise.all([
      prepareRetry({ url: URL, bankId: ID }, deps),
      prepareRetry({ url: URL, bankId: ID }, deps),
      prepareRetry({ url: URL, bankId: ID }, deps),
    ]);
    expect(refreshes).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // A later retry is a new run.
    await prepareRetry({ url: URL, bankId: ID }, deps);
    expect(refreshes).toBe(2);
  });

  test('a retry after the element came back drops the stale "gone" verdict', async () => {
    failIt();
    await prepareRetry(
      { url: URL, bankId: ID },
      {
        refresh: () => {
          bankStore.set(readyBankState(bankIndex([])));
          return Promise.resolve();
        },
      },
    );
    expect(getFailure(URL)?.gone).toEqual({ kind: 'removed' });
    const outcome = await prepareRetry(
      { url: URL, bankId: ID },
      {
        refresh: () => {
          bankStore.set(readyBankState(bankIndex([bankElement(ID)])));
          return Promise.resolve();
        },
      },
    );
    expect(outcome).toEqual({ kind: 'reload' });
    expect(getFailure(URL)).toMatchObject({ state: 'retrying' });
    expect(getFailure(URL)?.gone).toBeUndefined();
  });

  test('assets that are not bank elements (photos) skip the index and just reload', async () => {
    let refreshed = false;
    const outcome = await prepareRetry(
      { url: '/api/walls/w/photos/p' },
      {
        refresh: () => {
          refreshed = true;
          return Promise.resolve();
        },
      },
    );
    expect(outcome).toEqual({ kind: 'reload' });
    expect(refreshed).toBe(false);
  });
});

describe('retry handler registry', () => {
  test('requestRetry reaches every boundary registered for the URL until it unregisters', () => {
    const calls: string[] = [];
    const offA = registerRetryHandler(URL, () => calls.push('a'));
    const offB = registerRetryHandler(URL, () => calls.push('b'));
    registerRetryHandler('/other', () => calls.push('other'));
    requestRetry(URL);
    expect(calls).toEqual(['a', 'b']);
    offA();
    offB();
    calls.length = 0;
    // Nothing mounted for the URL any more: falls back to refreshing the index (network is not asserted here).
    installFetch(() => {
      throw new TypeError('offline');
    });
    try {
      requestRetry(URL);
    } finally {
      restoreFetch();
    }
    expect(calls).toEqual([]);
  });
});

describe('auto retry timer', () => {
  test('fires one requestRetry per URL however often it is rescheduled', () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const off = registerRetryHandler(URL, () => calls.push('handler'));
      scheduleAutoRetry(URL, 1_000);
      scheduleAutoRetry(URL, 1_000);
      scheduleAutoRetry(URL, 2_000);
      vi.advanceTimersByTime(1_500);
      expect(calls).toEqual([]);
      vi.advanceTimersByTime(600);
      expect(calls).toEqual(['handler']);
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  test('is cancelled when the last boundary of the URL goes away, or explicitly', () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const off = registerRetryHandler(URL, () => calls.push('a'));
      scheduleAutoRetry(URL, 1_000);
      off();
      vi.advanceTimersByTime(5_000);
      expect(calls).toEqual([]);

      const off2 = registerRetryHandler(URL, () => calls.push('b'));
      scheduleAutoRetry(URL, 1_000);
      cancelAutoRetry(URL);
      vi.advanceTimersByTime(5_000);
      expect(calls).toEqual([]);
      off2();
    } finally {
      vi.useRealTimers();
    }
  });
});
