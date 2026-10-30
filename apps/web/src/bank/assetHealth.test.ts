import { beforeEach, describe, expect, test } from 'bun:test';
import {
  assetHealthStore,
  clearAssetHealth,
  forgetFailure,
  getFailure,
  markGone,
  markRecovered,
  markReloading,
  markRetrying,
  recordFailure,
  type FailureInput,
} from './assetHealth.ts';
import { MAX_AUTO_ATTEMPTS } from './loadErrors.ts';

const URL_A = '/bank/assets/glb/a47bacef44e3f4f4.glb';
const input: FailureInput = {
  url: URL_A,
  bankId: 'caliper-cradle-slots1-beamwidth20',
  elementName: 'Caliper cradle',
  status: 404,
  kind: 'asset-missing',
  message: `fetch for "${URL_A}" responded with 404: Not Found`,
};

let clock = 1_000;
const fixed = { now: () => clock, jitter: () => 0 };

/** One real retry cycle: a retry starts, the loader cache is cleared, then the load fails again. */
function failAfterRetry(patch: Partial<FailureInput> = {}) {
  markRetrying(URL_A);
  markReloading(URL_A);
  return recordFailure({ ...input, ...patch }, fixed);
}

beforeEach(() => {
  clearAssetHealth();
  clock = 1_000;
});

describe('asset health store', () => {
  test('the first failure creates a retrying record with the first backoff step', () => {
    const { record, isNew, advanced } = recordFailure(input, fixed);
    expect(isNew).toBe(true);
    expect(advanced).toBe(true);
    expect(record).toMatchObject({
      url: URL_A,
      bankId: 'caliper-cradle-slots1-beamwidth20',
      elementName: 'Caliper cradle',
      status: 404,
      attempts: 1,
      retries: 0,
      state: 'retrying',
      nextRetryAt: 2_000,
    });
    expect(getFailure(URL_A)).toBe(record);
  });

  test('several boundaries failing on one URL are ONE attempt, not one each', () => {
    const first = recordFailure(input, fixed);
    clock = 1_500;
    const second = recordFailure(input, fixed);
    const third = recordFailure(input, fixed);
    expect(second).toMatchObject({ isNew: false, advanced: false });
    expect(third.record).toBe(first.record);
    expect(assetHealthStore.get().size).toBe(1);
    expect(getFailure(URL_A)).toMatchObject({ attempts: 1, nextRetryAt: 2_000 });
  });

  test('a failure after a started retry is the next attempt and walks up the backoff table', () => {
    recordFailure(input, fixed);
    clock = 3_000;
    const { record, isNew, advanced } = failAfterRetry();
    expect(isNew).toBe(false);
    expect(advanced).toBe(true);
    expect(record.attempts).toBe(2);
    expect(record.nextRetryAt).toBe(3_000 + 2_000);
    expect(record.firstFailedAt).toBe(1_000);
    expect(record.lastFailedAt).toBe(3_000);
    // Other boundaries reporting the same second failure change nothing.
    expect(recordFailure(input, fixed).advanced).toBe(false);
    expect(getFailure(URL_A)?.attempts).toBe(2);
  });

  test('after the automatic attempts are used up the record is failed and nothing is scheduled', () => {
    let last = recordFailure(input, fixed).record;
    // Failure number MAX_AUTO_ATTEMPTS still schedules the last automatic attempt...
    for (let n = 2; n <= MAX_AUTO_ATTEMPTS; n++) last = failAfterRetry().record;
    expect(last.state).toBe('retrying');
    expect(last.nextRetryAt).not.toBeNull();
    // ...and the one after that is manual-only.
    last = failAfterRetry().record;
    expect(last.attempts).toBe(MAX_AUTO_ATTEMPTS + 1);
    expect(last.state).toBe('failed');
    expect(last.nextRetryAt).toBeNull();
  });

  test('a stale cached rejection met while a retry is still preparing is not a new attempt', () => {
    recordFailure(input, fixed);
    // The retry started (index refresh in flight) but the loader cache is not cleared yet:
    markRetrying(URL_A);
    const stale = recordFailure(input, fixed);
    expect(stale).toMatchObject({ advanced: false, isNew: false });
    expect(getFailure(URL_A)).toMatchObject({ attempts: 1, nextRetryAt: null });
    // Once the cache is cleared and the load really runs again, its failure counts.
    markReloading(URL_A);
    expect(recordFailure(input, fixed)).toMatchObject({ advanced: true });
    expect(getFailure(URL_A)?.attempts).toBe(2);
  });

  test('markReloading is idempotent and ignores unknown or recovered URLs', () => {
    markReloading('/nope');
    recordFailure(input, fixed);
    markReloading(URL_A);
    markReloading(URL_A);
    expect(getFailure(URL_A)?.retries).toBe(1);
    markRecovered(URL_A);
    markReloading(URL_A);
    expect(getFailure(URL_A)?.state).toBe('recovered');
  });

  test('a manual retry on an exhausted record is one more real attempt', () => {
    recordFailure(input, fixed);
    for (let n = 2; n <= MAX_AUTO_ATTEMPTS + 1; n++) failAfterRetry();
    expect(getFailure(URL_A)?.state).toBe('failed');
    const { record } = failAfterRetry();
    expect(record.attempts).toBe(MAX_AUTO_ATTEMPTS + 2);
    expect(record.state).toBe('failed');
  });

  test('a decode error is never retried automatically', () => {
    const { record } = recordFailure({ ...input, kind: 'decode' }, fixed);
    expect(record.state).toBe('failed');
    expect(record.nextRetryAt).toBeNull();
  });

  test('markRetrying clears the countdown; markRecovered closes the record', () => {
    recordFailure(input, fixed);
    markRetrying(URL_A);
    expect(getFailure(URL_A)).toMatchObject({ state: 'retrying', nextRetryAt: null, retries: 0 });
    const recovered = markRecovered(URL_A);
    expect(recovered).toMatchObject({ state: 'recovered', nextRetryAt: null, attempts: 1 });
    // Closing twice is harmless and reports nothing new.
    expect(markRecovered(URL_A)).toBeUndefined();
  });

  test('a failure after recovery is a brand-new failure (new toast, attempts restart)', () => {
    recordFailure(input, fixed);
    markRecovered(URL_A);
    clock = 9_000;
    const { record, isNew } = recordFailure(input, fixed);
    expect(isNew).toBe(true);
    expect(record.attempts).toBe(1);
    expect(record.retries).toBe(0);
    expect(record.firstFailedAt).toBe(9_000);
  });

  test('markGone stops auto retry; the next retry re-judges, so a returned element recovers', () => {
    recordFailure(input, fixed);
    markGone(URL_A, { kind: 'removed' });
    expect(getFailure(URL_A)).toMatchObject({
      state: 'failed',
      nextRetryAt: null,
      gone: { kind: 'removed' },
    });
    // The element is back in the index: the caller no longer passes `gone`, and retrying works again.
    const { record } = failAfterRetry();
    expect(record.gone).toBeUndefined();
    expect(record.state).toBe('retrying');
    expect(record.nextRetryAt).not.toBeNull();
  });

  test('a failure reported with a gone verdict never schedules an automatic retry', () => {
    const { record } = recordFailure({ ...input, gone: { kind: 'removed' } }, fixed);
    expect(record).toMatchObject({ state: 'failed', nextRetryAt: null, gone: { kind: 'removed' } });
  });

  test('operations on unknown URLs are no-ops', () => {
    markRetrying('/nope');
    markGone('/nope', { kind: 'removed' });
    forgetFailure('/nope');
    expect(markRecovered('/nope')).toBeUndefined();
    expect(assetHealthStore.get().size).toBe(0);
  });

  test('forgetFailure drops a superseded URL', () => {
    recordFailure(input, fixed);
    forgetFailure(URL_A);
    expect(getFailure(URL_A)).toBeUndefined();
  });

  test('a loud boundary un-quiets a record first seen by a quiet one, but never the reverse', () => {
    recordFailure({ ...input, quiet: true }, fixed);
    expect(getFailure(URL_A)?.quiet).toBe(true);
    recordFailure({ ...input, quiet: false }, fixed);
    expect(getFailure(URL_A)?.quiet).toBe(false);
    recordFailure({ ...input, quiet: true }, fixed);
    expect(getFailure(URL_A)?.quiet).toBe(false);
    // ...and across a counted attempt as well.
    expect(failAfterRetry({ quiet: true }).record.quiet).toBe(false);
  });

  test('every change publishes a new map so subscribers re-render', async () => {
    let notifications = 0;
    const stop = assetHealthStore.subscribe(() => notifications++);
    recordFailure(input, fixed);
    markRetrying(URL_A);
    markRecovered(URL_A);
    await Promise.resolve();
    stop();
    expect(notifications).toBe(3);
  });
});
