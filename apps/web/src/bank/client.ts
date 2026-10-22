import { createValueStore } from '#state-backend';
import type { BankElement, BankIndex, VariantResponse } from '@hsw-editor/bank';

/** Route table of the bank API (see docs/api.md); the only place that knows the URLs. */
export const bankRoutes = {
  index: '/api/bank/index',
  asset: (path: string): string => `/bank/assets/${path}`,
  variant: (id: string): string => `/api/bank/elements/${encodeURIComponent(id)}/variant`,
} as const;

export type BankState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly index: BankIndex;
      readonly byId: ReadonlyMap<string, BankElement>;
    };

export const bankStore = createValueStore<BankState>({ status: 'loading' });

/** Elements ever seen in a loaded index, so a wall can still draw a trimmed element at its real size. */
const lastKnown = new Map<string, BankElement>();

export function lastKnownElement(id: string): BankElement | undefined {
  return lastKnown.get(id);
}

/** Bank elements the pipeline refused to publish (missing/corrupt files); absent on older servers. */
export interface UnavailableElement {
  readonly id: string;
  readonly name: { readonly ru: string; readonly en: string };
  readonly reason: string;
}

/** Reads the list defensively: it comes off the wire and may be absent or malformed. */
export function unavailableElements(index: object): readonly UnavailableElement[] {
  if (!('unavailable' in index) || !Array.isArray(index.unavailable)) return [];
  return index.unavailable.filter(
    (entry): entry is UnavailableElement =>
      typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string',
  );
}

/** When the index was last confirmed with the server, and whether a check is running now. */
export interface BankCheck {
  readonly lastCheckedAt: number | null;
  readonly checking: boolean;
}

export const bankCheckStore = createValueStore<BankCheck>({ lastCheckedAt: null, checking: false });

export interface RefreshOptions {
  /** Bypass the HTTP cache entirely (a retry after a failed asset); otherwise a cheap ETag revalidation. */
  readonly force?: boolean;
}

function parseIndex(body: unknown): BankIndex {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('elements' in body) ||
    !Array.isArray(body.elements) ||
    !('contentHash' in body) ||
    typeof body.contentHash !== 'string'
  ) {
    throw new Error('Invalid bank index');
  }
  return body as BankIndex;
}

let inflight: Promise<void> | null = null;

async function fetchAndApply(force: boolean): Promise<void> {
  bankCheckStore.set({ ...bankCheckStore.get(), checking: true });
  try {
    // `no-cache` = always revalidate with the ETag: unchanged costs a 304, changed brings the new index.
    const response = await fetch(bankRoutes.index, { cache: force ? 'reload' : 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const index = parseIndex(await response.json());
    const current = bankStore.get();
    // Same content: keep the existing state object so nothing downstream re-renders or rebuilds.
    if (current.status !== 'ready' || current.index.contentHash !== index.contentHash) {
      for (const element of index.elements) lastKnown.set(element.id, element);
      bankStore.set({
        status: 'ready',
        index,
        byId: new Map(index.elements.map((element) => [element.id, element])),
      });
    }
    bankCheckStore.set({ lastCheckedAt: Date.now(), checking: false });
  } catch (error) {
    bankCheckStore.set({ ...bankCheckStore.get(), checking: false });
    // A failed refetch must not take a working bank away; only the very first load can fail visibly.
    if (bankStore.get().status !== 'ready') {
      bankStore.set({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Loads the bank index, or revalidates the one in memory. Concurrent calls share one request (a forced
 * call waits for a running one and then goes again, so it never settles for an older answer). The
 * store only changes when `contentHash` does; a failed refetch keeps the old ready state.
 */
export function refreshBank(options: RefreshOptions = {}): Promise<void> {
  const force = options.force === true;
  if (inflight && !force) return inflight;
  const run = (inflight ?? Promise.resolve()).then(() => fetchAndApply(force));
  const tracked = run.finally(() => {
    if (inflight === tracked) inflight = null;
  });
  inflight = tracked;
  return tracked;
}

export const BANK_POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Focus, visibility and online usually fire together; one check is enough. */
const EVENT_COOLDOWN_MS = 5000;

/** The slice of `window` / `document` the auto-refresh uses; real ones satisfy it, tests pass fakes. */
interface Listenable {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface AutoRefreshWindow extends Listenable {
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
}
export interface AutoRefreshDocument extends Listenable {
  readonly visibilityState: string;
}

/**
 * Keeps the index fresh for a long-lived tab: revalidates on window focus, when the tab becomes
 * visible, when the network comes back, and every five minutes. Returns the stop function.
 */
export function startBankAutoRefresh(
  win: AutoRefreshWindow = window,
  doc: AutoRefreshDocument = document,
  now: () => number = Date.now,
): () => void {
  let lastAttempt = now();
  const check = () => {
    lastAttempt = now();
    void refreshBank();
  };
  const onEvent = () => {
    if (now() - lastAttempt >= EVENT_COOLDOWN_MS) check();
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'visible') onEvent();
  };
  win.addEventListener('focus', onEvent);
  win.addEventListener('online', onEvent);
  doc.addEventListener('visibilitychange', onVisibility);
  const timer = win.setInterval(check, BANK_POLL_INTERVAL_MS);
  return () => {
    win.removeEventListener('focus', onEvent);
    win.removeEventListener('online', onEvent);
    doc.removeEventListener('visibilitychange', onVisibility);
    win.clearInterval(timer);
  };
}

export async function requestVariant(
  elementId: string,
  params: Readonly<Record<string, number>>,
  signal?: AbortSignal,
): Promise<VariantResponse> {
  const response = await fetch(bankRoutes.variant(elementId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as VariantResponse;
}
