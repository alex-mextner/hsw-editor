/**
 * Runtime caching for the service worker and for the page-side "make available offline" downloader:
 * one implementation of "fetch, decide whether it may be stored, store it, account for it, evict".
 *
 * Everything the environment provides (`caches`, `fetch`, the clock, the byte budget, `waitUntil`) is
 * injected, so the behaviour is unit-tested against a fake CacheStorage and verified in real Chromium
 * with the same code.
 */
import { planEviction, whyUnstorable, type RuntimeRoute, type Unstorable } from './cachePolicy.ts';
import type { AssetRegistry } from './registry.ts';

export interface AssetCacheDeps {
  readonly caches: CacheStorage;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly registry: AssetRegistry;
  /** Current byte budget of the media cache (user setting, capped by the quota). */
  readonly budget: () => Promise<number>;
  /** Keeps the worker alive for background work (cache write, revalidation). */
  readonly waitUntil: (work: Promise<unknown>) => void;
  /** Reports a response that was refused for storage (diagnostics, tests). */
  readonly onRefused?: (url: string, why: Unstorable) => void;
  /** Reports a cache write that failed (not a refusal and not a quota miss). */
  readonly onError?: (url: string, error: unknown) => void;
}

function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

/** Body size after decoding; `Content-Length` is the encoded size and may be absent. */
async function bodyBytes(response: Response): Promise<number> {
  const declared = response.headers.get('content-length');
  const length = declared === null ? Number.NaN : Number(declared);
  if (!response.headers.has('content-encoding') && Number.isFinite(length) && length > 0) {
    return length;
  }
  return (await response.clone().blob()).size;
}

/**
 * Stores `response` for `request` under `route`, records its size, then evicts least-recently-used
 * unpinned entries until the media cache is back under budget. A quota error evicts a quarter of the
 * evictable entries and retries once; if it still fails the file is simply not cached (the page already
 * has its bytes). Resolves with the stored size in bytes, or `null` when nothing was stored.
 */
export async function storeResponse(
  deps: AssetCacheDeps,
  request: Request,
  response: Response,
  route: RuntimeRoute,
  options: { pinned?: boolean } = {},
): Promise<number | null> {
  const why = whyUnstorable(response);
  if (why) {
    deps.onRefused?.(request.url, why);
    return null;
  }
  const bytes = await bodyBytes(response);
  const cache = await deps.caches.open(route.cache);
  const replacing = (await cache.match(request)) !== undefined;
  try {
    await cache.put(request, response.clone());
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await evict(deps, route.cache, 0.75, new Set([request.url]));
    try {
      await cache.put(request, response.clone());
    } catch (retry) {
      if (isQuotaError(retry)) return null;
      throw retry;
    }
  }
  try {
    await deps.registry.record({
      url: request.url,
      cache: route.cache,
      category: route.category,
      bytes,
      evictable: route.evictable,
      ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
    });
  } catch (error) {
    // A new file the registry does not know can never be evicted or counted: undo the put rather than leak it.
    // An overwritten file keeps its old registry row, so deleting it would leave a row with no file behind it.
    if (!replacing) await cache.delete(request).catch(() => false);
    throw error;
  }
  if (route.evictable) await evict(deps, route.cache, 1, new Set([request.url]));
  return bytes;
}

/** Evicts down to `fraction` of the budget (1 = exactly the budget). Never touches `keep` or pinned entries. */
export async function evict(
  deps: AssetCacheDeps,
  cacheName: string,
  fraction: number,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const entries = await deps.registry.all();
  const victims = planEviction(
    entries,
    cacheName,
    Math.floor((await deps.budget()) * fraction),
    keep,
  );
  if (victims.length === 0) return victims;
  const cache = await deps.caches.open(cacheName);
  await Promise.all(victims.map((url) => cache.delete(url)));
  await deps.registry.remove(victims);
  return victims;
}

export async function handleRuntimeRequest(
  deps: AssetCacheDeps,
  request: Request,
  route: RuntimeRoute,
): Promise<Response> {
  return route.strategy === 'cache-first'
    ? cacheFirst(deps, request, route)
    : staleWhileRevalidate(deps, request, route);
}

/** Requests in flight per URL, for the lifetime of the worker: a bank grid asking for the same file twice downloads it once. */
const inflight = new Map<string, Promise<Response>>();

async function cacheFirst(
  deps: AssetCacheDeps,
  request: Request,
  route: RuntimeRoute,
): Promise<Response> {
  const cache = await deps.caches.open(route.cache);
  const hit = await cache.match(request);
  if (hit) {
    deps.registry.touch(request.url);
    deps.waitUntil(deps.registry.scheduleFlush());
    return hit;
  }
  const pending =
    inflight.get(request.url) ??
    deps
      // A fresh request: the shared download must not die with the first caller's abort signal.
      .fetch(new Request(request.url))
      .then((response) => {
        deps.waitUntil(storeQuietly(deps, request, response.clone(), route));
        return response;
      })
      .finally(() => {
        inflight.delete(request.url);
      });
  inflight.set(request.url, pending);
  return (await pending).clone();
}

/** Caching is an optimisation: a failed write is reported, never turned into a failed page request. */
async function storeQuietly(
  deps: AssetCacheDeps,
  request: Request,
  response: Response,
  route: RuntimeRoute,
): Promise<void> {
  try {
    await storeResponse(deps, request, response, route);
  } catch (error) {
    deps.onError?.(request.url, error);
  }
}

async function staleWhileRevalidate(
  deps: AssetCacheDeps,
  request: Request,
  route: RuntimeRoute,
): Promise<Response> {
  const cache = await deps.caches.open(route.cache);
  const cached = await cache.match(request);
  const refresh = deps.fetch(request).then(async (response) => {
    // A failed or refused revalidation never replaces a good cached copy.
    await storeQuietly(deps, request, response.clone(), route);
    return response;
  });
  if (cached) {
    // Offline: the revalidation rejects; that is expected and must not surface as an unhandled rejection.
    deps.waitUntil(refresh.catch(() => undefined));
    return cached;
  }
  return refresh;
}
