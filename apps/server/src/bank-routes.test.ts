/** `/api/bank/*` and `/bank/assets/*` served by the real daemon (committed seed, temp data home). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BankElement, BankIndex } from '@hsw-editor/bank';
import { adoptBank, bankPaths, composeIndex } from '@hsw-editor/bank/node';
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

  // last: it publishes a built bank into the data home
  test('a built bank published under <home>/bank is served without a restart', async () => {
    // a verified bank that differs from the seed: the seed minus its first element, published as a generation
    const paths = bankPaths({ ...process.env, HSW_EDITOR_HOME: join(root, 'home') });
    const source = join(root, 'source-bank');
    cpSync(paths.seedDir, source, { recursive: true });
    const trimmed = composeIndex({
      grid: index.grid,
      categories: index.categories,
      toolClasses: index.toolClasses,
      elements: index.elements.slice(1),
    });
    writeFileSync(join(source, 'index.json'), JSON.stringify(trimmed));
    await adoptBank(paths, source);
    await Bun.sleep(600); // the handler re-validates its roots at most every 500 ms
    const response = await fetch(`${running.url}/api/bank/index`);
    expect(response.headers.get('etag')).toBe(`"${trimmed.contentHash}"`);
    const health = (await (await fetch(`${running.url}/api/bank/health`)).json()) as {
      ok: boolean;
      elements: number;
    };
    expect(health.ok).toBe(true);
    expect(health.elements).toBe(index.elements.length - 1);
  });
});
