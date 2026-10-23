import { createValueStore } from '#state-backend';
import { backoffDelayMs, isRetryable, type LoadErrorKind } from './loadErrors.ts';

/**
 * Which asset URLs are failing right now, one record per URL (many placements, previews and tabs of
 * the UI hitting the same 404 collapse into a single record, a single toast and a single retry loop).
 */

export type AssetState = 'retrying' | 'failed' | 'recovered';

/** Why automatic retry was given up on although the URL might still be fixable by the user/pipeline. */
export type AssetGoneReason =
  | { readonly kind: 'removed' }
  | { readonly kind: 'unavailable'; readonly detail: string };

export interface AssetFailure {
  readonly url: string;
  readonly bankId?: string;
  readonly elementName?: string;
  readonly status?: number;
  readonly kind: LoadErrorKind;
  /** Failed loads so far (the first failure is 1). */
  readonly attempts: number;
  /** Retries started so far; a failure counts as a new attempt only once `retries` has caught up with `attempts`. */
  readonly retries: number;
  readonly state: AssetState;
  /** Epoch ms of the next automatic attempt; null when none is scheduled. */
  readonly nextRetryAt: number | null;
  readonly message: string;
  /** Only seen by boundaries that must not interrupt the user (hover previews): no toast. */
  readonly quiet: boolean;
  readonly gone?: AssetGoneReason;
  readonly firstFailedAt: number;
  readonly lastFailedAt: number;
}

export interface FailureInput {
  readonly url: string;
  readonly bankId?: string;
  readonly elementName?: string;
  readonly status?: number;
  readonly kind: LoadErrorKind;
  readonly message: string;
  readonly quiet?: boolean;
  /** Present when the current bank index says the element is gone: no automatic retry is scheduled. */
  readonly gone?: AssetGoneReason;
}

export interface FailureClock {
  readonly now: () => number;
  readonly jitter: () => number;
}

const realClock: FailureClock = { now: () => Date.now(), jitter: () => Math.random() };

export const assetHealthStore = createValueStore<ReadonlyMap<string, AssetFailure>>(new Map());

function put(record: AssetFailure): void {
  const next = new Map(assetHealthStore.get());
  next.set(record.url, record);
  assetHealthStore.set(next);
}

export function getFailure(url: string): AssetFailure | undefined {
  return assetHealthStore.get().get(url);
}

export interface RecordedFailure {
  readonly record: AssetFailure;
  /** First failure of this URL (or first since it recovered): the caller shows its one toast. */
  readonly isNew: boolean;
  /** The failure moved on (new attempt or new record): the caller (re)schedules the automatic retry. */
  readonly advanced: boolean;
}

/**
 * Registers a failed load. Many boundaries can fail on one URL at the same time (wall group, ghost,
 * previews all read the same cached rejection); only a failure that follows a started retry is a new
 * attempt, so the six automatic attempts are six real network tries. The next automatic attempt
 * follows the backoff table until it runs out (or the error is not retryable, or the element is gone).
 */
export function recordFailure(
  input: FailureInput,
  clock: FailureClock = realClock,
): RecordedFailure {
  const now = clock.now();
  const previous = getFailure(input.url);
  if (
    previous !== undefined &&
    previous.state !== 'recovered' &&
    previous.retries < previous.attempts
  ) {
    // The same failure seen by another boundary: nothing new happened. One loud boundary is enough to
    // make the URL's toast worth showing, so quietness only ever goes away.
    if (previous.quiet && input.quiet !== true) {
      const loud = { ...previous, quiet: false };
      put(loud);
      return { record: loud, isNew: false, advanced: false };
    }
    return { record: previous, isNew: false, advanced: false };
  }
  const continuing = previous !== undefined && previous.state !== 'recovered';
  const attempts = continuing ? previous.attempts + 1 : 1;
  const delay =
    input.gone === undefined && isRetryable(input.kind)
      ? // `attempts` counts failures from 1, the backoff table is indexed from 0.
        backoffDelayMs(attempts - 1, clock.jitter)
      : null;
  const record: AssetFailure = {
    url: input.url,
    ...(input.bankId === undefined ? {} : { bankId: input.bankId }),
    ...(input.elementName === undefined ? {} : { elementName: input.elementName }),
    ...(input.status === undefined ? {} : { status: input.status }),
    kind: input.kind,
    attempts,
    retries: continuing ? previous.retries : 0,
    state: delay === null ? 'failed' : 'retrying',
    nextRetryAt: delay === null ? null : now + delay,
    message: input.message,
    quiet: (input.quiet ?? false) && (!continuing || previous.quiet),
    ...(input.gone === undefined ? {} : { gone: input.gone }),
    firstFailedAt: continuing ? previous.firstFailedAt : now,
    lastFailedAt: now,
  };
  put(record);
  return { record, isNew: !continuing, advanced: true };
}

/**
 * A retry has begun (idempotent across boundaries): the countdown is over. The verdict "gone" is
 * dropped, because the refreshed index decides it again.
 */
export function markRetrying(url: string): void {
  const record = getFailure(url);
  if (!record || record.state === 'recovered') return;
  const { gone: _verdict, ...rest } = record;
  put({ ...rest, state: 'retrying', nextRetryAt: null });
}

/**
 * The loader cache was cleared and the load is about to run again: only from here on is a failure a
 * new attempt. Until then a boundary mounting against the stale cached rejection is a duplicate.
 */
export function markReloading(url: string): void {
  const record = getFailure(url);
  if (!record || record.state === 'recovered' || record.retries === record.attempts) return;
  put({ ...record, retries: record.attempts });
}

export function markRecovered(url: string): AssetFailure | undefined {
  const record = getFailure(url);
  if (!record || record.state === 'recovered') return undefined;
  const recovered: AssetFailure = { ...record, state: 'recovered', nextRetryAt: null };
  put(recovered);
  return recovered;
}

/** The element is gone from the bank (or flagged unavailable): stop retrying, keep the reason. */
export function markGone(url: string, gone: AssetGoneReason): void {
  const record = getFailure(url);
  if (!record || record.state === 'recovered') return;
  put({ ...record, state: 'failed', nextRetryAt: null, gone });
}

/** The URL is no longer in use (the element points at another file now): drop its record and toast. */
export function forgetFailure(url: string): void {
  const records = assetHealthStore.get();
  if (!records.has(url)) return;
  const next = new Map(records);
  next.delete(url);
  assetHealthStore.set(next);
}

/** Forgets every record (tests). */
export function clearAssetHealth(): void {
  assetHealthStore.set(new Map());
}
