import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeElement, makeIndex } from '../testing.ts';
import { createBankHandler } from './http.ts';
import { bankPaths } from './paths.ts';

let root: string;
let handler: (request: Request) => Promise<Response | null>;
const hash = 'c'.repeat(64);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bank-http-'));
  await mkdir(join(root, 'glb'), { recursive: true });
  await Bun.write(join(root, 'glb/0000000000000000.glb'), 'glb-bytes');
  const index = {
    ...makeIndex([
      makeElement({
        id: 'screwdriver-clip',
        ru: 'Клипса для отвёртки',
        en: 'Screwdriver clip',
        category: 'holders/screwdrivers',
        tagsRu: ['отвертка'],
        toolClasses: ['screwdriver'],
      }),
    ]),
    contentHash: hash,
  };
  await Bun.write(join(root, 'index.json'), JSON.stringify(index));
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
    const ok = await get('/bank/assets/glb/0000000000000000.glb');
    expect(ok?.status).toBe(200);
    expect(ok?.headers.get('cache-control')).toContain('immutable');
    expect(await ok?.text()).toBe('glb-bytes');
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
  const sample = (id: string, contentHash: string) => ({
    ...makeIndex([
      makeElement({ id, ru: 'Крюк', en: 'Hook', category: 'hooks', toolClasses: ['screwdriver'] }),
    ]),
    contentHash,
  });
  const write = async (dir: string, body: string, seconds: number): Promise<void> => {
    await Bun.write(join(dir, 'index.json'), body);
    await utimes(join(dir, 'index.json'), seconds, seconds);
  };

  test('read routes are GET/HEAD only, the variant route is POST only, with Allow headers', async () => {
    const del = await handler(
      new Request('http://localhost/api/bank/elements/screwdriver-clip', { method: 'DELETE' }),
    );
    expect(del?.status).toBe(405);
    expect(del?.headers.get('allow')).toBe('GET, HEAD');
    const put = await handler(
      new Request('http://localhost/api/bank/search?q=a', { method: 'PUT' }),
    );
    expect(put?.status).toBe(405);
    const getVariant = await get('/api/bank/elements/screwdriver-clip/variant');
    expect(getVariant?.status).toBe(405);
    expect(getVariant?.headers.get('allow')).toBe('POST');
    expect(
      (await handler(new Request('http://localhost/api/bank/index', { method: 'HEAD' })))?.status,
    ).toBe(200);
  });

  test('the asset extension must match its kind', async () => {
    expect((await get('/bank/assets/thumb/0000000000000000.glb'))?.status).toBe(404);
    expect((await get('/bank/assets/variant/0000000000000000.webp'))?.status).toBe(404);
    expect((await get('/bank/assets/glb/0000000000000000.glb'))?.status).toBe(200);
  });

  test('a built bank that appears after the seed was loaded replaces it without a restart', async () => {
    const seed = await mkdtemp(join(tmpdir(), 'bank-seed-'));
    const built = await mkdtemp(join(tmpdir(), 'bank-built-'));
    try {
      await write(seed, JSON.stringify(sample('seed-hook', 'a'.repeat(64))), 1000);
      const h = createBankHandler({
        roots: [built, seed],
        paths: bankPaths({ HSW_BANK_DIR: built }),
      });
      const ids = async (): Promise<string[]> => {
        const res = await h(new Request('http://localhost/api/bank/index'));
        const body = (await res?.json()) as { elements: { id: string }[] };
        return body.elements.map((e) => e.id);
      };
      expect(await ids()).toEqual(['seed-hook']);
      await write(built, JSON.stringify(sample('built-hook', 'b'.repeat(64))), 2000);
      expect(await ids()).toEqual(['built-hook']);
    } finally {
      await rm(seed, { recursive: true, force: true });
      await rm(built, { recursive: true, force: true });
    }
  });

  test('a broken built index keeps serving the built bank, not the seed', async () => {
    const seed = await mkdtemp(join(tmpdir(), 'bank-seed-'));
    const built = await mkdtemp(join(tmpdir(), 'bank-built-'));
    try {
      await write(seed, JSON.stringify(sample('seed-hook', 'a'.repeat(64))), 1000);
      await write(built, JSON.stringify(sample('built-hook', 'b'.repeat(64))), 2000);
      const h = createBankHandler({
        roots: [built, seed],
        paths: bankPaths({ HSW_BANK_DIR: built }),
      });
      const get = async (id: string): Promise<number | undefined> =>
        (await h(new Request(`http://localhost/api/bank/elements/${id}`)))?.status;
      expect(await get('built-hook')).toBe(200);
      await write(built, '{"version": 1, "elem', 3000);
      expect(await get('built-hook')).toBe(200);
      expect(await get('seed-hook')).toBe(404);
    } finally {
      await rm(seed, { recursive: true, force: true });
      await rm(built, { recursive: true, force: true });
    }
  });

  test('an index that cannot be parsed keeps the bank in use, and the next valid write is picked up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bank-torn-'));
    try {
      await write(dir, JSON.stringify(sample('first', 'a'.repeat(64))), 1000);
      const h = createBankHandler({ roots: [dir], paths: bankPaths({ HSW_BANK_DIR: dir }) });
      const status = async (): Promise<[number | undefined, string]> => {
        const res = await h(new Request('http://localhost/api/bank/elements/first'));
        return [res?.status, res ? await res.text() : ''];
      };
      expect((await status())[0]).toBe(200);
      await write(dir, '{"version": 1, "elem', 2000);
      expect((await status())[0]).toBe(200);
      await write(dir, JSON.stringify(sample('second', 'b'.repeat(64))), 3000);
      expect((await h(new Request('http://localhost/api/bank/elements/second')))?.status).toBe(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
