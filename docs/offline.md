# Offline app shell and caches (service worker)

Tickets: [#89](https://github.com/alex-mextner/hsw-editor/issues/89) (shell, caches), [#18](https://github.com/alex-mextner/hsw-editor/issues/18),
[#19](https://github.com/alex-mextner/hsw-editor/issues/19). Wall data (mirror, queue, replay) is a separate layer: [offline-sync.md](offline-sync.md).

The service worker is `apps/web/src/pwa/sw.ts`, built by `vite-plugin-pwa` in `injectManifest` mode (options: `pwaPluginOptions.ts`).
It replaces the earlier `generateSW` config because that cannot do a user-accepted `skipWaiting`, a byte budget, pinning or messages.

## What is cached how

| What | URL | Strategy | Cache | Evictable |
| --- | --- | --- | --- | --- |
| App shell | build output (`index.html`, JS, CSS, icons, manifest) | precache, navigations fall back to `/index.html` | `workbox-precache-*` | replaced per build (`cleanupOutdatedCaches`) |
| Bank models | `/bank/assets/(glb\|variant)/<16 hex>.glb` | cache-first | `hsw-media-v1` | yes (LRU, byte budget) |
| Bank thumbnails | `/bank/assets/thumb/<16 hex>.webp` | cache-first | `hsw-media-v1` | yes |
| Wall photos / models | `/api/walls/:id/photos/:pid/file`, `/models/:mid/file` | cache-first | `hsw-media-v1` | yes |
| Bank index | `/api/bank/index`, `/api/bank/search-index`, `/api/bank/elements/:id` | stale-while-revalidate | `hsw-bank-index-v1` | never (a few hundred KB; without it the bank cannot open offline) |

Rules live in `cachePolicy.ts` (pure, unit-tested), mechanics in `assetCache.ts`. Names under `/bank/assets/` are content hashes, so a
cached copy is correct forever: it is served even if the server later answers 404 for that name.

### Never stored

- anything but a plain `200` (404 `asset_not_found`, 503 "bank not built", 5xx, 206, 304) and opaque responses;
- a `200 text/html`: a server that falls back to the SPA shell for an unknown path would otherwise pin an HTML page under a `.glb` URL forever;
- `Cache-Control: no-store`;
- URLs with a query string or `Range` requests (they go to the network), non-GET requests.

A failed revalidation never replaces a good cached copy. Everything else under `/api/*` (wall JSON, ops, SSE, jobs, settings, the bank
variant POST) is untouched and goes to the network: the app keeps its own IndexedDB mirror of walls. Navigations to `/api/*` and `/bank/*`
never fall back to the app shell.

## Budget, LRU, pinning

`hsw-media-v1` has a byte budget: the user's setting (`meta` store, key `mediaBudget`), default 1 GiB, never above half the browser's quota
for the origin, never below 32 MiB. After every store the worker evicts least-recently-used entries until the cache fits; the file just
stored and **pinned** entries are never chosen. A quota error evicts down to 75 % of the budget and retries once, then the file is simply not
cached. Sizes, last use and the pin flag live in the `assets` store of the offline IndexedDB (`registry.ts`); cache hits are batched in
memory before they are written.

"Make available offline" (`storage.ts`, UI: the Offline storage dialog from the top bar, `features/offline/OfflineStorageDialog.tsx`) downloads the chosen bank categories, the whole bank or a wall's media through the same store
function, from the page (so it works on the very first visit, before the worker controls it), and pins them. It skips files already cached
(it only pins them), stops as offline on a network error, as `quota` when origin usage passes 90 % of the quota, and can be cancelled.

The Offline storage dialog shows the browser's usage and quota, files/size/pinned per category, downloads the whole bank or one top-level
category (with progress, cancel and the stop reasons offline / quota), clears models or thumbnails, asks the browser to keep the storage
(`storage.persist()`), and offers Install the app (or the Share -> Add to Home Screen hint on iPhone).

## Update flow

`registerType: 'prompt'`. A new worker installs and waits. `UpdateController` (`updates.ts`) raises "new version ready"; only after the user
accepts does it run `beforeApply` (the editor flushes its mirror), post `SKIP_WAITING`, and reload once the new worker controls the page.
The very first install claims the page without a reload. Updates are looked for hourly and when the tab becomes visible (online only).

## Installing

Manifest (`pluginOptions.ts`): standalone, theme `#0a0a0a`, PNG 192/512, maskable 512, SVG. `index.html` adds the iOS pieces: `apple-touch-icon`,
`apple-mobile-web-app-capable`, status bar style and startup images for eleven iPhone sizes. The PNGs are generated from `public/icon.svg`
by `bun run pwa:assets` and committed. Chromium: `InstallController` keeps `beforeinstallprompt` for an Install button. iPhone Safari has no
such event, so the UI shows the Share -> Add to Home Screen hint (`iosHint`). Service workers need a secure context (HTTPS or `localhost`);
on a plain-http LAN address there is no worker and none of this applies. No worker runs under `vite dev`.

## Clearing

From the settings panel (per category), or in DevTools -> Application -> Cache Storage, or:

```js
await caches.delete('hsw-media-v1');
await caches.delete('hsw-bank-index-v1');
```

Bumping the `-v1` suffix in `cachePolicy.ts` abandons the old cache; the worker deletes cache names of the same family that are not current
on activation. Deleting a cache behind the registry's back is repaired by `reconcile` on the next activation.

## Verifying

`bun test apps/web/src/pwa` covers routing, the storable-response rules, strategies, LRU/pinning/quota, the downloader, the update and
install controllers against fakes. The worker itself is verified in real Chromium (proof notes in the PR).

## GitHub Pages demo (hsw.mextner.com)

The Pages workflow builds with `VITE_HSW_DEMO=1` (`apps/web/src/demo/mode.ts`). There is no daemon: the committed seed bank
(`packages/bank/seed`) is copied into `dist` at the URLs the daemon serves (`/api/bank/index`, `/api/bank/search-index`,
`/bank/assets/...`, by the `demoSeedBank` plugin in `vite.config.ts`), so the bank browser, the service worker caches and the offline
behaviour above work unchanged. One bundled wall (`demo/demoApi.ts`, six seed elements) opens read-only on the first visit: `listWalls`/`getWall` are
served locally, every edit, undo and wall creation is refused with the notice "This is a read-only demo", and the wall, health, event-stream,
history and client-error requests are never made. Features that need a daemon (photo upload, vision jobs, bank variant builds) still try
their `/api` call and fail like an unreachable daemon. After one visit the demo reloads offline.

## Known limits

- Stale-while-revalidate: the first page load after a bank rebuild still gets the previous index; the fresh copy shows on the next load or
  when the page re-fetches it.
- The very first visit is not controlled by the worker until it claims the page; requests before that bypass it.
- The registry is advisory: files cached by an older build and unknown to it are served but not counted toward the budget until re-fetched.
