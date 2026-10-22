/**
 * Service-worker caching rules for the bank (ticket #51). Pure data, no workbox imports, so
 * vite.config.ts feeds it to `generateSW` and the tests can inspect it. Workbox serialises the
 * regexes into dist/sw.js, hence RegExp matchers (a function matcher would be stringified and lose
 * its closure).
 *
 * Never cached, by omission: `POST /api/bank/elements/:id/variant` and every other `/api/*` call
 * (unmatched requests bypass the worker and go to the network), SSE and WebSocket traffic.
 */

/** Hashed, immutable GLB/WebP files: a cached copy is correct forever, even if the server later 404s the name. */
export const BANK_ASSETS_CACHE = 'hsw-bank-assets-v1';
/** Bank index + search index: stale copy paints instantly (also offline), revalidation refreshes it. */
export const BANK_INDEX_CACHE = 'hsw-bank-index-v1';

/** Only a plain 200 is stored: never a 404/503 ("bank not built") body and never an opaque response. */
const CACHEABLE_STATUSES: number[] = [200];

export const BANK_ASSETS_MAX_ENTRIES = 1200;
export const BANK_INDEX_MAX_ENTRIES = 4;

/** Precache ceiling: the main chunk (three.js + app) exceeds workbox's 2 MiB default; workbox then silently drops it from the precache (offline start-up breaks with no build error). */
export const PRECACHE_MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Same-origin only: workbox rejects a RegExp match for a foreign origin unless it starts at index 0. */
export const BANK_ASSETS_PATTERN = /\/bank\/assets\/[^?#]+$/;
export const BANK_INDEX_PATTERN = /\/api\/bank\/(?:index|search-index)(?:\?[^#]*)?$/;

/** Navigations to these never fall back to the app shell (index.html): they are API / asset URLs. */
export const NAVIGATE_FALLBACK_DENYLIST: RegExp[] = [/^\/api\//, /^\/bank\//];

/**
 * Workbox `cacheWillUpdate` plugin hook. A server that falls back to the SPA shell answers 200
 * `text/html` for an unknown path; with CacheFirst and immutable names that poisoned entry would
 * never refresh, so HTML is refused. Workbox serialises this function into dist/sw.js with
 * `toString()`: it MUST stay self-contained (no closure over module scope).
 */
export async function rejectHtmlShell({
  response,
}: {
  response: Response;
}): Promise<Response | null> {
  const type = response.headers.get('content-type') ?? '';
  return /^text\/html/i.test(type) ? null : response;
}

interface RuntimeCachingRule {
  urlPattern: RegExp;
  handler: 'CacheFirst' | 'StaleWhileRevalidate';
  method: 'GET';
  options: {
    cacheName: string;
    cacheableResponse: { statuses: number[] };
    plugins: { cacheWillUpdate: typeof rejectHtmlShell }[];
    expiration: { maxEntries: number; purgeOnQuotaError: boolean };
  };
}

function rule(
  urlPattern: RegExp,
  handler: RuntimeCachingRule['handler'],
  cacheName: string,
  maxEntries: number,
  purgeOnQuotaError: boolean,
): RuntimeCachingRule {
  return {
    urlPattern,
    handler,
    method: 'GET',
    options: {
      cacheName,
      cacheableResponse: { statuses: CACHEABLE_STATUSES },
      plugins: [{ cacheWillUpdate: rejectHtmlShell }],
      expiration: { maxEntries, purgeOnQuotaError },
    },
  };
}

// Only the asset cache is purged on a quota error: a quota failure while storing a large GLB must
// not also wipe the few-KB index, or the bank cannot start offline.
export const RUNTIME_CACHING: RuntimeCachingRule[] = [
  rule(BANK_ASSETS_PATTERN, 'CacheFirst', BANK_ASSETS_CACHE, BANK_ASSETS_MAX_ENTRIES, true),
  rule(BANK_INDEX_PATTERN, 'StaleWhileRevalidate', BANK_INDEX_CACHE, BANK_INDEX_MAX_ENTRIES, false),
];
