import { describe, expect, test } from 'bun:test';
import { handleRuntimeRequest, storeResponse } from './assetCache.ts';
import {
  effectiveBudget,
  INDEX_CACHE,
  MEDIA_CACHE,
  OFFLINE_COPY_HEADER,
  MIN_MEDIA_BUDGET_BYTES,
  planEviction,
  routeFor,
  whyUnstorable,
  type AssetEntry,
} from './cachePolicy.ts';
import { bytesOf, harness } from './fakes.ts';

const ORIGIN = 'https://hsw.test';
const GLB = `${ORIGIN}/bank/assets/glb/0123456789abcdef.glb`;
const THUMB = `${ORIGIN}/bank/assets/thumb/0123456789abcdef.webp`;
const INDEX = `${ORIGIN}/api/bank/index`;

const route = (url: string, method = 'GET', range = false) =>
  routeFor(new URL(url), method, range, ORIGIN);

describe('routeFor', () => {
  test.each([
    [GLB, 'bank-model', 'cache-first', MEDIA_CACHE, true],
    [
      `${ORIGIN}/bank/assets/variant/0123456789abcdef.glb`,
      'bank-model',
      'cache-first',
      MEDIA_CACHE,
      true,
    ],
    [THUMB, 'bank-thumbnail', 'cache-first', MEDIA_CACHE, true],
    [INDEX, 'bank-index', 'stale-while-revalidate', INDEX_CACHE, false],
    [`${ORIGIN}/api/bank/search-index`, 'bank-index', 'stale-while-revalidate', INDEX_CACHE, false],
    [
      `${ORIGIN}/api/bank/elements/holder-screwdriver-6`,
      'bank-index',
      'stale-while-revalidate',
      INDEX_CACHE,
      false,
    ],
    [
      `${ORIGIN}/tools/assets/glb/0123456789abcdef.glb`,
      'tool-model',
      'cache-first',
      MEDIA_CACHE,
      true,
    ],
    [
      `${ORIGIN}/api/tools/assets/index`,
      'tool-index',
      'stale-while-revalidate',
      INDEX_CACHE,
      false,
    ],
    [`${ORIGIN}/api/tools`, 'tool-library', 'network-first', INDEX_CACHE, false],
    [`${ORIGIN}/api/tools/classes`, 'tool-library', 'network-first', INDEX_CACHE, false],
    [`${ORIGIN}/api/tools/classes/hex-key`, 'tool-library', 'network-first', INDEX_CACHE, false],
    [`${ORIGIN}/api/tools/tape-roll-10`, 'tool-library', 'network-first', INDEX_CACHE, false],
    [
      `${ORIGIN}/api/tools/tape-roll-10/holding`,
      'tool-library',
      'network-first',
      INDEX_CACHE,
      false,
    ],
    [
      `${ORIGIN}/api/tools/classes/hex-key/thumb.webp`,
      'tool-thumbnail',
      'stale-while-revalidate',
      MEDIA_CACHE,
      true,
    ],
    [
      `${ORIGIN}/api/tools/classes/hex-key/thumb.webp?preset=short`,
      'tool-thumbnail',
      'stale-while-revalidate',
      MEDIA_CACHE,
      true,
    ],
    [
      `${ORIGIN}/api/tools/chisel/thumb.webp?v=2026-10-23T21%3A17%3A49.317Z`,
      'tool-thumbnail',
      'cache-first',
      MEDIA_CACHE,
      true,
    ],
    [
      `${ORIGIN}/api/tools/chisel/model.glb?v=2026-10-23T21%3A17%3A49.317Z`,
      'tool-model',
      'cache-first',
      MEDIA_CACHE,
      true,
    ],
    [
      `${ORIGIN}/api/tools/chisel/model-lod1.glb?v=2026-10-23T21%3A17%3A49.317Z`,
      'tool-model',
      'cache-first',
      MEDIA_CACHE,
      true,
    ],
    [`${ORIGIN}/api/walls/w1/photos/p-1/file`, 'wall-photo', 'cache-first', MEDIA_CACHE, true],
    [`${ORIGIN}/api/walls/w1/models/m-1/file`, 'wall-model', 'cache-first', MEDIA_CACHE, true],
  ] as const)('%s is cached by rule', (url, category, strategy, cache, evictable) => {
    expect(route(url)).toEqual({ category, strategy, cache, evictable });
  });

  test.each([
    ['wall JSON', `${ORIGIN}/api/walls/w1`],
    ['wall list', `${ORIGIN}/api/walls`],
    ['SSE', `${ORIGIN}/api/walls/w1/events`],
    ['settings', `${ORIGIN}/api/settings`],
    ['bank search (server ranking)', `${ORIGIN}/api/bank/search?q=x`],
    ['variant build', `${ORIGIN}/api/bank/elements/holder-1/variant`],
    [
      'asset with a wrong extension for its kind',
      `${ORIGIN}/bank/assets/thumb/0123456789abcdef.glb`,
    ],
    ['asset with a query string', `${GLB}?v=2`],
    ['tool asset with a wrong extension', `${ORIGIN}/tools/assets/glb/0123456789abcdef.webp`],
    ['tool asset outside glb/', `${ORIGIN}/tools/assets/index.json`],
    [
      'class GLB (parameter values in the query)',
      `${ORIGIN}/api/tools/classes/hex-key/model.glb?lod=1&p=%7B%7D`,
    ],
    [
      'class holding (parameter values in the query)',
      `${ORIGIN}/api/tools/classes/hex-key/holding?p=%7B%7D`,
    ],
    ['class thumbnail with a foreign query', `${ORIGIN}/api/tools/classes/hex-key/thumb.webp?x=1`],
    ['library tool file without its version', `${ORIGIN}/api/tools/my-1/model.glb`],
    ['library tool thumbnail without its version', `${ORIGIN}/api/tools/my-1/thumb.webp`],
    ['library tool JSON with a query', `${ORIGIN}/api/tools/my-1?x=1`],
    ['draft list', `${ORIGIN}/api/tools/drafts`],
    ['draft', `${ORIGIN}/api/tools/drafts/d-1`],
    ['draft file', `${ORIGIN}/api/tools/drafts/d-1/files/crop.png`],
    ['vision liveness', `${ORIGIN}/api/tools/vision`],
    ['tool source file', `${ORIGIN}/api/tools/my-1/source/a.png`],
    ['unknown class resource', `${ORIGIN}/api/tools/classes/hex-key/other`],
    ['tool model index lookalike', `${ORIGIN}/api/tools/assets/other`],
    ['foreign origin', 'https://evil.test/bank/assets/glb/0123456789abcdef.glb'],
    ['upload path', `${ORIGIN}/api/walls/w1/photos`],
    ['health', `${ORIGIN}/api/health`],
  ])('%s is left to the network', (_name, url) => {
    expect(route(url)).toBeNull();
  });

  test('non-GET and Range requests are left to the network', () => {
    expect(route(GLB, 'POST')).toBeNull();
    expect(route(GLB, 'GET', true)).toBeNull();
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      expect(route(`${ORIGIN}/api/tools/my-1`, method)).toBeNull();
      expect(route(`${ORIGIN}/api/tools`, method)).toBeNull();
    }
  });
});

describe('whyUnstorable', () => {
  const resp = (status: number, headers: Record<string, string> = {}) =>
    new Response('x', { status, headers });
  test('only a plain 200 qualifies', () => {
    expect(whyUnstorable(resp(200))).toBeNull();
    for (const status of [204, 206, 301, 304, 404, 500, 503]) {
      expect(
        whyUnstorable(
          new Response(null, { status: status === 204 || status === 304 ? status : status }),
        ),
      ).toBe('status');
    }
  });
  test('an HTML 200 (SPA fallback) is refused', () => {
    expect(whyUnstorable(resp(200, { 'content-type': 'text/html; charset=utf-8' }))).toBe('html');
  });
  test('no-store is honoured', () => {
    expect(whyUnstorable(resp(200, { 'cache-control': 'private, no-store' }))).toBe('no-store');
  });
  test('an error response (status 0 / opaque-like) is refused', () => {
    expect(whyUnstorable(Response.error())).not.toBeNull();
  });
});

describe('cache-first (bank files)', () => {
  test('the first request hits the network and stores; the next is served from cache with the network down', async () => {
    const h = harness();
    const r = route(GLB);
    if (!r) throw new Error('no route');
    const first = await handleRuntimeRequest(h.deps, new Request(GLB), r);
    expect(first.status).toBe(200);
    await h.settle();
    expect(h.net.calls).toEqual([GLB]);
    expect(h.storage.cache(MEDIA_CACHE).entries.has(GLB)).toBe(true);

    h.net.online = false;
    const second = await handleRuntimeRequest(h.deps, new Request(GLB), r);
    expect(second.status).toBe(200);
    expect(await second.text()).toHaveLength(10);
    expect(h.net.calls).toEqual([GLB]);
  });

  test('a cached file survives the server answering 404 for that name later', async () => {
    const h = harness();
    const r = route(GLB);
    if (!r) throw new Error('no route');
    await handleRuntimeRequest(h.deps, new Request(GLB), r);
    await h.settle();
    h.net.respond = () => new Response('{"error":"asset_not_found"}', { status: 404 });
    const again = await handleRuntimeRequest(h.deps, new Request(GLB), r);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe('x'.repeat(10));
  });

  test.each([
    ['a 404', () => new Response('{"error":"asset_not_found"}', { status: 404 }), 'status'],
    ['a 503 (bank not built)', () => new Response('{}', { status: 503 }), 'status'],
    [
      'an SPA-fallback 200 text/html',
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      'html',
    ],
  ] as const)('%s is returned to the page but never stored', async (_name, respond, why) => {
    const h = harness();
    h.net.respond = respond;
    const r = route(GLB);
    if (!r) throw new Error('no route');
    const response = await handleRuntimeRequest(h.deps, new Request(GLB), r);
    await h.settle();
    expect(response.status).toBe(respond().status);
    expect(h.storage.stores.get(MEDIA_CACHE)?.entries.size ?? 0).toBe(0);
    expect(await h.registry.all()).toEqual([]);
    expect(h.refused).toEqual([[GLB, why]]);
  });

  test('a failed registry write rolls the stored copy back, so the cache never holds an unaccounted file', async () => {
    const h = harness();
    const r = route(GLB);
    if (!r) throw new Error('no route');
    h.registry.record = () => Promise.reject(new Error('idb gone'));
    await expect(storeResponse(h.deps, new Request(GLB), bytesOf(10), r)).rejects.toThrow(
      'idb gone',
    );
    expect(h.storage.cache(MEDIA_CACHE).entries.size).toBe(0);
  });

  test('a failed registry write keeps a previously stored copy of the same file', async () => {
    const h = harness();
    const r = route(GLB);
    if (!r) throw new Error('no route');
    await storeResponse(h.deps, new Request(GLB), bytesOf(10), r);
    h.registry.record = () => Promise.reject(new Error('idb gone'));
    await expect(storeResponse(h.deps, new Request(GLB), bytesOf(12), r)).rejects.toThrow();
    expect(h.storage.cache(MEDIA_CACHE).entries.has(GLB)).toBe(true);
  });

  test('offline with nothing cached is a network error, not a fake response', async () => {
    const h = harness();
    h.net.online = false;
    const r = route(GLB);
    if (!r) throw new Error('no route');
    await expect(handleRuntimeRequest(h.deps, new Request(GLB), r)).rejects.toThrow(
      'Failed to fetch',
    );
  });

  test('simultaneous requests for one file download it once', async () => {
    const h = harness();
    const r = route(THUMB);
    if (!r) throw new Error('no route');
    const [a, b, c] = await Promise.all([
      handleRuntimeRequest(h.deps, new Request(THUMB), r),
      handleRuntimeRequest(h.deps, new Request(THUMB), r),
      handleRuntimeRequest(h.deps, new Request(THUMB), r),
    ]);
    expect(h.net.calls).toEqual([THUMB]);
    expect([await a.text(), await b.text(), await c.text()].map((t) => t.length)).toEqual([
      10, 10, 10,
    ]);
  });

  test('records size, category and last use in the registry', async () => {
    const h = harness();
    h.net.respond = () => bytesOf(2048);
    h.setNow(5000);
    const r = route(GLB);
    if (!r) throw new Error('no route');
    await handleRuntimeRequest(h.deps, new Request(GLB), r);
    await h.settle();
    expect(await h.registry.all()).toEqual([
      {
        url: GLB,
        cache: MEDIA_CACHE,
        category: 'bank-model',
        bytes: 2048,
        lastUsed: 5000,
        pinned: false,
        evictable: true,
      },
    ]);
  });

  test('a failing cache write is reported, not turned into a failed request', async () => {
    const h = harness();
    const cache = await h.storage.open(MEDIA_CACHE);
    cache.failNextPut = new Error('disk on fire');
    const r = route(GLB);
    if (!r) throw new Error('no route');
    const response = await handleRuntimeRequest(h.deps, new Request(GLB), r);
    await h.settle();
    expect(response.status).toBe(200);
    expect(h.errors.map(([url]) => url)).toEqual([GLB]);
  });
});

describe('stale-while-revalidate (bank index)', () => {
  const idxRoute = () => {
    const r = route(INDEX);
    if (!r) throw new Error('no route');
    return r;
  };

  test('first visit waits for the network; later visits answer from cache at once and refresh in the background', async () => {
    const h = harness();
    h.net.respond = () =>
      new Response('{"v":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    const first = await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute());
    expect(await first.text()).toBe('{"v":1}');
    await h.settle();

    h.net.respond = () =>
      new Response('{"v":2}', { status: 200, headers: { 'content-type': 'application/json' } });
    const second = await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute());
    expect(await second.text()).toBe('{"v":1}');
    await h.settle();
    const third = await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute());
    expect(await third.text()).toBe('{"v":2}');
  });

  test('offline: the cached index is served and the failed revalidation is swallowed', async () => {
    const h = harness();
    h.net.respond = () =>
      new Response('{"v":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute());
    await h.settle();
    h.net.online = false;
    const offline = await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute());
    expect(await offline.text()).toBe('{"v":1}');
    await h.settle();
  });

  test('a 503 or a 404 revalidation never replaces the good copy', async () => {
    const h = harness();
    h.net.respond = () =>
      new Response('{"v":1}', { status: 200, headers: { 'content-type': 'application/json' } });
    await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute());
    await h.settle();
    for (const status of [503, 404]) {
      h.net.respond = () => new Response('{"error":"x"}', { status });
      await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute());
      await h.settle();
    }
    h.net.online = false;
    expect(await (await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute())).text()).toBe(
      '{"v":1}',
    );
  });

  test('offline with nothing cached fails', async () => {
    const h = harness();
    h.net.online = false;
    await expect(handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute())).rejects.toThrow();
  });

  test('index entries are never evicted, however small the budget', async () => {
    const h = harness();
    h.setBudget(1);
    h.net.respond = () =>
      new Response('{"v":1}'.repeat(100), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await handleRuntimeRequest(h.deps, new Request(INDEX), idxRoute());
    await h.settle();
    expect(h.storage.cache(INDEX_CACHE).entries.has(INDEX)).toBe(true);
  });
});

describe('LRU eviction under the byte budget', () => {
  const file = (n: number) => `${ORIGIN}/bank/assets/glb/${n.toString(16).padStart(16, '0')}.glb`;
  async function store(h: ReturnType<typeof harness>, url: string, size: number, at: number) {
    h.setNow(at);
    const r = route(url);
    if (!r) throw new Error('no route');
    h.net.respond = () => bytesOf(size);
    await handleRuntimeRequest(h.deps, new Request(url), r);
    await h.settle();
  }

  test('drops the least recently used until the cache fits, never the file just stored', async () => {
    const h = harness();
    h.setBudget(250);
    await store(h, file(1), 100, 1);
    await store(h, file(2), 100, 2);
    await store(h, file(3), 100, 3);
    const cached = [...h.storage.cache(MEDIA_CACHE).entries.keys()];
    expect(cached.sort()).toEqual([file(2), file(3)]);
    expect((await h.registry.all()).map((e) => e.url).sort()).toEqual([file(2), file(3)]);
  });

  test('a cache hit refreshes recency', async () => {
    const h = harness();
    h.setBudget(250);
    await store(h, file(1), 100, 1);
    await store(h, file(2), 100, 2);
    h.setNow(3);
    const r = route(file(1));
    if (!r) throw new Error('no route');
    await handleRuntimeRequest(h.deps, new Request(file(1)), r); // hit: touches file 1
    await h.registry.flushTouches();
    await store(h, file(3), 100, 4);
    expect([...h.storage.cache(MEDIA_CACHE).entries.keys()].sort()).toEqual([file(1), file(3)]);
  });

  test('pinned entries are never evicted, even over budget', async () => {
    const h = harness();
    h.setBudget(150);
    await store(h, file(1), 100, 1);
    await h.registry.setPinned([file(1)], true);
    await store(h, file(2), 100, 2);
    await store(h, file(3), 100, 3);
    expect([...h.storage.cache(MEDIA_CACHE).entries.keys()]).toContain(file(1));
    expect(h.storage.cache(MEDIA_CACHE).entries.has(file(2))).toBe(false);
  });

  test('a pin survives the file being fetched again', async () => {
    const h = harness();
    await store(h, file(1), 100, 1);
    await h.registry.setPinned([file(1)], true);
    const r = route(file(1));
    if (!r) throw new Error('no route');
    await storeResponse(h.deps, new Request(file(1)), bytesOf(120), r);
    expect((await h.registry.all())[0]).toMatchObject({ pinned: true, bytes: 120 });
  });

  test('a quota error evicts and retries once, then gives up quietly', async () => {
    const h = harness();
    await store(h, file(1), 100, 1);
    await store(h, file(2), 100, 2);
    const cache = h.storage.cache(MEDIA_CACHE);
    cache.failNextPut = new DOMException('full', 'QuotaExceededError');
    h.setBudget(150);
    await store(h, file(3), 100, 3);
    expect(cache.entries.has(file(3))).toBe(true);
    expect(cache.entries.has(file(1))).toBe(false);

    const failing = harness();
    const full = await failing.storage.open(MEDIA_CACHE);
    const rr = route(file(9));
    if (!rr) throw new Error('no route');
    const original = full.put.bind(full);
    full.put = () => Promise.reject(new DOMException('full', 'QuotaExceededError'));
    expect(await storeResponse(failing.deps, new Request(file(9)), bytesOf(10), rr)).toBeNull();
    full.put = original;
  });
});

describe('planEviction', () => {
  const entry = (
    url: string,
    bytes: number,
    lastUsed: number,
    extra: Partial<AssetEntry> = {},
  ): AssetEntry => ({
    url,
    cache: MEDIA_CACHE,
    category: 'bank-model',
    bytes,
    lastUsed,
    pinned: false,
    evictable: true,
    ...extra,
  });

  test('nothing to do under budget', () => {
    expect(planEviction([entry('a', 10, 1)], MEDIA_CACHE, 10)).toEqual([]);
  });

  test('when pinned bytes alone exceed the budget nothing is evicted: it could not help', () => {
    const entries = [
      entry('pinned', 100, 1, { pinned: true }),
      entry('a', 10, 2),
      entry('b', 10, 3),
    ];
    expect(planEviction(entries, MEDIA_CACHE, 50)).toEqual([]);
  });

  test('oldest first, only as many as needed', () => {
    const entries = [entry('c', 10, 3), entry('a', 10, 1), entry('b', 10, 2)];
    expect(planEviction(entries, MEDIA_CACHE, 20)).toEqual(['a']);
    expect(planEviction(entries, MEDIA_CACHE, 10)).toEqual(['a', 'b']);
  });

  test('pinned, non-evictable, protected and foreign-cache entries are not chosen', () => {
    const entries = [
      entry('pinned', 50, 1, { pinned: true }),
      entry('index', 50, 1, { evictable: false }),
      entry('keep', 50, 1),
      entry('other', 500, 1, { cache: INDEX_CACHE }),
      entry('old', 50, 2),
    ];
    expect(planEviction(entries, MEDIA_CACHE, 150, new Set(['keep']))).toEqual(['old']);
  });
});

describe('effectiveBudget', () => {
  test('defaults to 1 GiB, capped at half the quota, never below the floor', () => {
    expect(effectiveBudget(undefined, undefined)).toBe(1024 ** 3);
    expect(effectiveBudget(undefined, 400 * 1024 * 1024)).toBe(200 * 1024 * 1024);
    expect(effectiveBudget(10 * 1024 ** 3, 100 * 1024 ** 3)).toBe(10 * 1024 ** 3);
    expect(effectiveBudget(1, undefined)).toBe(MIN_MEDIA_BUDGET_BYTES);
  });
});

describe('registry concurrency', () => {
  test('a pin set by the downloader survives the worker recording the same file concurrently', async () => {
    const h = harness();
    const url = `${ORIGIN}/bank/assets/glb/${(1).toString(16).padStart(16, '0')}.glb`;
    await Promise.all([
      h.registry.record({
        url,
        cache: MEDIA_CACHE,
        category: 'bank-model',
        bytes: 10,
        evictable: true,
        pinned: true,
      }),
      h.registry.record({
        url,
        cache: MEDIA_CACHE,
        category: 'bank-model',
        bytes: 10,
        evictable: true,
      }),
    ]);
    expect((await h.registry.all())[0]?.pinned).toBe(true);
    await Promise.all([h.registry.setPinned([url], true), h.registry.flushTouches()]);
    expect((await h.registry.all())[0]?.pinned).toBe(true);
  });

  test('cache hits reach the registry without waiting for fifty of them', async () => {
    const h = harness();
    const url = `${ORIGIN}/bank/assets/thumb/${(2).toString(16).padStart(16, '0')}.webp`;
    const r = route(url);
    if (!r) throw new Error('no route');
    h.setNow(10);
    await handleRuntimeRequest(h.deps, new Request(url), r);
    await h.settle();
    h.setNow(500);
    await handleRuntimeRequest(h.deps, new Request(url), r); // a hit
    await h.settle();
    expect((await h.registry.all())[0]?.lastUsed).toBe(500);
  });
});

describe('tool library (network-first)', () => {
  const LIST = `${ORIGIN}/api/tools`;
  const CLASSES = `${ORIGIN}/api/tools/classes`;
  const TOOL = `${ORIGIN}/api/tools/chisel`;
  const HOLDING = `${ORIGIN}/api/tools/chisel/holding`;
  const CLASS_THUMB = `${ORIGIN}/api/tools/classes/chisel/thumb.webp`;
  const TOOL_THUMB = `${ORIGIN}/api/tools/chisel/thumb.webp?v=2026-10-23T21%3A17%3A49.317Z`;
  const json =
    (body: string, status = 200) =>
    () =>
      new Response(body, { status, headers: { 'content-type': 'application/json' } });

  async function fetchThrough(h: ReturnType<typeof harness>, url: string): Promise<Response> {
    const r = route(url);
    if (!r) throw new Error(`no route for ${url}`);
    const response = await handleRuntimeRequest(h.deps, new Request(url), r);
    await h.settle();
    return response;
  }

  test('the list, classes, a tool and a thumbnail are served with the daemon stopped after one visit', async () => {
    const h = harness();
    h.net.respond = (url) =>
      url.includes('thumb.webp')
        ? bytesOf(7, { 'content-type': 'image/webp' })
        : json(`{"u":"${url}"}`)();
    for (const url of [LIST, CLASSES, TOOL, HOLDING, CLASS_THUMB, TOOL_THUMB]) {
      expect((await fetchThrough(h, url)).status).toBe(200);
    }
    h.net.online = false;
    for (const url of [LIST, CLASSES, TOOL, HOLDING]) {
      expect(await (await fetchThrough(h, url)).json()).toEqual({ u: url });
    }
    for (const url of [CLASS_THUMB, TOOL_THUMB]) {
      expect((await (await fetchThrough(h, url)).arrayBuffer()).byteLength).toBe(7);
    }
    const cats = new Map((await h.registry.all()).map((e) => [e.url, e.category]));
    expect(cats.get(LIST)).toBe('tool-library');
    expect(cats.get(TOOL_THUMB)).toBe('tool-thumbnail');
  });

  test('online the daemon always wins: a tool changed behind the page (CLI, agent) shows at once, never the cached copy', async () => {
    const h = harness();
    h.net.respond = json('{"tool":"v1"}');
    await fetchThrough(h, TOOL);
    h.net.respond = json('{"tool":"v2"}');
    expect(await (await fetchThrough(h, TOOL)).json()).toEqual({ tool: 'v2' });
    h.net.online = false;
    expect(await (await fetchThrough(h, TOOL)).json()).toEqual({ tool: 'v2' });
  });

  test('an answer made from the kept copy is marked, one from the daemon is not', async () => {
    const h = harness();
    h.net.respond = json('{"tool":"v1"}');
    expect((await fetchThrough(h, TOOL)).headers.has(OFFLINE_COPY_HEADER)).toBe(false);
    h.net.online = false;
    const copy = await fetchThrough(h, TOOL);
    expect(copy.headers.get(OFFLINE_COPY_HEADER)).toBe('1');
    expect(copy.headers.get('content-type')).toBe('application/json');
    expect(await copy.json()).toEqual({ tool: 'v1' });
    h.net.online = true;
    h.net.respond = json('down', 503);
    expect((await fetchThrough(h, TOOL)).headers.get(OFFLINE_COPY_HEADER)).toBe('1');
  });

  test('library JSON lives in the never-evicted index cache, thumbnails in the evictable media cache', async () => {
    const h = harness();
    h.net.respond = (url) => (url.includes('thumb.webp') ? bytesOf(7) : json('{}')());
    await fetchThrough(h, LIST);
    await fetchThrough(h, CLASS_THUMB);
    const byUrl = new Map((await h.registry.all()).map((e) => [e.url, e]));
    expect(byUrl.get(LIST)).toMatchObject({ cache: INDEX_CACHE, evictable: false });
    expect(byUrl.get(CLASS_THUMB)).toMatchObject({ cache: MEDIA_CACHE, evictable: true });
  });

  test('a 5xx or an HTML answer never replaces a good copy and the copy answers a 5xx', async () => {
    const h = harness();
    h.net.respond = json('{"tools":[1]}');
    await fetchThrough(h, LIST);
    h.net.respond = json('down', 503);
    expect(await (await fetchThrough(h, LIST)).json()).toEqual({ tools: [1] });
    h.net.respond = () =>
      new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    await fetchThrough(h, LIST);
    h.net.online = false;
    expect(await (await fetchThrough(h, LIST)).json()).toEqual({ tools: [1] });
  });

  test('a 5xx with nothing cached is passed on as it is', async () => {
    const h = harness();
    h.net.respond = json('down', 503);
    expect((await fetchThrough(h, LIST)).status).toBe(503);
  });

  test('a 404 (the tool was deleted) is passed on and drops the cached copy, offline too', async () => {
    const h = harness();
    h.net.respond = json('{"tool":{}}');
    await fetchThrough(h, TOOL);
    h.net.respond = json('{"error":{"code":"not_found"}}', 404);
    expect((await fetchThrough(h, TOOL)).status).toBe(404);
    expect(h.storage.stores.get(INDEX_CACHE)?.entries.has(TOOL)).toBe(false);
    expect((await h.registry.all()).some((e) => e.url === TOOL)).toBe(false);
    h.net.online = false;
    await expect(fetchThrough(h, TOOL)).rejects.toThrow('Failed to fetch');
  });

  test('offline with nothing cached the failure reaches the caller', async () => {
    const h = harness();
    h.net.online = false;
    await expect(fetchThrough(h, LIST)).rejects.toThrow('Failed to fetch');
  });

  test('ids that merely start with a reserved word are library tools', () => {
    for (const id of ['classes-2', 'drafts-old', 'visions', 'assets-1']) {
      expect(route(`${ORIGIN}/api/tools/${id}`)?.category).toBe('tool-library');
      expect(route(`${ORIGIN}/api/tools/${id}/holding`)?.category).toBe('tool-library');
    }
  });
});
