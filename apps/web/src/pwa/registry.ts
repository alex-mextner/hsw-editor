/**
 * Registry of what the service worker has cached: size, last use, pinned flag per URL, in the shared
 * IndexedDB (`assets` store) so the worker writes it and the settings panel reads it.
 *
 * The Cache API cannot answer "how big is this entry / when was it last used", and LRU eviction and the
 * "Offline storage" panel both need that. The registry is advisory: if it disagrees with the cache
 * (browser eviction, cleared site data), `reconcile` repairs it from the cache.
 *
 * Cache hits only mark the URL as recently used in memory and are written in batches (`scheduleFlush`), so
 * scrolling a bank grid of hundreds of thumbnails does not cost one IndexedDB write per hit.
 */
import type { KvStore } from '../offline/kv.ts';
import { ASSET_CATEGORIES, type AssetCategory, type AssetEntry } from './cachePolicy.ts';

function isCategory(value: unknown): value is AssetCategory {
  return typeof value === 'string' && (ASSET_CATEGORIES as readonly string[]).includes(value);
}

export function parseAssetEntry(raw: unknown): AssetEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { url, cache, category, bytes, lastUsed, pinned, evictable } = raw as Record<
    string,
    unknown
  >;
  if (typeof url !== 'string' || typeof cache !== 'string' || !isCategory(category))
    return undefined;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (
    typeof lastUsed !== 'number' ||
    typeof pinned !== 'boolean' ||
    typeof evictable !== 'boolean'
  ) {
    return undefined;
  }
  return { url, cache, category, bytes, lastUsed, pinned, evictable };
}

export interface CategoryStats {
  readonly count: number;
  readonly bytes: number;
  readonly pinnedCount: number;
  readonly pinnedBytes: number;
}

const EMPTY_STATS: CategoryStats = { count: 0, bytes: 0, pinnedCount: 0, pinnedBytes: 0 };

export class AssetRegistry {
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly store: KvStore<AssetEntry>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Stores (or replaces the size of) an entry. An existing pin survives a refresh of the same URL; the merge is one
   * atomic transaction, so the downloader (page) and the worker recording the same file cannot drop each other's pin.
   */
  async record(
    entry: Omit<AssetEntry, 'lastUsed' | 'pinned'> & { pinned?: boolean },
  ): Promise<void> {
    this.touched.delete(entry.url);
    const at = this.now();
    await this.store.update(entry.url, (previous) => ({
      ...entry,
      lastUsed: at,
      pinned: entry.pinned ?? previous?.pinned ?? false,
    }));
  }

  /** Marks a cache hit; persisted by the next `flushTouches`. */
  touch(url: string): void {
    this.touched.set(url, this.now());
  }

  private pendingFlush: Promise<void> | null = null;

  /**
   * Persists the recorded hits soon: hits that arrive in the same turn (a grid asking for forty thumbnails) share one
   * write, and the worker is kept alive for it by the caller's `waitUntil`. Recency must reach IndexedDB or LRU would
   * evict the files used most: a worker is stopped after ~30 s idle and its memory goes with it.
   */
  scheduleFlush(): Promise<void> {
    this.pendingFlush ??= Promise.resolve().then(() => {
      this.pendingFlush = null;
      return this.flushTouches();
    });
    return this.pendingFlush;
  }

  async flushTouches(): Promise<void> {
    const batch = [...this.touched];
    this.touched.clear();
    await Promise.all(
      batch.map(([url, at]) =>
        this.store.update(url, (entry) =>
          entry && at > entry.lastUsed ? { ...entry, lastUsed: at } : undefined,
        ),
      ),
    );
  }

  /** Every entry, with unflushed touches applied. */
  async all(): Promise<AssetEntry[]> {
    const entries = (await this.store.entries()).map(([, entry]) => entry);
    return entries.map((entry) => {
      const at = this.touched.get(entry.url);
      return at !== undefined && at > entry.lastUsed ? { ...entry, lastUsed: at } : entry;
    });
  }

  async setPinned(urls: readonly string[], pinned: boolean): Promise<void> {
    await Promise.all(
      urls.map((url) =>
        this.store.update(url, (entry) =>
          entry && entry.pinned !== pinned ? { ...entry, pinned } : undefined,
        ),
      ),
    );
  }

  async remove(urls: readonly string[]): Promise<void> {
    for (const url of urls) this.touched.delete(url);
    await Promise.all(urls.map((url) => this.store.delete(url)));
  }

  /** Per-category totals, every category present (zeroed when empty). */
  async stats(): Promise<Record<AssetCategory, CategoryStats>> {
    const out = Object.fromEntries(ASSET_CATEGORIES.map((c) => [c, EMPTY_STATS])) as Record<
      AssetCategory,
      CategoryStats
    >;
    for (const entry of await this.all()) {
      const previous = out[entry.category];
      out[entry.category] = {
        count: previous.count + 1,
        bytes: previous.bytes + entry.bytes,
        pinnedCount: previous.pinnedCount + (entry.pinned ? 1 : 0),
        pinnedBytes: previous.pinnedBytes + (entry.pinned ? entry.bytes : 0),
      };
    }
    return out;
  }

  /**
   * Drops registry entries whose response is no longer in the cache (the browser evicted it, DevTools
   * cleared it). Entries present in the cache but unknown to the registry are left alone: they are
   * served correctly and age out with the cache version.
   */
  async reconcile(cacheStorage: CacheStorage): Promise<string[]> {
    const gone: string[] = [];
    const caches = new Map<string, Cache>();
    for (const entry of await this.all()) {
      let cache = caches.get(entry.cache);
      if (!cache) {
        cache = await cacheStorage.open(entry.cache);
        caches.set(entry.cache, cache);
      }
      if (!(await cache.match(entry.url))) gone.push(entry.url);
    }
    await this.remove(gone);
    return gone;
  }
}
