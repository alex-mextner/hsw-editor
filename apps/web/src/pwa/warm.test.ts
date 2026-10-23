import { describe, expect, test } from 'bun:test';
import { routeFor } from './cachePolicy.ts';
import { bytesOf, harness } from './fakes.ts';
import { downloadAssets } from './storage.ts';
import {
  createWarmup,
  dropStaleLibraryEntries,
  libraryWarmUrls,
  type LibrarySnapshot,
  type WallSnapshot,
} from './warm.ts';

const ORIGIN = 'https://hsw.test';
const LIBRARY: LibrarySnapshot = {
  classes: [{ id: 'hex-key' }, { id: 'tape-roll' }],
  tools: [
    { id: 'chisel', updatedAt: '2026-10-23T21:17:49.317Z' },
    { id: 'tape-roll-10', updatedAt: '2026-10-22T08:00:00.000Z' },
  ],
};
const WALL: WallSnapshot = {
  id: 'w1',
  photos: [{ id: 'p-1' }, { id: 'p-2-clean' }],
  models: [{ id: 'm-1', file: 'models/m-1.glb' }, { id: 'm-2' }],
};

describe('libraryWarmUrls', () => {
  test('every URL is one the worker stores, in the cache its kind belongs to', () => {
    const urls = libraryWarmUrls(LIBRARY, ORIGIN);
    expect(urls).toHaveLength(2 + 2 + 2 * 4);
    for (const url of urls) {
      expect(routeFor(new URL(url), 'GET', false, ORIGIN)).not.toBeNull();
    }
    expect(urls).toContain(`${ORIGIN}/api/tools/chisel/thumb.webp?v=2026-10-23T21%3A17%3A49.317Z`);
    expect(urls).toContain(`${ORIGIN}/api/tools/classes/hex-key/thumb.webp`);
    expect(urls).toContain(`${ORIGIN}/api/tools/chisel/model.glb?v=2026-10-23T21%3A17%3A49.317Z`);
  });
});

describe('dropStaleLibraryEntries', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  async function seed(h: ReturnType<typeof harness>, entries: Record<string, unknown>) {
    const cache = await h.deps.caches.open('hsw-bank-index-v1');
    for (const [path, body] of Object.entries(entries)) {
      await cache.put(new Request(`${ORIGIN}${path}`), json(body));
      await h.registry.record({
        url: `${ORIGIN}${path}`,
        cache: 'hsw-bank-index-v1',
        category: 'tool-library',
        bytes: 10,
        evictable: false,
      });
    }
    return cache;
  }

  test('a tool changed behind the page and a tool that is gone lose their kept JSON and holding, the rest stays', async () => {
    const h = harness();
    const cache = await seed(h, {
      '/api/tools': { tools: [] },
      '/api/tools/classes': { classes: [] },
      '/api/tools/chisel': { tool: { updatedAt: '2026-10-01T00:00:00.000Z' } },
      '/api/tools/chisel/holding': {},
      '/api/tools/tape-roll-10': { tool: { updatedAt: '2026-10-22T08:00:00.000Z' } },
      '/api/tools/tape-roll-10/holding': {},
      '/api/tools/gone': { tool: { updatedAt: 'x' } },
      '/api/tools/gone/holding': {},
      '/api/tools/classes-2': { tool: { updatedAt: '2026-10-22T08:00:00.000Z' } },
    });
    const dropped = await dropStaleLibraryEntries(
      h.deps,
      {
        classes: [],
        tools: [
          { id: 'chisel', updatedAt: '2026-10-23T21:17:49.317Z' },
          { id: 'tape-roll-10', updatedAt: '2026-10-22T08:00:00.000Z' },
          { id: 'classes-2', updatedAt: '2026-10-22T08:00:00.000Z' },
        ],
      },
      ORIGIN,
    );
    expect(dropped.map((u) => u.replace(ORIGIN, '')).sort()).toEqual([
      '/api/tools/chisel',
      '/api/tools/chisel/holding',
      '/api/tools/gone',
      '/api/tools/gone/holding',
    ]);
    expect((await cache.keys()).map((k) => k.url.replace(ORIGIN, '')).sort()).toEqual([
      '/api/tools',
      '/api/tools/classes',
      '/api/tools/classes-2',
      '/api/tools/tape-roll-10',
      '/api/tools/tape-roll-10/holding',
    ]);
    expect((await h.registry.all()).some((e) => e.url.endsWith('/gone'))).toBe(false);
  });

  test('an unreadable kept copy counts as stale', async () => {
    const h = harness();
    const cache = await h.deps.caches.open('hsw-bank-index-v1');
    await cache.put(new Request(`${ORIGIN}/api/tools/chisel`), new Response('not json'));
    const dropped = await dropStaleLibraryEntries(
      h.deps,
      { classes: [], tools: [{ id: 'chisel', updatedAt: 'v1' }] },
      ORIGIN,
    );
    expect(dropped).toEqual([`${ORIGIN}/api/tools/chisel`]);
  });

  test('a library run refetches the changed tool and only that one', async () => {
    const h = harness();
    const warm = createWarmup({
      origin: ORIGIN,
      deps: () => Promise.resolve(h.deps),
      download: downloadAssets,
    });
    h.net.respond = (url) =>
      url.includes('/api/tools/chisel') && !url.includes('.')
        ? json({ tool: { updatedAt: url.includes('holding') ? 'n/a' : 'v1' } })
        : url.includes('thumb.webp') || url.includes('.glb')
          ? bytesOf(4)
          : json({ tool: { updatedAt: 'v1' } });
    const library = { classes: [], tools: [{ id: 'chisel', updatedAt: 'v1' }] };
    warm.library(library);
    await warm.idle();
    h.net.calls.length = 0;
    warm.library({ classes: [], tools: [{ id: 'chisel', updatedAt: 'v2' }] });
    await warm.idle();
    expect(h.net.calls.map((u) => u.replace(ORIGIN, ''))).toContain('/api/tools/chisel');
    expect(h.net.calls.map((u) => u.replace(ORIGIN, ''))).toContain('/api/tools/chisel/holding');
    expect(h.net.calls.some((u) => u.includes('thumb.webp?v=v2'))).toBe(true);
    expect(h.net.calls.some((u) => u === `${ORIGIN}/api/tools`)).toBe(false);
  });
});

describe('a run that does not pin', () => {
  test('leaves the pin the user set on a file the run downloads anyway (pin and warmup racing for one file)', async () => {
    const h = harness();
    const url = `${ORIGIN}/api/walls/w1/photos/p-1/file`;
    await h.registry.record({
      url,
      cache: 'hsw-media-v1',
      category: 'wall-photo',
      bytes: 5,
      evictable: true,
      pinned: true,
    });
    h.net.respond = () => bytesOf(5);
    await downloadAssets(h.deps, [url], { origin: ORIGIN, pin: false });
    expect((await h.registry.all()).find((e) => e.url === url)?.pinned).toBe(true);
  });
});

describe('createWarmup', () => {
  function fixture() {
    const h = harness();
    const calls: string[][] = [];
    let outcome: 'complete' | 'offline' = 'complete';
    const warm = createWarmup({
      origin: ORIGIN,
      deps: () => Promise.resolve(h.deps),
      download: (deps, urls, options) => {
        calls.push([...urls]);
        expect(options.pin).toBe(false);
        return outcome === 'complete'
          ? downloadAssets(deps, urls, options)
          : Promise.resolve({ total: urls.length, done: 0, failed: 0, bytes: 0, outcome });
      },
    });
    return {
      h,
      warm,
      calls,
      setOutcome: (next: 'complete' | 'offline') => {
        outcome = next;
      },
    };
  }

  test('a wall photo that photo mode shows (the cleaned variant) is cached from one online visit, not only the thumbnail', async () => {
    const { h, warm } = fixture();
    h.net.respond = () => bytesOf(5);
    warm.wall(WALL);
    await warm.idle();
    h.net.online = false;
    const cache = await h.deps.caches.open('hsw-media-v1');
    expect(await cache.match(`${ORIGIN}/api/walls/w1/photos/p-1/file`)).toBeDefined();
    expect(await cache.match(`${ORIGIN}/api/walls/w1/photos/p-2-clean/file`)).toBeDefined();
    expect(await cache.match(`${ORIGIN}/api/walls/w1/models/m-1/file`)).toBeDefined();
    expect(await cache.match(`${ORIGIN}/api/walls/w1/models/m-2/file`)).toBeUndefined();
  });

  test('the tool library is cached from one online visit and served with the daemon down', async () => {
    const { h, warm } = fixture();
    h.net.respond = (url) =>
      url.includes('thumb.webp')
        ? bytesOf(3, { 'content-type': 'image/webp' })
        : new Response('{}', { headers: { 'content-type': 'application/json' } });
    warm.library(LIBRARY);
    await warm.idle();
    h.net.online = false;
    const index = await h.deps.caches.open('hsw-bank-index-v1');
    for (const path of [
      '/api/tools',
      '/api/tools/classes',
      '/api/tools/chisel',
      '/api/tools/chisel/holding',
    ]) {
      expect(await index.match(`${ORIGIN}${path}`)).toBeDefined();
    }
    const media = await h.deps.caches.open('hsw-media-v1');
    expect(
      await media.match(
        `${ORIGIN}/api/tools/tape-roll-10/thumb.webp?v=2026-10-22T08%3A00%3A00.000Z`,
      ),
    ).toBeDefined();
  });

  test('the same set is not downloaded twice, a changed one is', async () => {
    const { h, warm, calls } = fixture();
    h.net.respond = () => bytesOf(5);
    warm.wall(WALL);
    warm.wall(WALL);
    warm.wall({ ...WALL, photos: [...WALL.photos, { id: 'p-3' }] });
    await warm.idle();
    expect(calls).toHaveLength(2);
  });

  test('a run that stopped offline is tried again on the next change notification', async () => {
    const { warm, calls, setOutcome, h } = fixture();
    h.net.respond = () => bytesOf(5);
    setOutcome('offline');
    warm.wall(WALL);
    await warm.idle();
    setOutcome('complete');
    warm.wall(WALL);
    await warm.idle();
    expect(calls).toHaveLength(2);
  });

  test('nothing to do for no wall, an empty wall or no library', async () => {
    const { warm, calls } = fixture();
    warm.wall(null);
    warm.wall({ id: 'w2', photos: [], models: [] });
    warm.library(null);
    await warm.idle();
    expect(calls).toHaveLength(0);
  });

  test('a failing download is reported and does not break the queue', async () => {
    const h = harness();
    let first = true;
    const warm = createWarmup({
      origin: ORIGIN,
      deps: () => Promise.resolve(h.deps),
      download: (deps, urls, options) => {
        if (first) {
          first = false;
          return Promise.reject(new Error('boom'));
        }
        return downloadAssets(deps, urls, options);
      },
    });
    h.net.respond = () => bytesOf(5);
    const original = console.error;
    console.error = () => undefined;
    try {
      warm.wall(WALL);
      await warm.idle();
      warm.wall(WALL);
      await warm.idle();
    } finally {
      console.error = original;
    }
    const cache = await h.deps.caches.open('hsw-media-v1');
    expect(await cache.match(`${ORIGIN}/api/walls/w1/photos/p-1/file`)).toBeDefined();
  });
});
