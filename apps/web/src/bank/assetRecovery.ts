import { markGone, markRetrying, type AssetGoneReason } from './assetHealth.ts';
import { bankStore, refreshBank, unavailableElements } from './client.ts';

/**
 * What a retry of a failed asset does before the loader is asked again: revalidate the bank index
 * (the 404 usually means this tab holds a stale one), then decide whether the element still exists.
 * The UI part (clearing the loader cache, resetting the boundary) stays with the boundary. Several
 * boundaries can show the same URL; they share one retry loop, one timer and one index refresh.
 */

export interface RetryTarget {
  readonly url: string;
  /** Bank element the asset belongs to; absent for assets that are not bank elements (photos, models). */
  readonly bankId?: string;
}

export type RetryOutcome =
  | { readonly kind: 'reload' }
  | { readonly kind: 'gone'; readonly gone: AssetGoneReason };

export interface RecoveryDeps {
  readonly refresh: () => Promise<void>;
}

const liveDeps: RecoveryDeps = { refresh: () => refreshBank({ force: true }) };

/** Why an element can no longer be loaded from the current index, or null when it is still published. */
export function goneReasonFor(bankId: string): AssetGoneReason | null {
  const state = bankStore.get();
  if (state.status !== 'ready') return null;
  const listed = unavailableElements(state.index).find((entry) => entry.id === bankId);
  if (listed) return { kind: 'unavailable', detail: listed.reason };
  if (!state.byId.has(bankId)) return { kind: 'removed' };
  return null;
}

const preparing = new Map<string, Promise<RetryOutcome>>();

/** Runs the pre-retry steps once per URL at a time; concurrent callers get the same outcome. */
export function prepareRetry(
  target: RetryTarget,
  deps: RecoveryDeps = liveDeps,
): Promise<RetryOutcome> {
  const running = preparing.get(target.url);
  if (running) return running;
  const run = (async (): Promise<RetryOutcome> => {
    markRetrying(target.url);
    if (target.bankId === undefined) return { kind: 'reload' };
    await deps.refresh();
    const gone = goneReasonFor(target.bankId);
    if (gone === null) return { kind: 'reload' };
    // Recorded here, not by the caller: the refreshed index usually re-renders the owner of the failed
    // boundary away before this function returns.
    markGone(target.url, gone);
    return { kind: 'gone', gone };
  })().finally(() => {
    preparing.delete(target.url);
  });
  preparing.set(target.url, run);
  return run;
}

type RetryHandler = () => void;
const handlers = new Map<string, Set<RetryHandler>>();
const timers = new Map<string, Parameters<typeof clearTimeout>[0]>();

function cancelTimer(url: string): void {
  clearTimeout(timers.get(url));
  timers.delete(url);
}

/** A mounted boundary offers its "retry now" here so a toast button can reach it. Returns the unregister function. */
export function registerRetryHandler(url: string, handler: RetryHandler): () => void {
  const set = handlers.get(url) ?? new Set();
  set.add(handler);
  handlers.set(url, set);
  return () => {
    set.delete(handler);
    if (set.size > 0) return;
    handlers.delete(url);
    // Nobody left to draw the result: the countdown has no purpose.
    cancelTimer(url);
  };
}

/** Manual retry of one URL; with no mounted boundary left it still refreshes the index. */
export function requestRetry(url: string): void {
  cancelTimer(url);
  const set = handlers.get(url);
  if (!set || set.size === 0) {
    void refreshBank({ force: true });
    return;
  }
  for (const handler of [...set]) handler();
}

/** The single automatic retry of a URL, `delayMs` from now; replaces a pending one. */
export function scheduleAutoRetry(url: string, delayMs: number): void {
  cancelTimer(url);
  timers.set(
    url,
    setTimeout(() => requestRetry(url), Math.max(0, delayMs)),
  );
}

/** Whether an automatic retry is waiting for this URL. */
export function hasPendingAutoRetry(url: string): boolean {
  return timers.has(url);
}

/** Whether a retry preparation is running for this URL. */
export function hasPendingRetry(url: string): boolean {
  return preparing.has(url);
}

/** Drops a pending automatic retry (the URL recovered or was superseded). */
export function cancelAutoRetry(url: string): void {
  cancelTimer(url);
}
