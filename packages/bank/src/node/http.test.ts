import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
