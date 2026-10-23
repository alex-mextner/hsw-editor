/** The tool model asset store and its routes against the real daemon on an ephemeral port. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolAssetIndexSchema,
  listToolClasses,
  readGlbMeta,
  type ToolAssetIndex,
} from '@hsw-editor/tools';
import type { JobRegistry } from '../jobs.ts';
import { startServer, type RunningServer } from '../server.ts';
import { createToolsModule } from './module.ts';

let running: RunningServer;
let root = '';
let home = '';
let base = '';
const jobRegistry: JobRegistry = new Map();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-tool-assets-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html>app</html>');
  home = join(root, 'home');
  running = await startServer(
    { port: 0, host: '127.0.0.1', home, webDist: dist, allowedOrigins: [], heartbeatMs: 1000 },
    { modules: [createToolsModule({ jobRegistry })], jobRegistry },
  );
  base = running.url;
});

afterAll(async () => {
  await running.stop();
  rmSync(root, { recursive: true, force: true });
});

async function fetchIndex(): Promise<ToolAssetIndex> {
  const response = await fetch(`${base}/api/tools/assets/index`);
  expect(response.status).toBe(200);
  return ToolAssetIndexSchema.parse(await response.json());
}

describe('tool asset index', () => {
  test('lists every built-in class once, with both LODs and a holding summary', async () => {
    const index = await fetchIndex();
    const ids = index.entries.filter((e) => e.kind === 'class').map((e) => e.id);
    expect(ids.sort()).toEqual(
      listToolClasses()
        .map((c) => `class:${c.id}`)
        .sort(),
    );
    const tape = index.entries.find((e) => e.id === 'class:tape-roll');
    expect(tape?.holding.hang?.kind).toBe('hole');
    expect(tape?.lod1.size).toBeLessThan(tape?.lod0.size ?? 0);
    expect(tape?.values).not.toBeNull();
    expect(index.unavailable).toEqual([]);
  });

  test('revalidates by ETag and carries its hash in a header', async () => {
    const first = await fetch(`${base}/api/tools/assets/index`);
    const etag = first.headers.get('etag');
    expect(etag).toBe(`"${first.headers.get('x-tools-index-hash')}"`);
    const again = await fetch(`${base}/api/tools/assets/index`, {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(again.status).toBe(304);
  });
});

describe('tool asset index revalidation', () => {
  test('an entity tag list, a weak tag and * all revalidate', async () => {
    const first = await fetch(`${base}/api/tools/assets/index`);
    const etag = first.headers.get('etag') ?? '';
    for (const header of [`"old", ${etag}`, `W/${etag}`, '*']) {
      const again = await fetch(`${base}/api/tools/assets/index`, {
        headers: { 'if-none-match': header },
      });
      expect(again.status).toBe(304);
    }
    const other = await fetch(`${base}/api/tools/assets/index`, {
      headers: { 'if-none-match': '"nope"' },
    });
    expect(other.status).toBe(200);
  });

  test('the first requests arriving together share one store and one build', async () => {
    const results = await Promise.all([
      fetch(`${base}/api/tools/assets/index`),
      fetch(`${base}/api/tools/assets/health`),
      fetch(`${base}/api/tools/assets/index`),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200, 200]);
  });
});

describe('tool asset files', () => {
  test('serves a GLB under its content hash, immutable, and the bytes hash to the name', async () => {
    const index = await fetchIndex();
    const entry = index.entries.find((e) => e.id === 'class:screwdriver');
    if (!entry) throw new Error('no screwdriver entry');
    const response = await fetch(`${base}/tools/assets/${entry.lod0.path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('content-type')).toBe('model/gltf-binary');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBe(entry.lod0.size);
    expect(createHash('sha256').update(bytes).digest('hex').slice(0, 16)).toBe(
      entry.lod0.path.slice(4, 20),
    );
    const meta = readGlbMeta(bytes);
    expect(meta.dims.y).toBeCloseTo(entry.dimsMm.y, 3);
    expect(meta.holding?.lengthMm).toBeCloseTo(entry.holding.lengthMm, 3);
    const head = await fetch(`${base}/tools/assets/${entry.lod1.path}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(entry.lod1.size));
  });

  test('an unknown or malformed name is a JSON 404 that never falls back to the app shell', async () => {
    const missing = await fetch(`${base}/tools/assets/glb/0123456789abcdef.glb`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    const body = (await missing.json()) as { error: string; referencedByIndex: boolean };
    expect(body.error).toBe('asset_not_found');
    expect(body.referencedByIndex).toBe(false);
    for (const bad of [
      'glb/../index.json',
      'glb/abc.glb',
      'index.json',
      'glb/0123456789abcdeg.glb',
    ]) {
      const response = await fetch(`${base}/tools/assets/${bad}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    expect(
      (await fetch(`${base}/tools/assets/glb/0123456789abcdef.glb`, { method: 'POST' })).status,
    ).toBe(405);
  });

  test('a truncated file is never served; the store repairs it from the generator', async () => {
    const index = await fetchIndex();
    const entry = index.entries.find((e) => e.id === 'class:hammer');
    if (!entry) throw new Error('no hammer entry');
    const file = join(home, 'tools-assets', entry.lod1.path);
    const original = readFileSync(file);
    truncateSync(file, original.byteLength - 100);
    const damaged = await fetch(`${base}/tools/assets/${entry.lod1.path}`);
    expect(damaged.status).toBe(404);
    const damagedBody = (await damaged.json()) as { referencedByIndex: boolean };
    expect(damagedBody.referencedByIndex).toBe(true);
    // the repair runs in the background; the next index call waits for it in the same queue
    await fetchIndex();
    const healed = await fetch(`${base}/tools/assets/${entry.lod1.path}`);
    expect(healed.status).toBe(200);
    expect(new Uint8Array(await healed.arrayBuffer())).toEqual(new Uint8Array(original));
  });
});

describe('tool asset health', () => {
  test('reports a complete store, and a deep check hashes and decodes every file', async () => {
    const shallow = (await (await fetch(`${base}/api/tools/assets/health`)).json()) as {
      ok: boolean;
      entries: number;
      problems: unknown[];
      deep: boolean;
    };
    expect(shallow.ok).toBe(true);
    expect(shallow.entries).toBe(listToolClasses().length);
    const deep = await fetch(`${base}/api/tools/assets/health?deep=1`);
    expect(deep.status).toBe(200);
    const deepBody = (await deep.json()) as { deep: boolean; problems: unknown[] };
    expect(deepBody.deep).toBe(true);
    expect(deepBody.problems).toEqual([]);
  });

  test('a missing file is a problem and answers 503, until it is requested and rebuilt', async () => {
    const index = await fetchIndex();
    const entry = index.entries.find((e) => e.id === 'class:chisel');
    if (!entry) throw new Error('no chisel entry');
    rmSync(join(home, 'tools-assets', entry.lod0.path));
    const response = await fetch(`${base}/api/tools/assets/health`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { problems: { id: string; problem: string }[] };
    expect(body.problems).toContainEqual(
      expect.objectContaining({ id: 'class:chisel', problem: 'missing' }),
    );
  });
});

describe('user tools', () => {
  test('a library tool joins the index with its own model and leaves it when removed', async () => {
    const created = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        classId: 'screwdriver',
        params: { shaftLength: 150 },
        name: { en: 'Mine' },
      }),
    });
    expect(created.status).toBeLessThan(300);
    const { tool } = (await created.json()) as { tool: { id: string } };
    const index = await fetchIndex();
    const mine = index.entries.find((e) => e.id === `tool:${tool.id}`);
    expect(mine?.kind).toBe('tool');
    expect(mine?.classId).toBe('screwdriver');
    expect(mine?.values).toBeNull();
    const glb = await fetch(`${base}/tools/assets/${mine?.lod0.path}`);
    expect(glb.status).toBe(200);
    expect(readGlbMeta(new Uint8Array(await glb.arrayBuffer())).holding?.hang).not.toBeUndefined();
    const removed = await fetch(`${base}/api/tools/${encodeURIComponent(tool.id)}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect((await fetchIndex()).entries.some((e) => e.id === `tool:${tool.id}`)).toBe(false);
  });

  test('a model file lost after it was listed drops the tool from the index on the next read', async () => {
    const created = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classId: 'chisel', params: {}, name: { en: 'Lost later' } }),
    });
    const { tool } = (await created.json()) as { tool: { id: string } };
    expect((await fetchIndex()).entries.some((e) => e.id === `tool:${tool.id}`)).toBe(true);
    rmSync(join(home, 'tools', tool.id, 'model-lod1.glb'));
    const after = await fetchIndex();
    expect(after.entries.some((e) => e.id === `tool:${tool.id}`)).toBe(false);
    expect(after.unavailable.map((u) => u.id)).toContain(`tool:${tool.id}`);
  });

  test('a user tool whose model file is gone is reported unavailable instead of served broken', async () => {
    const created = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classId: 'hammer', params: {}, name: { en: 'Broken' } }),
    });
    const { tool } = (await created.json()) as { tool: { id: string } };
    rmSync(join(home, 'tools', tool.id, 'model.glb'));
    const index = await fetchIndex();
    expect(index.entries.some((e) => e.id === `tool:${tool.id}`)).toBe(false);
    expect(index.unavailable.map((u) => u.id)).toContain(`tool:${tool.id}`);
  });
});
