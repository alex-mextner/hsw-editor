import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureBank } from './tmpbank.ts';
import { createBankHandler } from './http.ts';
import { bankPaths } from './paths.ts';

let root: string;
let handler: (request: Request) => Promise<Response | null>;
let hash: string;
let glb: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bank-http-'));
  const [clip] = await writeFixtureBank(root, ['screwdriver-clip'], {
    specs: {
      'screwdriver-clip': {
        ru: 'Клипса для отвёртки',
        en: 'Screwdriver clip',
        tagsRu: ['отвертка'],
        toolClasses: ['screwdriver'],
      },
    },
  });
  if (!clip) throw new Error('fixture bank has no element');
  glb = clip.glb;
  const index = (await Bun.file(join(root, 'index.json')).json()) as { contentHash: string };
  hash = index.contentHash;
  handler = createBankHandler({ roots: [root], paths: bankPaths({ HSW_BANK_DIR: root }) });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const get = (path: string, headers: Record<string, string> = {}): Promise<Response | null> =>
  handler(new Request(`http://localhost${path}`, { headers }));

describe('bank HTTP handler', () => {
  test('ignores URLs that are not bank routes', async () => {
    expect(await get('/api/walls')).toBeNull();
  });

  test('serves the index with an ETag and answers 304 to a matching If-None-Match', async () => {
    const first = await get('/api/bank/index');
    expect(first?.status).toBe(200);
    expect(first?.headers.get('etag')).toBe(`"${hash}"`);
    expect(first?.headers.get('cache-control')).toBe('no-cache');
    const second = await get('/api/bank/index', { 'if-none-match': `"${hash}"` });
    expect(second?.status).toBe(304);
  });

  test('assets are immutable; malformed or traversing paths are rejected', async () => {
    const ok = await get(`/bank/assets/${glb}`);
    expect(ok?.status).toBe(200);
    expect(ok?.headers.get('cache-control')).toContain('immutable');
    expect(ok?.headers.get('x-bank-index-hash')).toBe(hash);
    expect((await ok?.arrayBuffer())?.byteLength).toBe(Bun.file(join(root, glb)).size);
    expect((await get('/bank/assets/glb/ffffffffffffffff.glb'))?.status).toBe(404);
    expect((await get('/bank/assets/glb/../index.json'))?.status).toBe(404);
    // the URL parser resolves encoded dot segments to /bank/index.json, which is no bank route at all
    expect(await get('/bank/assets/%2e%2e/index.json')).toBeNull();
  });

  test('searches Russian queries and returns ranked ids', async () => {
    const response = await get(`/api/bank/search?q=${encodeURIComponent('отвёртки')}`);
    const body = (await response?.json()) as { results: { id: string }[] };
    expect(body.results.map((r) => r.id)).toEqual(['screwdriver-clip']);
  });

  test('element lookup and variant errors map to 404 / 409 / 400', async () => {
    expect((await get('/api/bank/elements/screwdriver-clip'))?.status).toBe(200);
    expect((await get('/api/bank/elements/nope'))?.status).toBe(404);
    const post = (path: string, body: unknown): Promise<Response | null> =>
      handler(
        new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) }),
      );
    // a source element has no generator
    expect(
      (await post('/api/bank/elements/screwdriver-clip/variant', { params: { a: 1 } }))?.status,
    ).toBe(409);
    expect(
      (await post('/api/bank/elements/screwdriver-clip/variant', { nope: true }))?.status,
    ).toBe(400);
    expect((await post('/api/bank/elements/missing/variant', { params: {} }))?.status).toBe(404);
  });
});

describe('bank HTTP handler robustness', () => {
  const get = (h: Handler, path: string, init?: RequestInit) =>
    h(new Request(`http://localhost${path}`, init));
  type Handler = (request: Request) => Promise<Response | null>;
  const bankDir = async (id: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'bank-robust-'));
    await writeFixtureBank(dir, [id]);
    return dir;
  };
  const ids = async (h: Handler): Promise<string[]> => {
    const res = await get(h, '/api/bank/index');
    if (!res) throw new Error('index route not handled');
    const body = (await res.json()) as { elements: { id: string }[] };
    return body.elements.map((e) => e.id);
  };
  const handlerFor = (roots: string[]): Handler =>
    createBankHandler({ roots, paths: bankPaths({ HSW_BANK_DIR: roots[0] }), revalidateMs: 0 });

  test('read routes are GET/HEAD only, the variant route is POST only, with Allow headers', async () => {
    const del = await get(handler, '/api/bank/elements/screwdriver-clip', { method: 'DELETE' });
    expect(del?.status).toBe(405);
    expect(del?.headers.get('allow')).toBe('GET, HEAD');
    expect((await get(handler, '/api/bank/search?q=a', { method: 'PUT' }))?.status).toBe(405);
    const getVariant = await get(handler, '/api/bank/elements/screwdriver-clip/variant');
    expect(getVariant?.status).toBe(405);
    expect(getVariant?.headers.get('allow')).toBe('POST');
    expect((await get(handler, '/api/bank/index', { method: 'HEAD' }))?.status).toBe(200);
  });

  test('the asset extension must match its kind', async () => {
    expect((await get(handler, '/bank/assets/thumb/0000000000000000.glb'))?.status).toBe(404);
    expect((await get(handler, '/bank/assets/variant/0000000000000000.webp'))?.status).toBe(404);
    expect((await get(handler, `/bank/assets/${glb}`))?.status).toBe(200);
  });

  test('a built bank that appears after the seed was loaded replaces it without a restart', async () => {
    const seed = await bankDir('seed-hook');
    const built = await mkdtemp(join(tmpdir(), 'bank-built-'));
    try {
      const h = handlerFor([built, seed]);
      expect(await ids(h)).toEqual(['seed-hook']);
      await writeFixtureBank(built, ['built-hook']);
      expect(await ids(h)).toEqual(['built-hook']);
    } finally {
      await rm(seed, { recursive: true, force: true });
      await rm(built, { recursive: true, force: true });
    }
  });

  test('a torn built index keeps serving the bank in use, not the seed, and the next valid write is picked up', async () => {
    const seed = await bankDir('seed-hook');
    const built = await bankDir('built-hook');
    try {
      const h = handlerFor([built, seed]);
      expect(await ids(h)).toEqual(['built-hook']);
      await Bun.write(join(built, 'index.json'), '{"version": 1, "elem');
      await utimes(join(built, 'index.json'), 3000, 3000);
      expect(await ids(h)).toEqual(['built-hook']);
      expect((await get(h, '/api/bank/elements/seed-hook'))?.status).toBe(404);
      await writeFixtureBank(built, ['second-hook']);
      expect(await ids(h)).toEqual(['second-hook']);
    } finally {
      await rm(seed, { recursive: true, force: true });
      await rm(built, { recursive: true, force: true });
    }
  });
});
