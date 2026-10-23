/**
 * Page side of "Offline storage": what is stored and how big it is, "make available offline" (download and pin
 * the chosen bank categories, the whole bank, or a wall's photos and models) and clearing.
 *
 * Downloads go through the same `storeResponse` the service worker uses, written straight into the Cache API from
 * the page, so they work on the very first visit before the worker controls the page. Everything the user pins
 * is exempt from LRU eviction until they clear it.
 */
import { storeResponse, type AssetCacheDeps } from './assetCache.ts';
import { ASSET_CATEGORIES, routeFor, type AssetCategory } from './cachePolicy.ts';
import type { CategoryStats } from './registry.ts';

// ---- report -------------------------------------------------------------------------------------------

export interface StorageReport {
  /** Origin usage and quota as the browser reports them (`navigator.storage.estimate()`), when available. */
  readonly usage: number | undefined;
  readonly quota: number | undefined;
  /** The browser promised not to evict this origin's data under pressure (`navigator.storage.persist()`). */
  readonly persisted: boolean | undefined;
  /** Byte budget of the media cache (LRU applies above it; pinned entries are exempt). */
  readonly budget: number;
  readonly categories: Record<AssetCategory, CategoryStats>;
  /** Bytes held by this app's offline caches (sum over categories). */
  readonly offlineBytes: number;
  readonly pinnedBytes: number;
}

export interface StorageEnv {
  readonly estimate: () => Promise<{ usage?: number | undefined; quota?: number | undefined }>;
  readonly persisted: () => Promise<boolean | undefined>;
}

export async function buildReport(
  deps: Pick<AssetCacheDeps, 'registry' | 'budget'>,
  env: StorageEnv,
): Promise<StorageReport> {
  const [estimate, persisted, categories, budget] = await Promise.all([
    env.estimate(),
    env.persisted(),
    deps.registry.stats(),
    deps.budget(),
  ]);
  let offlineBytes = 0;
  let pinnedBytes = 0;
  for (const category of ASSET_CATEGORIES) {
    offlineBytes += categories[category].bytes;
    pinnedBytes += categories[category].pinnedBytes;
  }
  return {
    usage: estimate.usage,
    quota: estimate.quota,
    persisted,
    budget,
    categories,
    offlineBytes,
    pinnedBytes,
  };
}

// ---- what to download ---------------------------------------------------------------------------------

/** The part of the bank index the downloader needs (structurally what `BankIndex` provides). */
export interface BankIndexLike {
  readonly elements: readonly {
    readonly id: string;
    readonly category: string;
    readonly assets: {
      readonly lod0: { readonly path: string };
      readonly lod1: { readonly path: string };
      readonly thumbnail: { readonly path: string };
    };
  }[];
}

export interface BankSelection {
  /** Category tree ids (`holders/screwdrivers`); a parent selects its whole subtree. Empty = whole bank. */
  readonly categories: readonly string[];
  readonly thumbnails: boolean;
  readonly models: boolean;
}

function inCategories(category: string, selected: readonly string[]): boolean {
  return (
    selected.length === 0 ||
    selected.some((wanted) => category === wanted || category.startsWith(`${wanted}/`))
  );
}

/** Asset URLs (deduplicated, stable order) of the selected bank elements. */
export function bankAssetUrls(
  index: BankIndexLike,
  selection: BankSelection,
  origin: string,
): string[] {
  const urls = new Set<string>();
  for (const element of index.elements) {
    if (!inCategories(element.category, selection.categories)) continue;
    if (selection.thumbnails) urls.add(`${origin}/bank/assets/${element.assets.thumbnail.path}`);
    if (selection.models) {
      urls.add(`${origin}/bank/assets/${element.assets.lod0.path}`);
      urls.add(`${origin}/bank/assets/${element.assets.lod1.path}`);
    }
  }
  return [...urls];
}

/** Photo and model files stored with a wall (`/api/walls/:id/...`), so the wall opens complete offline. */
export function wallMediaUrls(
  wall: {
    readonly id: string;
    readonly photos: readonly { readonly id: string }[];
    readonly models: readonly { readonly id: string; readonly file?: string | undefined }[];
  },
  origin: string,
): string[] {
  const id = encodeURIComponent(wall.id);
  return [
    ...wall.photos.map(
      (photo) => `${origin}/api/walls/${id}/photos/${encodeURIComponent(photo.id)}/file`,
    ),
    ...wall.models
      .filter((model) => model.file !== undefined)
      .map((model) => `${origin}/api/walls/${id}/models/${encodeURIComponent(model.id)}/file`),
  ];
}

// ---- download -----------------------------------------------------------------------------------------

export interface DownloadProgress {
  readonly total: number;
  /** Files stored or already present. */
  readonly done: number;
  /** Files the server did not have or refused (404, HTML, ...). */
  readonly failed: number;
  /** Bytes downloaded in this run. */
  readonly bytes: number;
}

export type DownloadResult =
  | (DownloadProgress & { readonly outcome: 'complete' })
  /** The network dropped; what was stored stays stored and pinned. */
  | (DownloadProgress & { readonly outcome: 'offline' })
  | (DownloadProgress & { readonly outcome: 'cancelled' })
  /** The browser's quota is nearly used up; stopped before filling it. */
  | (DownloadProgress & { readonly outcome: 'quota' });

export interface DownloadOptions {
  readonly origin: string;
  /** Pin what is downloaded (the "make available offline" meaning). */
  readonly pin: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly concurrency?: number;
  /** Stop when origin usage passes this fraction of the quota. */
  readonly quotaFraction?: number;
  readonly env?: Pick<StorageEnv, 'estimate'>;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_QUOTA_FRACTION = 0.9;

/**
 * Fetches and stores `urls`, skipping those already cached (they are only pinned). A 404 or an HTML answer counts as
 * `failed` and never stops the run; a network error stops it as `offline`.
 */
export async function downloadAssets(
  deps: AssetCacheDeps,
  urls: readonly string[],
  options: DownloadOptions,
): Promise<DownloadResult> {
  const queue = [...new Set(urls)];
  const progress = { total: queue.length, done: 0, failed: 0, bytes: 0 };
  let stop: 'offline' | 'cancelled' | 'quota' | null = null;
  const report = (): void => options.onProgress?.({ ...progress });
  const fraction = options.quotaFraction ?? DEFAULT_QUOTA_FRACTION;

  const overQuota = async (): Promise<boolean> => {
    if (!options.env) return false;
    const { usage, quota } = await options.env.estimate();
    return usage !== undefined && quota !== undefined && quota > 0 && usage / quota > fraction;
  };

  const next = async (): Promise<void> => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (stop) return;
      if (options.signal?.aborted) {
        stop = 'cancelled';
        return;
      }
      const route = routeFor(new URL(url), 'GET', false, options.origin);
      if (!route) {
        progress.failed += 1;
        report();
        continue;
      }
      const cache = await deps.caches.open(route.cache);
      if (await cache.match(url)) {
        if (options.pin) await deps.registry.setPinned([url], true);
        progress.done += 1;
        report();
        continue;
      }
      if (await overQuota()) {
        stop = 'quota';
        return;
      }
      let response: Response;
      try {
        response = await deps.fetch(new Request(url, { signal: options.signal ?? null }));
      } catch {
        stop = options.signal?.aborted ? 'cancelled' : 'offline';
        return;
      }
      let storedBytes: number | null;
      try {
        storedBytes = await storeResponse(deps, new Request(url), response, route, {
          pinned: options.pin,
        });
      } catch (error) {
        // The body is read while it is stored: an abort or a dropped connection surfaces here, not at `fetch`.
        if (
          options.signal?.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          stop = 'cancelled';
        } else if (error instanceof TypeError) {
          stop = 'offline';
        } else {
          progress.failed += 1;
          deps.onError?.(url, error);
          report();
          continue;
        }
        return;
      }
      if (storedBytes === null) {
        progress.failed += 1;
      } else {
        progress.done += 1;
        progress.bytes += storedBytes;
      }
      report();
    }
  };

  const workers = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  await Promise.all(Array.from({ length: workers }, () => next()));
  return { ...progress, outcome: stop ?? 'complete' };
}

// ---- clear --------------------------------------------------------------------------------------------

/** Deletes every cached file of `categories` (pinned ones included: the user asked) and forgets them. */
export async function clearCategories(
  deps: Pick<AssetCacheDeps, 'caches' | 'registry'>,
  categories: readonly AssetCategory[],
): Promise<number> {
  const entries = (await deps.registry.all()).filter((entry) =>
    categories.includes(entry.category),
  );
  const byCache = new Map<string, string[]>();
  for (const entry of entries) {
    byCache.set(entry.cache, [...(byCache.get(entry.cache) ?? []), entry.url]);
  }
  for (const [name, urls] of byCache) {
    const cache = await deps.caches.open(name);
    await Promise.all(urls.map((url) => cache.delete(url)));
  }
  await deps.registry.remove(entries.map((entry) => entry.url));
  return entries.length;
}
