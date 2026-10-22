import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BANK_ASSETS_CACHE,
  BANK_INDEX_CACHE,
  NAVIGATE_FALLBACK_DENYLIST,
  PRECACHE_MAX_FILE_BYTES,
  RUNTIME_CACHING,
  rejectHtmlShell,
} from './runtimeCaching.ts';

const ORIGIN = 'http://127.0.0.1:8794';
// workbox dev builds log through getFriendlyURL, which reads the service-worker global `location`.
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
Object.defineProperty(globalThis, 'location', { value: new URL(ORIGIN), configurable: true });
afterAll(() => {
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else Reflect.deleteProperty(globalThis, 'location');
  Reflect.deleteProperty(globalThis, '__WB_DISABLE_DEV_LOGS');
});

// Silences workbox's dev-build cacheability logging (one block per rejected response); the flag
// is read when workbox-core loads, hence the dynamic import after it.
Reflect.set(globalThis, '__WB_DISABLE_DEV_LOGS', true);
const { CacheableResponse } = await import('workbox-cacheable-response');

const [assets, index] = RUNTIME_CACHING;
if (!assets || !index) throw new Error('runtime caching rules missing');

/** Mirrors workbox RegExp routing: match on the href, foreign origins only at index 0. */
function routes(rule: { urlPattern: RegExp }, href: string): boolean {
  const result = rule.urlPattern.exec(href);
  if (!result) return false;
  return new URL(href).origin === ORIGIN || result.index === 0;
}

describe('route matchers', () => {
  test('asset rule accepts hashed glb and thumbnails', () => {
    for (const path of [
      '/bank/assets/glb/a47bacef44e3f4f4.glb',
      '/bank/assets/thumb/a47bacef44e3f4f4.webp',
    ]) {
      expect(routes(assets, ORIGIN + path)).toBe(true);
    }
  });

  test('asset rule never matches query strings or fragments (those go to the network)', () => {
    expect(routes(assets, `${ORIGIN}/bank/assets/glb/a47bacef44e3f4f4.glb?v=1`)).toBe(false);
  });

  test('asset rule rejects the index, walls and foreign origins', () => {
    expect(routes(assets, `${ORIGIN}/api/bank/index`)).toBe(false);
    expect(routes(assets, `${ORIGIN}/api/walls`)).toBe(false);
    expect(routes(assets, 'https://evil.example/bank/assets/glb/a47bacef44e3f4f4.glb')).toBe(false);
  });

  test('index rule accepts index and search-index only', () => {
    expect(routes(index, `${ORIGIN}/api/bank/index`)).toBe(true);
    expect(routes(index, `${ORIGIN}/api/bank/index?x=1`)).toBe(true);
    expect(routes(index, `${ORIGIN}/api/bank/search-index`)).toBe(true);
    expect(routes(index, `${ORIGIN}/api/walls`)).toBe(false);
    expect(routes(index, `${ORIGIN}/api/bank/elements/x/variant`)).toBe(false);
    expect(routes(index, `${ORIGIN}/bank/assets/glb/a47bacef44e3f4f4.glb`)).toBe(false);
  });

  test('variant POST and other /api calls match no caching rule', () => {
    for (const path of ['/api/bank/elements/x/variant', '/api/walls', '/api/walls/w1/events']) {
      expect(RUNTIME_CACHING.some((rule) => routes(rule, ORIGIN + path))).toBe(false);
    }
    expect(RUNTIME_CACHING.every((rule) => rule.method === 'GET')).toBe(true);
  });
});

describe('strategies and cache names', () => {
  test('assets are cache-first, the index is stale-while-revalidate', () => {
    expect(assets.handler).toBe('CacheFirst');
    expect(assets.options.cacheName).toBe(BANK_ASSETS_CACHE);
    expect(BANK_ASSETS_CACHE).toBe('hsw-bank-assets-v1');
    expect(assets.options.expiration.purgeOnQuotaError).toBe(true);
    expect(assets.options.expiration.maxEntries).toBe(1200);
    expect(index.handler).toBe('StaleWhileRevalidate');
    expect(index.options.cacheName).toBe(BANK_INDEX_CACHE);
    expect(index.options.expiration.purgeOnQuotaError).toBe(false);
    expect(index.options.expiration.maxEntries).toBeGreaterThan(0);
    expect(BANK_INDEX_CACHE).toBe('hsw-bank-index-v1');
  });

  test('navigation fallback never serves the shell for /api/ or /bank/', () => {
    expect(NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test('/api/bank/index'))).toBe(true);
    expect(NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test('/bank/assets/glb/x.glb'))).toBe(true);
    expect(NAVIGATE_FALLBACK_DENYLIST.some((re) => re.test('/wall/1'))).toBe(false);
  });

  test('precache ceiling is above the workbox 2 MiB default', () => {
    expect(PRECACHE_MAX_FILE_BYTES).toBeGreaterThan(2 * 1024 * 1024);
  });
});

describe.each([
  ['assets', assets],
  ['index', index],
])('%s cacheableResponse options', (_name, rule) => {
  const cacheable = new CacheableResponse(rule.options.cacheableResponse);
  /** Cross-origin no-cors responses: status 0, type 'opaque'; cannot be built via the constructor. */
  function opaqueResponse(): Response {
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, 'status', { value: 0 });
    Object.defineProperty(response, 'type', { value: 'opaque' });
    return response;
  }

  test('only a 200 is cacheable', () => {
    expect(cacheable.isResponseCacheable(new Response('ok', { status: 200 }))).toBe(true);
    for (const status of [206, 304, 404, 500, 503]) {
      const body = status === 304 ? null : 'x';
      expect(cacheable.isResponseCacheable(new Response(body, { status }))).toBe(false);
    }
    expect(cacheable.isResponseCacheable(opaqueResponse())).toBe(false);
  });
});

describe.each([
  ['assets', assets],
  ['index', index],
])('%s rejects the SPA shell', (_name, rule) => {
  const [plugin] = rule.options.plugins;
  if (!plugin) throw new Error('cacheWillUpdate plugin missing');
  const html = () =>
    new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

  test('a 200 text/html fallback is not stored', async () => {
    expect(await plugin.cacheWillUpdate({ response: html() })).toBeNull();
  });

  test('binary and json bodies are stored', async () => {
    for (const type of [
      'model/gltf-binary',
      'image/webp',
      'application/json',
      'application/octet-stream',
    ]) {
      const response = new Response('x', { status: 200, headers: { 'content-type': type } });
      expect(await rejectHtmlShell({ response })).toBe(response);
    }
    const untyped = new Response(null, { status: 200 });
    expect(await rejectHtmlShell({ response: untyped })).toBe(untyped);
  });
});

describe('built service worker', () => {
  const swPath = fileURLToPath(new URL('../../dist/sw.js', import.meta.url));
  const sources = [
    fileURLToPath(new URL('./runtimeCaching.ts', import.meta.url)),
    fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
  ];
  // A dist/ built before the rules last changed says nothing about them: skip it, rebuild to check.
  const fresh =
    existsSync(swPath) &&
    sources.every((file) => statSync(swPath).mtimeMs >= statSync(file).mtimeMs);
  test.skipIf(!fresh)('dist/sw.js contains the runtime routes', () => {
    const sw = readFileSync(swPath, 'utf8');
    expect(sw).toContain(BANK_ASSETS_CACHE);
    expect(sw).toContain(BANK_INDEX_CACHE);
    expect(sw).toContain('CacheFirst');
    expect(sw).toContain('StaleWhileRevalidate');
    expect(sw).toContain('cleanupOutdatedCaches');
    expect(sw).toContain('cacheWillUpdate');
    expect(sw).toContain('text\\/html');
    expect(sw).toMatch(/statuses:\s*\[\s*200\s*\]/);
    expect(sw).toMatch(/denylist:\s*\[\s*\/\^\\\/api\\\//);
  });
});
