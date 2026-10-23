/** Page-side cache dependencies (registry, budget, Cache API) for the "Offline storage" panel; memoized per page. */
import type { AssetCacheDeps } from './assetCache.ts';
import { openOfflineServices } from './services.ts';

let deps: Promise<AssetCacheDeps> | null = null;

export function pageCacheDeps(): Promise<AssetCacheDeps> {
  deps ??= openOfflineServices().then(({ registry, budget }) => ({
    caches: globalThis.caches,
    fetch: (request) => globalThis.fetch(request),
    registry,
    budget,
    waitUntil: (work) => {
      work.catch(() => undefined);
    },
  }));
  return deps;
}
