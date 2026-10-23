/// <reference lib="webworker" />
/**
 * Service worker (vite-plugin-pwa `injectManifest`). Three jobs:
 *
 *   1. Precache the app shell (build output injected as `__WB_MANIFEST`) and answer navigations from the
 *      cached `index.html`, so the editor opens with no network and no daemon.
 *   2. Runtime-cache the bank and wall media (rules: `cachePolicy.ts`, mechanics: `assetCache.ts`).
 *   3. Update on the user's terms: a new worker installs and waits; it takes over only after the page sends
 *      `SKIP_WAITING` (the "new version ready" toast accepted), never in the middle of an edit.
 *
 * Wall data is deliberately not handled here: the app keeps walls in its own IndexedDB mirror
 * (`src/offline`), so every `/api/walls/*` JSON request, SSE stream and POST goes to the network untouched.
 */
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { handleRuntimeRequest, type AssetCacheDeps } from './assetCache.ts';
import { NAVIGATE_FALLBACK_DENYLIST, RUNTIME_CACHES, routeFor } from './cachePolicy.ts';
import { isSkipWaiting } from './messages.ts';
import { openOfflineServices, type OfflineServices } from './services.ts';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | PrecacheEntry)[];
};

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [...NAVIGATE_FALLBACK_DENYLIST],
  }),
);

// Takes control of pages that were open before the very first install (so their bank requests are cached
// at once). This does not reload anything and is not an update: updates still wait for SKIP_WAITING.
clientsClaim();

let opened: Promise<OfflineServices> | null = null;
function services(): Promise<OfflineServices> {
  // A failed open (IndexedDB unavailable, private mode) must not be remembered: retry on the next request.
  opened ??= openOfflineServices().catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
}

async function cacheDeps(waitUntil: (work: Promise<unknown>) => void): Promise<AssetCacheDeps> {
  const { registry, budget } = await services();
  return {
    caches: self.caches,
    fetch: (request) => self.fetch(request),
    registry,
    budget,
    waitUntil,
    onError: (url, error) => console.error('[sw] cache write failed', url, error),
  };
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const route = routeFor(
    new URL(request.url),
    request.method,
    request.headers.has('range'),
    self.location.origin,
  );
  if (!route) return;
  event.respondWith(
    cacheDeps((work) => event.waitUntil(work)).then(
      (deps) => handleRuntimeRequest(deps, request, route),
      // Without IndexedDB there is no registry: skip caching and let the request go to the network.
      () => self.fetch(request),
    ),
  );
});

self.addEventListener('message', (event) => {
  if (isSkipWaiting(event.data)) void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Runtime caches of older versions (`-v0`, renamed ones) are abandoned by a version bump: drop them.
      const names = await self.caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              /^hsw-(?:media|bank-index)-v\d+$/.test(name) && !RUNTIME_CACHES.includes(name),
          )
          .map((name) => self.caches.delete(name)),
      );
      await (await services()).registry.reconcile(self.caches);
    })(),
  );
});
