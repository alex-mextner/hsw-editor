import { describe, expect, test } from 'bun:test';
import { INDEX_CACHE, MEDIA_CACHE } from './cachePolicy.ts';
import {
  bankAssetUrls,
  buildReport,
  clearCategories,
  downloadAssets,
  wallMediaUrls,
  type BankIndexLike,
} from './storage.ts';
import { bytesOf, harness } from './fakes.ts';

const ORIGIN = 'https://hsw.test';
const hex = (n: number) => n.toString(16).padStart(16, '0');

const element = (id: string, category: string, n: number, sameLod = false) => ({
  id,
  category,
  assets: {
    lod0: { path: `glb/${hex(n)}.glb` },
    lod1: { path: sameLod ? `glb/${hex(n)}.glb` : `glb/${hex(n + 1000)}.glb` },
    thumbnail: { path: `thumb/${hex(n)}.webp` },
  },
});

const INDEX: BankIndexLike = {
  elements: [
    element('h1', 'holders/screwdrivers', 1),
    element('h2', 'holders/pliers', 2, true),
    element('b1', 'bins', 3),
  ],
};

describe('bankAssetUrls', () => {
  test('whole bank, thumbnails and models, deduplicated', () => {
    const urls = bankAssetUrls(INDEX, { categories: [], thumbnails: true, models: true }, ORIGIN);
    // h1: thumb + lod0 + lod1; h2: thumb + one shared GLB; b1: thumb + lod0 + lod1
    expect(urls).toHaveLength(3 + 2 + 3);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls[0]).toBe(`${ORIGIN}/bank/assets/thumb/${hex(1)}.webp`);
  });

  test('a category selects its whole subtree and not a sibling with the same prefix', () => {
    const urls = bankAssetUrls(
      {
        elements: [
          element('a', 'holders/screwdrivers', 1),
          element('b', 'holders-extra', 2),
          element('c', 'holders', 3),
        ],
      },
      { categories: ['holders'], thumbnails: true, models: false },
      ORIGIN,
    );
    expect(urls).toEqual([
      `${ORIGIN}/bank/assets/thumb/${hex(1)}.webp`,
      `${ORIGIN}/bank/assets/thumb/${hex(3)}.webp`,
    ]);
  });

  test('thumbnails only, models only', () => {
    expect(
      bankAssetUrls(INDEX, { categories: ['bins'], thumbnails: true, models: false }, ORIGIN),
    ).toHaveLength(1);
    expect(
      bankAssetUrls(INDEX, { categories: ['bins'], thumbnails: false, models: true }, ORIGIN),
    ).toHaveLength(2);
  });
});

describe('wallMediaUrls', () => {
  test('photos and models with a stored file; bank-only model references have none', () => {
    expect(
      wallMediaUrls(
        {
          id: 'w 1',
          photos: [{ id: 'p-1' }],
          models: [{ id: 'm-1', file: 'models/m-1.glb' }, { id: 'm-2' }],
        },
        ORIGIN,
      ),
    ).toEqual([
      `${ORIGIN}/api/walls/w%201/photos/p-1/file`,
      `${ORIGIN}/api/walls/w%201/models/m-1/file`,
    ]);
  });
});

describe('downloadAssets', () => {
  const files = (count: number) =>
    Array.from({ length: count }, (_, i) => `${ORIGIN}/bank/assets/glb/${hex(i + 1)}.glb`);

  test('downloads, stores and pins everything, reporting progress', async () => {
    const h = harness();
    const seen: number[] = [];
    const result = await downloadAssets(h.deps, files(5), {
      origin: ORIGIN,
      pin: true,
      onProgress: (p) => seen.push(p.done),
    });
    expect(result).toMatchObject({ outcome: 'complete', total: 5, done: 5, failed: 0 });
    expect(seen.at(-1)).toBe(5);
    expect(h.storage.cache(MEDIA_CACHE).entries.size).toBe(5);
    expect((await h.registry.all()).every((entry) => entry.pinned)).toBe(true);
  });

  test('already cached files are not downloaded again, only pinned', async () => {
    const h = harness();
    const [first, ...rest] = files(3);
    if (!first) throw new Error('fixture');
    await downloadAssets(h.deps, [first], { origin: ORIGIN, pin: false });
    h.net.calls.length = 0;
    await downloadAssets(h.deps, [first, ...rest], { origin: ORIGIN, pin: true });
    expect(h.net.calls).toEqual(rest);
    expect((await h.registry.all()).find((entry) => entry.url === first)?.pinned).toBe(true);
  });

  test('a 404 counts as failed and the run goes on', async () => {
    const h = harness();
    const [missing] = files(1);
    h.net.respond = (url) => (url === missing ? new Response('{}', { status: 404 }) : bytesOf(10));
    const result = await downloadAssets(h.deps, files(3), { origin: ORIGIN, pin: true });
    expect(result).toMatchObject({ outcome: 'complete', done: 2, failed: 1 });
  });

  test('losing the network stops the run as offline and keeps what was stored', async () => {
    const h = harness();
    let calls = 0;
    const fetchOriginal = h.deps.fetch;
    const deps = {
      ...h.deps,
      fetch: (request: Request) => {
        calls += 1;
        return calls > 2
          ? Promise.reject(new TypeError('Failed to fetch'))
          : fetchOriginal(request);
      },
    };
    const result = await downloadAssets(deps, files(8), {
      origin: ORIGIN,
      pin: true,
      concurrency: 1,
    });
    expect(result.outcome).toBe('offline');
    expect(result.done).toBe(2);
    expect(h.storage.cache(MEDIA_CACHE).entries.size).toBe(2);
  });

  test('a connection that drops while the body is stored ends the run as offline, not as an exception', async () => {
    const h = harness();
    const original = h.storage.open.bind(h.storage);
    let first = true;
    h.storage.open = async (name: string) => {
      const cache = await original(name);
      if (first) {
        first = false;
        return cache;
      }
      cache.failNextPut = new TypeError('network error while reading the body');
      return cache;
    };
    const result = await downloadAssets(h.deps, files(4), {
      origin: ORIGIN,
      pin: true,
      concurrency: 1,
    });
    expect(result.outcome).toBe('offline');
  });

  test('cancelling stops before the next file', async () => {
    const h = harness();
    const controller = new AbortController();
    const result = await downloadAssets(h.deps, files(6), {
      origin: ORIGIN,
      pin: true,
      concurrency: 1,
      signal: controller.signal,
      onProgress: (p) => {
        if (p.done === 2) controller.abort();
      },
    });
    expect(result.outcome).toBe('cancelled');
    expect(result.done).toBe(2);
  });

  test('stops before filling the browser quota', async () => {
    const h = harness();
    const result = await downloadAssets(h.deps, files(4), {
      origin: ORIGIN,
      pin: true,
      concurrency: 1,
      env: { estimate: () => Promise.resolve({ usage: 95, quota: 100 }) },
    });
    expect(result.outcome).toBe('quota');
    expect(result.done).toBe(0);
    expect(h.net.calls).toEqual([]);
  });

  test('urls the worker would not cache are failures, not network calls', async () => {
    const h = harness();
    const result = await downloadAssets(h.deps, [`${ORIGIN}/api/walls/w1`], {
      origin: ORIGIN,
      pin: true,
    });
    expect(result).toMatchObject({ outcome: 'complete', failed: 1, done: 0 });
    expect(h.net.calls).toEqual([]);
  });

  test('duplicate urls are fetched once', async () => {
    const h = harness();
    const [one] = files(1);
    if (!one) throw new Error('fixture');
    await downloadAssets(h.deps, [one, one, one], { origin: ORIGIN, pin: true });
    expect(h.net.calls).toEqual([one]);
  });
});

describe('clearCategories and buildReport', () => {
  test('clearing a category removes its files from the cache and the registry, pinned or not', async () => {
    const h = harness();
    h.net.respond = () => bytesOf(100);
    const glb = `${ORIGIN}/bank/assets/glb/${hex(1)}.glb`;
    const thumb = `${ORIGIN}/bank/assets/thumb/${hex(1)}.webp`;
    await downloadAssets(h.deps, [glb, thumb], { origin: ORIGIN, pin: true });
    expect(await clearCategories(h.deps, ['bank-model'])).toBe(1);
    expect(h.storage.cache(MEDIA_CACHE).entries.has(glb)).toBe(false);
    expect(h.storage.cache(MEDIA_CACHE).entries.has(thumb)).toBe(true);
    expect((await h.registry.all()).map((e) => e.url)).toEqual([thumb]);
  });

  test('the report sums categories and pinned bytes next to the browser estimate', async () => {
    const h = harness();
    h.net.respond = () => bytesOf(100);
    h.setBudget(5000);
    const glb = `${ORIGIN}/bank/assets/glb/${hex(1)}.glb`;
    const thumb = `${ORIGIN}/bank/assets/thumb/${hex(1)}.webp`;
    await downloadAssets(h.deps, [glb], { origin: ORIGIN, pin: true });
    await downloadAssets(h.deps, [thumb], { origin: ORIGIN, pin: false });
    const report = await buildReport(h.deps, {
      estimate: () => Promise.resolve({ usage: 7000, quota: 90_000 }),
      persisted: () => Promise.resolve(true),
    });
    expect(report).toMatchObject({
      usage: 7000,
      quota: 90_000,
      persisted: true,
      budget: 5000,
      offlineBytes: 200,
      pinnedBytes: 100,
    });
    expect(report.categories['bank-model']).toMatchObject({ count: 1, bytes: 100, pinnedCount: 1 });
    expect(report.categories['bank-thumbnail']).toMatchObject({ count: 1, pinnedCount: 0 });
    expect(report.categories['wall-photo'].count).toBe(0);
  });

  test('index entries live in their own cache and are unaffected by clearing models', async () => {
    const h = harness();
    const index = `${ORIGIN}/api/bank/index`;
    h.net.respond = () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await downloadAssets(h.deps, [index], { origin: ORIGIN, pin: true });
    await clearCategories(h.deps, ['bank-model', 'bank-thumbnail']);
    expect(h.storage.cache(INDEX_CACHE).entries.has(index)).toBe(true);
  });
});
