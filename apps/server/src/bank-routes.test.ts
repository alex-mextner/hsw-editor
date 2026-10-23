/** `/api/bank/*` and `/bank/assets/*` served by the real daemon (committed seed, temp data home). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BankElement, BankIndex } from '@hsw-editor/bank';
import { startServer, type RunningServer } from './server.ts';

let root: string;
let running: RunningServer;
let index: BankIndex;
let savedBankDir: string | undefined;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-bank-routes-'));
  // an ambient override would point the daemon away from the temp data home
  savedBankDir = process.env['HSW_BANK_DIR'];
  delete process.env['HSW_BANK_DIR'];
  running = await startServer({
    port: 0,
    host: '127.0.0.1',
    home: join(root, 'home'),
    webDist: join(root, 'dist'),
    allowedOrigins: [],
    heartbeatMs: 1000,
  });
  index = (await (await fetch(`${running.url}/api/bank/index`)).json()) as BankIndex;
});

afterAll(async () => {
  await running.stop();
  if (savedBankDir !== undefined) process.env['HSW_BANK_DIR'] = savedBankDir;
  rmSync(root, { recursive: true, force: true });
});

describe('bank routes on the daemon', () => {
  test('the index is the committed seed and revalidates by ETag', async () => {
    const first = await fetch(`${running.url}/api/bank/index`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBe(`"${index.contentHash}"`);
    expect(index.elements.length).toBeGreaterThan(50);
    const again = await fetch(`${running.url}/api/bank/index`, {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(again.status).toBe(304);
  });

  test('search ranks a Russian query and an element is fetchable by id', async () => {
    const search = await fetch(
      `${running.url}/api/bank/search?q=${encodeURIComponent('отвертка')}`,
    );
    const { results } = (await search.json()) as { results: { id: string; score: number }[] };
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    if (top === undefined) throw new Error('search returned no results');
    const element = await fetch(`${running.url}/api/bank/elements/${top.id}`);
    expect(element.status).toBe(200);
    expect(((await element.json()) as BankElement).id).toBe(top.id);
    expect((await fetch(`${running.url}/api/bank/elements/nope`)).status).toBe(404);
  });

  test("an element's GLB and thumbnail are served as immutable assets", async () => {
    const element = index.elements[0];
    if (element === undefined) throw new Error('seed has no elements');
    const glb = await fetch(`${running.url}/bank/assets/${element.assets.lod0.path}`);
    expect(glb.status).toBe(200);
    expect(glb.headers.get('cache-control')).toContain('immutable');
    expect(new TextDecoder().decode((await glb.arrayBuffer()).slice(0, 4))).toBe('glTF');
    const thumb = await fetch(`${running.url}/bank/assets/${element.assets.thumbnail.path}`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toContain('image/webp');
  });

  test('wrong methods and unknown asset paths are refused', async () => {
    const post = await fetch(`${running.url}/api/bank/index`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toContain('GET');
    expect((await fetch(`${running.url}/bank/assets/glb/0000000000000000.glb`)).status).toBe(404);
  });

  test('non-bank routes still reach the wall API', async () => {
    expect((await fetch(`${running.url}/api/health`)).status).toBe(200);
  });

  // last: it puts a built bank into the data home
  test('a built bank appearing under <home>/bank is served without a restart', async () => {
    const built: BankIndex = { ...index, contentHash: 'f'.repeat(64) };
    mkdirSync(join(root, 'home', 'bank'), { recursive: true });
    writeFileSync(join(root, 'home', 'bank', 'index.json'), JSON.stringify(built));
    const response = await fetch(`${running.url}/api/bank/index`);
    expect(response.headers.get('etag')).toBe(`"${built.contentHash}"`);
  });
});
