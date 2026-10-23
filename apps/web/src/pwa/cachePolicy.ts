/**
 * What the service worker caches at runtime, and how. Pure data and decisions (no worker globals), so
 * the rules are unit-tested and the same module serves the worker, the page-side "make available offline"
 * downloader and the settings panel.
 *
 * Two caches, two lifetimes:
 *   - `MEDIA_CACHE`  immutable, content-addressed files (bank GLBs and thumbnails, tool model GLBs, wall photos and models):
 *                    cache-first, byte-budgeted LRU eviction, pinned entries are never evicted;
 *   - `INDEX_CACHE`  small JSON the bank browser and the wall start from (bank index, search index, element detail, the tool
 *                    model index): stale-while-revalidate, never evicted (a few hundred KB; without it the bank cannot
 *                    open offline and the tools on the wall fall back to boxes).
 *
 * Never stored: anything but a plain `200`, opaque responses, `text/html` (a server that falls back to the
 * SPA shell for an unknown path would otherwise poison an immutable entry forever) and `Cache-Control: no-store`.
 */

export const MEDIA_CACHE = 'hsw-media-v1';
export const INDEX_CACHE = 'hsw-bank-index-v1';
export const RUNTIME_CACHES: readonly string[] = [MEDIA_CACHE, INDEX_CACHE];

export const ASSET_CATEGORIES = [
  'bank-model',
  'bank-thumbnail',
  'bank-index',
  'tool-model',
  'tool-index',
  'wall-photo',
  'wall-model',
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export type CacheStrategy = 'cache-first' | 'stale-while-revalidate';

export interface RuntimeRoute {
  readonly category: AssetCategory;
  readonly strategy: CacheStrategy;
  readonly cache: string;
  /** May the LRU drop it when the byte budget is exceeded? `false` for the small bank index files. */
  readonly evictable: boolean;
}

const route = (
  category: AssetCategory,
  strategy: CacheStrategy,
  cache: string,
  evictable: boolean,
): RuntimeRoute => ({ category, strategy, cache, evictable });

const BANK_MODEL = route('bank-model', 'cache-first', MEDIA_CACHE, true);
const BANK_THUMB = route('bank-thumbnail', 'cache-first', MEDIA_CACHE, true);
const BANK_INDEX = route('bank-index', 'stale-while-revalidate', INDEX_CACHE, false);
const TOOL_MODEL = route('tool-model', 'cache-first', MEDIA_CACHE, true);
const TOOL_INDEX = route('tool-index', 'stale-while-revalidate', INDEX_CACHE, false);
const WALL_PHOTO = route('wall-photo', 'cache-first', MEDIA_CACHE, true);
const WALL_MODEL = route('wall-model', 'cache-first', MEDIA_CACHE, true);

// Mirrors the bank server (docs/bank.md): the extension is bound to the kind and names are content hashes.
const BANK_GLB_PATH = /^\/bank\/assets\/(?:glb|variant)\/[0-9a-f]{16}\.glb$/;
const BANK_THUMB_PATH = /^\/bank\/assets\/thumb\/[0-9a-f]{16}\.webp$/;
// Mirrors the tool asset store (docs/tools.md): content-hashed GLBs of the generated tool models and the index that lists them.
const TOOL_GLB_PATH = /^\/tools\/assets\/glb\/[0-9a-f]{16}\.glb$/;
const TOOL_INDEX_PATH = /^\/api\/tools\/assets\/index$/;
const BANK_INDEX_PATH = /^\/api\/bank\/(?:index|search-index|elements\/[a-z0-9-]+)$/;
const WALL_PHOTO_PATH =
  /^\/api\/walls\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/photos\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/file$/;
const WALL_MODEL_PATH =
  /^\/api\/walls\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/models\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/file$/;

/**
 * The runtime rule for a request, or `null` when the worker must not touch it (everything else under
 * `/api/*` — wall JSON, ops, SSE, jobs, settings — goes straight to the network: the app keeps its own
 * IndexedDB mirror of walls, a second copy in the HTTP cache could only be stale).
 *
 * Only same-origin GETs without a `Range` header qualify; a URL with a query string is not a bank asset.
 */
export function routeFor(
  url: URL,
  method: string,
  hasRange: boolean,
  origin: string,
): RuntimeRoute | null {
  if (method !== 'GET' || hasRange || url.origin !== origin || url.search !== '') return null;
  const { pathname } = url;
  if (BANK_GLB_PATH.test(pathname)) return BANK_MODEL;
  if (BANK_THUMB_PATH.test(pathname)) return BANK_THUMB;
  if (BANK_INDEX_PATH.test(pathname)) return BANK_INDEX;
  if (TOOL_GLB_PATH.test(pathname)) return TOOL_MODEL;
  if (TOOL_INDEX_PATH.test(pathname)) return TOOL_INDEX;
  if (WALL_PHOTO_PATH.test(pathname)) return WALL_PHOTO;
  if (WALL_MODEL_PATH.test(pathname)) return WALL_MODEL;
  return null;
}

/** Navigations to these never fall back to the app shell: they are API or asset URLs, not pages. */
export const NAVIGATE_FALLBACK_DENYLIST: readonly RegExp[] = [
  /^\/api\//,
  /^\/bank\//,
  /^\/tools\//,
];

/** Why a response was not stored; `null` = it is storable. */
export type Unstorable = 'status' | 'opaque' | 'html' | 'no-store';

export function whyUnstorable(response: Response): Unstorable | null {
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return 'opaque';
  if (response.status !== 200) return 'status';
  if (/^text\/html/i.test(response.headers.get('content-type') ?? '')) return 'html';
  if (/no-store/i.test(response.headers.get('cache-control') ?? '')) return 'no-store';
  return null;
}

/** Entry of the registry: what the worker knows about one cached URL, for sizes, LRU and pinning. */
export interface AssetEntry {
  readonly url: string;
  readonly cache: string;
  readonly category: AssetCategory;
  /** Decoded body size. */
  readonly bytes: number;
  /** Epoch ms of the last cache hit (or the store). */
  readonly lastUsed: number;
  /** Chosen with "make available offline": exempt from eviction until the user clears it. */
  readonly pinned: boolean;
  readonly evictable: boolean;
}

/** Default byte budget of `MEDIA_CACHE`; the real one is also capped at half the browser's storage quota. */
export const DEFAULT_MEDIA_BUDGET_BYTES = 1024 * 1024 * 1024;
export const MIN_MEDIA_BUDGET_BYTES = 32 * 1024 * 1024;

/** Budget actually applied: the user's setting (or the default), never above half of the origin's quota. */
export function effectiveBudget(configured: number | undefined, quota: number | undefined): number {
  const wanted = configured ?? DEFAULT_MEDIA_BUDGET_BYTES;
  const cap = quota === undefined ? wanted : Math.floor(quota / 2);
  return Math.max(MIN_MEDIA_BUDGET_BYTES, Math.min(wanted, cap));
}

/**
 * URLs to evict so the evictable, unpinned entries of `cache` fit in `budgetBytes`: least recently used
 * first. Pinned entries count toward the total (they occupy the space) but are never chosen; if they alone
 * exceed the budget nothing is evicted: emptying the rest of the cache would not get under it.
 */
export function planEviction(
  entries: readonly AssetEntry[],
  cache: string,
  budgetBytes: number,
  keep: ReadonlySet<string> = new Set(),
): string[] {
  const inCache = entries.filter((entry) => entry.cache === cache);
  let total = inCache.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= budgetBytes) return [];
  // Entries that can never be chosen: if they alone overflow the budget, evicting the rest frees nothing useful.
  const immovable = inCache
    .filter((entry) => entry.pinned || !entry.evictable)
    .reduce((sum, entry) => sum + entry.bytes, 0);
  if (immovable > budgetBytes) return [];
  const victims = inCache
    .filter((entry) => entry.evictable && !entry.pinned && !keep.has(entry.url))
    .sort((a, b) => a.lastUsed - b.lastUsed || a.url.localeCompare(b.url));
  const out: string[] = [];
  for (const victim of victims) {
    if (total <= budgetBytes) break;
    out.push(victim.url);
    total -= victim.bytes;
  }
  return out;
}
