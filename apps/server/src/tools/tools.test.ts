/** `/api/tools/*` against the real daemon on an ephemeral port with a fake vision sidecar. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, observeModel, presetValues } from '@hsw-editor/tools';
import type {
  PhotoObjectsRequest,
  SidecarObject,
  SidecarResult,
  VisionAvailability,
  VisionPort,
} from '@hsw-editor/tools/node';
import type { JobRegistry } from '../jobs.ts';
import { HttpVisionClient } from '../vision/client.ts';
import { startServer, type RunningServer } from '../server.ts';
import { createToolsModule } from './module.ts';

const PNG_1PX = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

class FakeVision implements VisionPort {
  async photoToObjects(req: PhotoObjectsRequest): Promise<SidecarResult> {
    const obs = observeModel(
      generate('screwdriver', presetValues('screwdriver', 'phillips-ergonomic'), 0),
    );
    mkdirSync(join(req.outDir, 'crops_oriented'), { recursive: true });
    writeFileSync(join(req.outDir, 'crops_oriented/1.png'), PNG_1PX);
    const object: SidecarObject = {
      id: 1,
      cropOriented: 'crops_oriented/1.png',
      profile: {
        kind: 'lathe_profile',
        length_mm: obs.lengthMm,
        stations: obs.stations.map((s) => ({ t: s.t, lo_mm: s.lo, hi_mm: s.hi })),
      },
      class: { toolClass: 'screwdriver', topk: [{ toolClass: 'screwdriver', score: 20 }] },
      colours: { parts: [{ t0: 0, t1: 0.5, hex: '#2455a8', area_frac: 0.5 }] },
    };
    return { status: 'ok', calibration: { method: 'manual', mm_per_px: 1 }, objects: [object] };
  }
  async mergeObjects(): Promise<SidecarObject> {
    throw new Error('not used');
  }
  async splitObject(): Promise<SidecarObject[]> {
    throw new Error('not used');
  }
  async addObject(): Promise<SidecarObject> {
    throw new Error('not used');
  }
  async status(): Promise<VisionAvailability> {
    return { available: true };
  }
}

let running: RunningServer;
let root = '';
let base = '';
const jobRegistry: JobRegistry = new Map();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-tools-api-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html>app</html>');
  const home = join(root, 'home');
  running = await startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home,
      webDist: dist,
      allowedOrigins: [],
      heartbeatMs: 1000,
    },
    { modules: [createToolsModule({ vision: new FakeVision(), jobRegistry })], jobRegistry },
  );
  base = running.url;
});

afterAll(async () => {
  await running.stop();
  rmSync(root, { recursive: true, force: true });
});

const getJson = async (path: string): Promise<Record<string, unknown>> =>
  (await (await fetch(base + path)).json()) as Record<string, unknown>;

describe('job without a prior request', () => {
  test('tools.analyze runs against the daemon home before any HTTP request reached the module', async () => {
    const job = running.jobs.submit('tools.analyze', { draftId: 'no-such-draft' });
    const ended = Promise.withResolvers<void>();
    running.jobs.subscribe(job.id, 0, { onEvent: () => undefined, onEnd: () => ended.resolve() });
    await ended.promise;
    const state = running.jobs.get(job.id);
    expect(state.state).toBe('failed');
    expect(state.error ?? '').not.toContain('has not served a request');
    expect(state.error ?? '').toContain('no-such-draft');
  });
});

describe('built-in classes', () => {
  test('lists classes and serves a GLB with the holding interface', async () => {
    const list = (await getJson('/api/tools/classes')) as { classes: { id: string }[] };
    expect(list.classes.map((c) => c.id)).toContain('screwdriver');
    const glb = new Uint8Array(
      await (
        await fetch(`${base}/api/tools/classes/screwdriver/model.glb?preset=hex-octagonal&lod=1`)
      ).arrayBuffer(),
    );
    expect(new DataView(glb.buffer).getUint32(0, true)).toBe(0x46546c67);
    const holding = (await getJson('/api/tools/classes/screwdriver/holding')) as {
      holding: { lengthMm: number };
    };
    expect(holding.holding.lengthMm).toBeGreaterThan(150);
    expect((await fetch(`${base}/api/tools/classes/nope`)).status).toBe(404);
  });
});

describe('library and import', () => {
  test('manual add, import job, review, commit, patch, download, remove', async () => {
    // manual: class + params straight into the library
    const manual = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        classId: 'screwdriver',
        params: { shaftLength: 120 },
        name: { en: 'Long driver' },
        tags: [' Driver ', 'driver', 'Long'],
      }),
    });
    expect(manual.status).toBe(201);
    const manualTool = ((await manual.json()) as { tool: { id: string; tags: string[] } }).tool;
    const manualId = manualTool.id;
    expect(manualTool.tags).toEqual(['driver', 'long']);
    const listed = (
      (await getJson('/api/tools')) as {
        tools: {
          id: string;
          dimsMm: { x: number; y: number; z: number };
          holdingDims: Record<string, number>;
        }[];
      }
    ).tools;
    expect(listed.length).toBe(1);
    expect(listed[0]).toMatchObject({
      id: manualId,
      tags: ['driver', 'long'],
      classId: 'screwdriver',
      bankClass: 'screwdriver',
      thumb: `/api/tools/${manualId}/thumb.webp`,
      fit: { method: 'manual' },
    });
    expect(listed[0]?.dimsMm.y).toBeGreaterThan(150);
    expect(Object.keys(listed[0]?.holdingDims ?? {}).length).toBeGreaterThan(0);
    const ownHolding = (await getJson(`/api/tools/${manualId}/holding`)) as {
      holding: { lengthMm: number };
      bankClass: string | null;
    };
    expect(ownHolding.holding.lengthMm).toBeGreaterThan(150);
    expect(ownHolding.bankClass).toBe('screwdriver');
    expect((await fetch(`${base}/api/tools/${manualId}/thumb.webp`)).status).toBe(200);

    // import: upload -> job -> draft -> commit
    const form = new FormData();
    form.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'driver.png');
    form.append('mode', 'multi');
    const created = await fetch(`${base}/api/tools/drafts`, { method: 'POST', body: form });
    expect(created.status).toBe(201);
    const draftId = ((await created.json()) as { draft: { id: string } }).draft.id;

    const jobRes = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'tools.analyze', input: { draftId } }),
    });
    expect(jobRes.status).toBe(202);
    const jobId = ((await jobRes.json()) as { job: { id: string } }).job.id;
    let state = 'queued';
    for (let i = 0; i < 100 && !['succeeded', 'failed'].includes(state); i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = ((await getJson(`/api/jobs/${jobId}`)) as { job: { state: string } }).job.state;
    }
    expect(state).toBe('succeeded');

    const draft = (
      (await getJson(`/api/tools/drafts/${draftId}`)) as {
        draft: {
          state: string;
          objects: { key: string; classId: string | null; preview: { thumb: string } | null }[];
        };
      }
    ).draft;
    expect(draft.state).toBe('ready');
    const obj = draft.objects[0];
    expect(obj?.classId).toBe('screwdriver');
    const thumb = await fetch(`${base}/api/tools/drafts/${draftId}/files/${obj?.preview?.thumb}`);
    expect(thumb.status).toBe(200);
    expect(
      (await fetch(`${base}/api/tools/drafts/${draftId}/files/photos/../draft.json`)).status,
    ).toBe(404);

    const patched = await fetch(
      `${base}/api/tools/drafts/${draftId}/objects/${encodeURIComponent(obj?.key ?? '')}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'accepted',
          name: { en: 'Blue driver' },
          tags: ['Phillips'],
          dimensionsMm: { length: 210 },
        }),
      },
    );
    expect(patched.status).toBe(200);
    const commit = await fetch(`${base}/api/tools/drafts/${draftId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['Workshop', 'phillips'] }),
    });
    expect(commit.status).toBe(201);
    const committed = (await commit.json()) as { tools: { id: string }[] };
    expect(committed.tools.length).toBe(1);
    const id = committed.tools[0]?.id ?? '';

    const tool = (
      (await getJson(`/api/tools/${id}`)) as {
        tool: {
          name: { en: string };
          tags: string[];
          dimensionsMm: { length: number; source: string };
        };
      }
    ).tool;
    expect(tool.name.en).toBe('Blue driver');
    expect(tool.tags).toEqual(['phillips', 'workshop']);
    expect(tool.dimensionsMm.source).toBe('user');
    const glb = await fetch(`${base}/api/tools/${id}/model.glb`);
    expect(glb.headers.get('content-type')).toBe('model/gltf-binary');

    const rename = await fetch(`${base}/api/tools/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: { ru: 'Синяя отвёртка' },
        partColors: { handle: '#c8262b' },
        tags: ['Blue', 'workshop'],
      }),
    });
    expect(rename.status).toBe(200);
    const renamed = ((await rename.json()) as { tool: { name: { ru: string }; tags: string[] } })
      .tool;
    expect(renamed.name.ru).toBe('Синяя отвёртка');
    expect(renamed.tags).toEqual(['blue', 'workshop']);
    expect(((await getJson(`/api/tools/${id}`)) as { tool: { tags: string[] } }).tool.tags).toEqual(
      ['blue', 'workshop'],
    );

    expect((await fetch(`${base}/api/tools/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fetch(`${base}/api/tools/${id}`)).status).toBe(404);
    expect((await fetch(`${base}/api/tools/${manualId}`)).status).toBe(200);
  });

  test('rejects bad input with the documented error shape', async () => {
    const notMultipart = await fetch(`${base}/api/tools/drafts`, { method: 'POST', body: '{}' });
    expect(notMultipart.status).toBe(415);
    const bad = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classId: 1 }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid_body');
    const text = new FormData();
    text.append('photo', new Blob(['%PDF not an image'], { type: 'application/pdf' }), 'x.pdf');
    expect((await fetch(`${base}/api/tools/drafts`, { method: 'POST', body: text })).status).toBe(
      415,
    );
    expect((await fetch(`${base}/api/tools/..%2Fetc`)).status).toBe(400);
  });
});

describe('review-found regressions', () => {
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const patch = (path: string, body: unknown): Promise<Response> =>
    fetch(base + path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const errorCode = async (res: Response): Promise<string> =>
    ((await res.json()) as { error: { code: string } }).error.code;

  test('an unexpected failure while adding a tool is a JSON 500 and leaves the library untouched', async () => {
    const form = new FormData();
    form.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'gone.png');
    form.append('mode', 'multi');
    const created = await fetch(`${base}/api/tools/drafts`, { method: 'POST', body: form });
    const draftId = ((await created.json()) as { draft: { id: string } }).draft.id;
    const job = running.jobs.submit('tools.analyze', { draftId });
    const ended = Promise.withResolvers<void>();
    running.jobs.subscribe(job.id, 0, { onEvent: () => undefined, onEnd: () => ended.resolve() });
    await ended.promise;
    const draft = (await getJson(`/api/tools/drafts/${draftId}`)) as {
      draft: { objects: { key: string }[] };
    };
    const key = draft.draft.objects[0]?.key ?? '';
    await patch(`/api/tools/drafts/${draftId}/objects/${encodeURIComponent(key)}`, {
      status: 'accepted',
    });
    const before = ((await getJson('/api/tools')) as { tools: unknown[] }).tools.length;
    // the photo vanishes from disk: copying it into the tool fails with a plain ENOENT
    rmSync(join(root, 'home', 'tools', '.drafts', draftId, 'photos'), { recursive: true });
    const res = await post(`/api/tools/drafts/${draftId}/commit`, {});
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await errorCode(res)).toBe('internal');
    expect(((await getJson('/api/tools')) as { tools: unknown[] }).tools.length).toBe(before);
  });

  test('concurrent PATCHes both land; DELETE racing PATCHes never resurrects the tool', async () => {
    const created = await post('/api/tools', { classId: 'screwdriver', name: { en: 'Race' } });
    const id = ((await created.json()) as { tool: { id: string } }).tool.id;
    const [a, b] = await Promise.all([
      patch(`/api/tools/${id}`, { name: { ru: 'Гонка' } }),
      patch(`/api/tools/${id}`, { partColors: { handle: '#c8262b' } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const tool = ((await getJson(`/api/tools/${id}`)) as { tool: { name: { ru?: string } } }).tool;
    expect(tool.name.ru).toBe('Гонка');

    const racing = await Promise.all([
      patch(`/api/tools/${id}`, { name: { en: 'Late 1' } }),
      fetch(`${base}/api/tools/${id}`, { method: 'DELETE' }),
      patch(`/api/tools/${id}`, { name: { en: 'Late 2' } }),
    ]);
    expect(racing[1].status).toBe(200);
    expect(racing[0].status === 200 || racing[0].status === 404).toBe(true);
    expect((await fetch(`${base}/api/tools/${id}`)).status).toBe(404);
    expect(existsSync(join(root, 'home', 'tools', id))).toBe(false);
  });

  test('a rejected upload leaves no draft directory behind', async () => {
    const draftsDir = join(root, 'home', 'tools', '.drafts');
    const before = readdirSync(draftsDir).length;
    const form = new FormData();
    form.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'ok.png');
    form.append('photo', new Blob(['%PDF-1.4 not an image'], { type: 'application/pdf' }), 'x.pdf');
    expect((await fetch(`${base}/api/tools/drafts`, { method: 'POST', body: form })).status).toBe(
      415,
    );
    expect(readdirSync(draftsDir).length).toBe(before);
  });

  test('malformed input is a 400, a malformed percent-escape too', async () => {
    const badJson = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"classId":',
    });
    expect(badJson.status).toBe(400);
    expect(await errorCode(badJson)).toBe('invalid_json');
    const escape = await fetch(`${base}/api/tools/%E0%A4`);
    expect(escape.status).toBe(400);
    expect(await errorCode(escape)).toBe('invalid_id');
  });

  test('a multipart body without a boundary is a 400 in the documented shape', async () => {
    const res = await fetch(`${base}/api/tools/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' },
      body: 'not multipart at all',
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('invalid_body');
  });
  test('a half-specified calibration is refused', async () => {
    for (const calibration of [
      {},
      {
        pointsPx: [
          [0, 0],
          [10, 0],
        ],
      },
      { distanceMm: 50 },
    ]) {
      const form = new FormData();
      form.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'c.png');
      form.append('calibration', JSON.stringify(calibration));
      const res = await fetch(`${base}/api/tools/drafts`, { method: 'POST', body: form });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('invalid_body');
    }
  });

  test('a corrupt tool.json is a 500 corrupt error, not a client error', async () => {
    const created = await post('/api/tools', { classId: 'screwdriver', name: { en: 'Broken' } });
    const id = ((await created.json()) as { tool: { id: string } }).tool.id;
    writeFileSync(join(root, 'home', 'tools', id, 'tool.json'), '{ "truncated"');
    const res = await fetch(`${base}/api/tools/${id}`);
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('corrupt');
    // a broken tool must not become undeletable
    expect((await fetch(`${base}/api/tools/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(root, 'home', 'tools', id))).toBe(false);
  });
});

describe('tags validation', () => {
  const post = (body: unknown): Promise<Response> =>
    fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('refuses over-long tags and more than 20 tags', async () => {
    expect((await post({ classId: 'screwdriver', tags: ['x'.repeat(41)] })).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect((await post({ classId: 'screwdriver', tags: many })).status).toBe(400);
  });
});

describe('class thumbnails', () => {
  const thumb = (query = ''): Promise<Response> =>
    fetch(`${base}/api/tools/classes/screwdriver/thumb.webp${query}`);

  test('serves, revalidates with a strong ETag and 304s', async () => {
    const first = await thumb();
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/webp');
    expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(100);
    const again = await fetch(`${base}/api/tools/classes/screwdriver/thumb.webp`, {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    const weak = await fetch(`${base}/api/tools/classes/screwdriver/thumb.webp`, {
      headers: { 'if-none-match': `W/${etag}` },
    });
    expect(weak.status).toBe(304);
    expect(readdirSync(join(root, 'home', 'cache', 'tool-thumbs'))).toContain(
      `${etag.slice(1, -1)}.webp`,
    );
  });

  test('a preset change is a different thumbnail; concurrent requests agree', async () => {
    const [a, b] = await Promise.all([
      thumb('?preset=hex-octagonal'),
      thumb('?preset=hex-octagonal'),
    ]);
    expect(a.headers.get('etag')).toBe(b.headers.get('etag'));
    expect(a.headers.get('etag')).not.toBe((await thumb()).headers.get('etag'));
    const custom = await thumb(`?p=${encodeURIComponent('{"shaftLength":60}')}`);
    expect(custom.status).toBe(200);
    // free-form parameters are rendered but never written to the disk cache
    expect(readdirSync(join(root, 'home', 'cache', 'tool-thumbs'))).not.toContain(
      `${(custom.headers.get('etag') ?? '').slice(1, -1)}.webp`,
    );
  });

  test('unknown class is 404, unknown preset / bad p is 400', async () => {
    expect((await fetch(`${base}/api/tools/classes/nope/thumb.webp`)).status).toBe(404);
    expect((await thumb('?preset=nope')).status).toBe(400);
    expect((await thumb('?p=%7B')).status).toBe(400);
  });

  test('class entries carry thumb, dimsMm and holdingDims; holding names the bank class', async () => {
    const list = (await getJson('/api/tools/classes')) as {
      classes: { id: string; thumb: string; dimsMm: { y: number }; holdingDims: object }[];
    };
    const sd = list.classes.find((c) => c.id === 'screwdriver');
    expect(sd?.thumb).toBe('/api/tools/classes/screwdriver/thumb.webp');
    expect(sd?.dimsMm.y).toBeGreaterThan(150);
    expect(sd?.holdingDims).toBeDefined();
    const holding = (await getJson('/api/tools/classes/screwdriver/holding')) as {
      bankClass: string;
    };
    expect(holding.bankClass).toBe('screwdriver');
  });
});

describe('vision status (the managed client, no fake sidecar)', () => {
  let probeRoot = '';
  const servers: RunningServer[] = [];
  beforeAll(() => {
    probeRoot = mkdtempSync(join(tmpdir(), 'hsw-vision-status-'));
  });
  afterAll(async () => {
    for (const server of servers) await server.stop();
    rmSync(probeRoot, { recursive: true, force: true });
  });

  /** A daemon whose tools module talks to its own client: own environment, own (absent) state file. */
  async function daemonWith(env: Record<string, string>, venv: string): Promise<string> {
    const client = new HttpVisionClient({
      repoRoot: probeRoot,
      env,
      venv,
      stateFile: join(probeRoot, `state-${servers.length}.json`),
    });
    const server = await startServer(
      {
        port: 0,
        host: '127.0.0.1',
        home: join(probeRoot, `home-${servers.length}`),
        webDist: join(root, 'dist'),
        allowedOrigins: [],
        heartbeatMs: 1000,
      },
      {
        modules: [createToolsModule({ visionClient: client, jobRegistry: new Map() })],
        jobRegistry: new Map(),
      },
    );
    servers.push(server);
    return server.url;
  }
  const statusOf = async (url: string): Promise<Record<string, unknown>> =>
    (await (await fetch(`${url}/api/tools/vision`)).json()) as Record<string, unknown>;

  test('an external sidecar that is down is unavailable with a message, one that answers is available', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const closedPort = probe.port;
    await probe.stop(true);
    const down = (await statusOf(
      await daemonWith(
        { HSW_VISION_URL: `http://127.0.0.1:${closedPort}` },
        join(probeRoot, 'no-venv'),
      ),
    )) as { available: boolean; url?: string; message: string };
    expect(down.available).toBe(false);
    expect(down.url).toBe(`http://127.0.0.1:${closedPort}`);
    expect(down.message).toContain(`127.0.0.1:${closedPort}`);

    const up = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === '/health'
          ? Response.json({ ok: true })
          : new Response('no', { status: 404 }),
    });
    try {
      const url = `http://127.0.0.1:${up.port}`;
      expect(
        await statusOf(await daemonWith({ HSW_VISION_URL: url }, join(probeRoot, 'no-venv'))),
      ).toEqual({ available: true, url });
    } finally {
      await up.stop(true);
    }
  });

  test('a stopped sidecar is available when it can be started and unavailable when it is not installed', async () => {
    const venv = join(probeRoot, 'venv');
    mkdirSync(join(venv, 'bin'), { recursive: true });
    writeFileSync(join(venv, 'bin', 'python'), '');
    expect(await statusOf(await daemonWith({}, venv))).toEqual({ available: true });
    const missing = (await statusOf(await daemonWith({}, join(probeRoot, 'absent')))) as {
      available: boolean;
      message: string;
    };
    expect(missing.available).toBe(false);
    expect(missing.message).toContain('hsw-editor vision setup');
  });
});

describe('library reads are storable by the service worker', () => {
  test('the list, classes, one tool and its holding answer no-cache; writes, errors and parameter-keyed reads stay no-store', async () => {
    const created = await fetch(`${base}/api/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classId: 'screwdriver', name: { en: 'Cache probe' } }),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const id = ((await created.json()) as { tool: { id: string } }).tool.id;
    try {
      for (const path of [
        '/api/tools',
        '/api/tools/classes',
        '/api/tools/classes/screwdriver',
        `/api/tools/${id}`,
        `/api/tools/${id}/holding`,
      ]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(200);
        expect(`${path} ${response.headers.get('cache-control')}`).toBe(`${path} no-cache`);
      }
      const classHolding = await fetch(`${base}/api/tools/classes/screwdriver/holding`);
      expect(classHolding.headers.get('cache-control')).toBe('no-store');
      const missing = await fetch(`${base}/api/tools/nope-1`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('cache-control')).toBe('no-store');
      expect((await fetch(`${base}/api/tools/classes/nope`)).headers.get('cache-control')).toBe(
        'no-store',
      );
    } finally {
      await fetch(`${base}/api/tools/${id}`, { method: 'DELETE' });
    }
  });
});
