/**
 * `POST /api/tools/drafts/:id/objects/:key/draw-view` (the `tools.draw_view` job) against the real daemon on an ephemeral
 * port: fake draw backends, a fake vision sidecar and a scripted drawn-view checker. No network, no login, no GPU.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DrawBackend, DrawError, type DrawRequest, type DrawResult } from '@hsw-editor/draw';
import { generate, observeModel, presetValues } from '@hsw-editor/tools';
import type {
  PhotoObjectsRequest,
  SidecarObject,
  SidecarResult,
  VisionAvailability,
  VisionPort,
} from '@hsw-editor/tools/node';
import sharp from 'sharp';
import { createDrawModule } from '../draw/module.ts';
import { saveImage } from '../draw/image.ts';
import { createDrawRuntime } from '../draw/runtime.ts';
import { scratchDir, type Scratch, writeObjectPng } from '../draw/test-helpers.ts';
import type { JobRegistry } from '../jobs.ts';
import { startServer, type RunningServer } from '../server.ts';
import type { DrawnViewChecker } from './draw-view.ts';
import { createToolsModule } from './module.ts';

const PNG_1PX = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

/** The sidecar's `fit` of the object: only what the checker is handed (the real library validates the rest). */
const SIDECAR_FIT = { template: { name: 'lathe' }, params: { L_mm: 180 }, pose: {} };

class FakeVision implements VisionPort {
  withFit = true;
  /** The colour of the bar in the cut-out: another colour is another picture (the key `0:1` is reused on a re-analysis). */
  bar = { r: 200, g: 30, b: 30 };
  async photoToObjects(req: PhotoObjectsRequest): Promise<SidecarResult> {
    const obs = observeModel(
      generate('screwdriver', presetValues('screwdriver', 'phillips-ergonomic'), 0),
    );
    mkdirSync(join(req.outDir, 'cutouts_oriented'), { recursive: true });
    mkdirSync(join(req.outDir, 'crops_oriented'), { recursive: true });
    writeFileSync(join(req.outDir, 'crops_oriented/1.png'), PNG_1PX);
    // a transparent cut-out with a red bar: flattened on white it is a red bar on a white canvas
    await sharp({
      create: { width: 80, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 60, height: 12, channels: 3, background: this.bar },
          })
            .png()
            .toBuffer(),
          left: 10,
          top: 14,
        },
      ])
      .png()
      .toFile(join(req.outDir, 'cutouts_oriented/1.png'));
    const object: SidecarObject = {
      id: 1,
      cropOriented: 'crops_oriented/1.png',
      cutoutOriented: 'cutouts_oriented/1.png',
      profile: {
        kind: 'lathe_profile',
        length_mm: obs.lengthMm,
        stations: obs.stations.map((s) => ({ t: s.t, lo_mm: s.lo, hi_mm: s.hi })),
      },
      class: { toolClass: 'screwdriver', topk: [{ toolClass: 'screwdriver', score: 20 }] },
    };
    // the sidecar's own result file, as `photo_to_objects` leaves it
    writeFileSync(
      join(req.outDir, 'objects.json'),
      JSON.stringify({ objects: [{ id: 1, fit: this.withFit ? SIDECAR_FIT : null }] }),
    );
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

/** A backend that answers from a script of image bytes or errors and records every request. */
class ScriptedBackend implements DrawBackend {
  readonly requests: DrawRequest[] = [];
  readonly script: Array<Uint8Array | Error> = []; // an Error that is not a DrawError is a backend that crashes
  readonly refBytes: Uint8Array[] = [];
  constructor(readonly id: 'omp' | 'chatgpt-browser') {}
  async draw(req: DrawRequest): Promise<DrawResult> {
    this.requests.push(req);
    const ref = req.refs[0];
    if (ref) this.refBytes.push(new Uint8Array(await Bun.file(ref.path).arrayBuffer()));
    const next = this.script.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    const image = await saveImage(req.outDir, `fake-${this.requests.length}`, next);
    return { ok: true, backend: this.id, images: [image], meta: { elapsedMs: 1 } };
  }
}

interface Job {
  id: string;
  state: string;
  error?: string;
  result?: Record<string, unknown>;
}

let scratch: Scratch;
let running: RunningServer;
let base = '';
let root = '';
const vision = new FakeVision();
const omp = new ScriptedBackend('omp');
const chatgpt = new ScriptedBackend('chatgpt-browser');
const checks: Array<{ fit: unknown; drawn: unknown }> = [];
const checker: DrawnViewChecker = async (fit, drawn) => {
  checks.push({ fit, drawn });
  return drawn.map(() => ({
    state: 'checked',
    source: 'generated',
    iou: 0.93,
    flag: false,
    usable: true,
    azimuthDeg: 90,
    elevationDeg: 0,
  }));
};
/** A stand-in for `omp`: `models ls --kind image` prints a model (ready) or "No models available" (login wall). */
function fakeOmp(dir: string, name: string, output: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${output}"\n`);
  chmodSync(path, 0o755);
  return path;
}

let readyBin = '';
let loggedOutBin = '';

async function goodPng(): Promise<Uint8Array> {
  const path = join(scratch.dir, 'good.png');
  await writeObjectPng(path);
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

async function grayPng(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#999999' } })
      .png()
      .toBuffer(),
  );
}

async function startDaemon(ompBin: string): Promise<void> {
  const jobRegistry: JobRegistry = new Map(); // one registry per daemon: a job kind registers once
  // own data directory per daemon: the guard state (a quota block, a login wall) must not leak between tests
  const dataDir = mkdtempSync(join(scratch.dir, 'data-'));
  const runtime = createDrawRuntime({
    env: { HSW_EDITOR_DATA_DIR: dataDir, HSW_OMP_BIN: ompBin },
    backends: { omp, 'chatgpt-browser': chatgpt },
  });
  root = mkdtempSync(join(tmpdir(), 'hsw-draw-view-'));
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html>app</html>');
  running = await startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home: join(root, 'home'),
      webDist: dist,
      allowedOrigins: [],
      heartbeatMs: 1000,
    },
    {
      modules: [
        createDrawModule({ runtime }),
        createToolsModule({
          vision,
          jobRegistry,
          drawRuntime: runtime,
          drawnViewChecker: checker,
        }),
      ],
      jobRegistry,
    },
  );
  base = running.url;
}

beforeAll(async () => {
  scratch = await scratchDir();
  readyBin = fakeOmp(scratch.dir, 'omp-ready', 'openai-codex/gpt-image-1');
  loggedOutBin = fakeOmp(scratch.dir, 'omp-logged-out', 'No models available');
});

afterAll(async () => {
  await scratch.cleanup();
});

beforeEach(() => {
  omp.script.length = 0;
  omp.requests.length = 0;
  omp.refBytes.length = 0;
  chatgpt.script.length = 0;
  chatgpt.requests.length = 0;
  checks.length = 0;
  vision.withFit = true;
  vision.bar = { r: 200, g: 30, b: 30 };
});

async function stopDaemon(): Promise<void> {
  await running.stop();
  rmSync(root, { recursive: true, force: true });
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitJob(id: string): Promise<Job> {
  for (let i = 0; i < 200; i++) {
    const { job } = (await (await fetch(`${base}/api/jobs/${id}`)).json()) as { job: Job };
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${id} did not finish`);
}

/** A draft with one analysed object; returns the route prefix of that object. */
async function draftWithObject(): Promise<{ draftId: string; key: string; prefix: string }> {
  const form = new FormData();
  form.append('photo', new Blob([PNG_1PX], { type: 'image/png' }), 'driver.png');
  form.append('mode', 'multi');
  const created = await fetch(`${base}/api/tools/drafts`, { method: 'POST', body: form });
  const draftId = ((await created.json()) as { draft: { id: string } }).draft.id;
  const analyze = await post('/api/jobs', { kind: 'tools.analyze', input: { draftId } });
  const finished = await waitJob(((await analyze.json()) as { job: { id: string } }).job.id);
  expect(finished.state).toBe('succeeded');
  const draft = (await (await fetch(`${base}/api/tools/drafts/${draftId}`)).json()) as {
    draft: { objects: { key: string }[] };
  };
  const key = draft.draft.objects[0]?.key ?? '';
  return {
    draftId,
    key,
    prefix: `/api/tools/drafts/${draftId}/objects/${encodeURIComponent(key)}`,
  };
}

async function drawView(
  prefix: string,
  body?: unknown,
): Promise<{ response: Response; job?: Job }> {
  const response = await post(`${prefix}/draw-view`, body);
  if (response.status !== 202) return { response };
  const { job } = (await response.json()) as { job: { id: string } };
  return { response, job: await waitJob(job.id) };
}

describe('draw a missing view of a draft object', () => {
  test('an accepted drawing is kept as a generated hint with its quality report and its check against the fit', async () => {
    await startDaemon(readyBin);
    try {
      const { prefix } = await draftWithObject();
      omp.script.push(await goodPng());
      const { response, job } = await drawView(prefix, { views: ['side'], backend: 'omp' });
      expect(response.status).toBe(202);
      expect(job?.state).toBe('succeeded');
      const result = job?.result as { status: string; views: Record<string, unknown>[] };
      expect(result.status).toBe('done');
      const [view] = result.views;
      expect(view).toMatchObject({
        source: 'generated',
        view: 'side',
        backend: 'omp',
        accepted: true,
        promptTemplateVersion: 1,
        // `drawn/<key>/<id of the picture it was drawn from>/side.png`
        file: expect.stringMatching(/^drawn\/0_1\/[0-9a-f]{12}\/side\.png$/),
        quality: { ok: true },
        check: { state: 'checked', source: 'generated', iou: 0.93, flag: false },
      });
      // the backend got the cut-out flattened on white, the SIDE prompt and the real size
      const request = omp.requests[0];
      expect(request?.prompt).toContain('SIDE');
      expect(request?.prompt).toContain('mm wide');
      expect(request?.prompt).toContain('reference image is its FRONT view'); // the convention the sidecar's view names assume
      expect(request?.refs[0]?.role).toBe('subject');
      const reference = await sharp(Buffer.from(omp.refBytes[0] ?? new Uint8Array()))
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(reference.info.channels).toBe(3);
      expect([...reference.data.subarray(0, 3)]).toEqual([255, 255, 255]); // a transparent corner became white
      // the sidecar's fit of THAT object went to the checker, with the drawing's path and view
      expect(checks[0]?.fit).toEqual(SIDECAR_FIT);
      expect(checks[0]?.drawn).toMatchObject([{ view: 'side' }]);
      // listed and served
      const listed = (await (await fetch(`${base}${prefix}/drawn`)).json()) as {
        views: { view: string; source: string }[];
      };
      expect(listed.views).toMatchObject([{ view: 'side', source: 'generated' }]);
      const file = await fetch(`${base}${prefix}/drawn/side.png`);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('image/png');
      expect((await fetch(`${base}${prefix}/drawn/other.png`)).status).toBe(404);
    } finally {
      await stopDaemon();
    }
  });

  test('a drawing the quality gate rejects is reported with its reasons, never served or checked', async () => {
    await startDaemon(readyBin);
    try {
      const { prefix } = await draftWithObject();
      omp.script.push(await grayPng());
      const { job } = await drawView(prefix, { views: ['top'], backend: 'omp' });
      const result = job?.result as { status: string; views: Record<string, unknown>[] };
      expect(result.status).toBe('done');
      expect(result.views[0]).toMatchObject({
        view: 'top',
        accepted: false,
        file: null,
        check: null,
      });
      expect(checks).toEqual([]);
      expect((await fetch(`${base}${prefix}/drawn/top.png`)).status).toBe(404);
    } finally {
      await stopDaemon();
    }
  });

  test('without a fit from the sidecar the drawing is kept and its check says why there is none', async () => {
    await startDaemon(readyBin);
    try {
      vision.withFit = false;
      const { prefix } = await draftWithObject();
      omp.script.push(await goodPng(), await goodPng());
      const { job } = await drawView(prefix, { backend: 'omp' }); // default views: the end and the profile
      const result = job?.result as {
        views: { view: string; accepted: boolean; check: { state: string; reason: string } }[];
      };
      expect(result.views.map((v) => v.view)).toEqual(['side', 'top']);
      expect(result.views[0]?.accepted).toBe(true);
      expect(result.views[0]?.check).toMatchObject({ state: 'unavailable' });
      expect(result.views[0]?.check.reason).toContain('no fit');
      expect(checks).toEqual([]);
    } finally {
      await stopDaemon();
    }
  });

  test('a pinned backend that is not logged in is refused with the literal steps and no job is queued', async () => {
    await startDaemon(loggedOutBin);
    try {
      const { prefix } = await draftWithObject();
      const before = (await (await fetch(`${base}/api/jobs`)).json()) as { jobs: unknown[] };
      const response = await post(`${prefix}/draw-view`, { backend: 'omp' });
      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        error: { code: string; message: string; details: { backend: string; steps: string[] } };
      };
      expect(body.error.code).toBe('login_required');
      expect(body.error.details.backend).toBe('omp');
      expect(body.error.details.steps.join('\n')).toContain('omp login openai-codex');
      const after = (await (await fetch(`${base}/api/jobs`)).json()) as { jobs: unknown[] };
      expect(after.jobs.length).toBe(before.jobs.length);
      expect(omp.requests).toEqual([]);
    } finally {
      await stopDaemon();
    }
  });

  test('a quota stop is a failed outcome with the code and the wait, and keeps what was drawn before', async () => {
    await startDaemon(readyBin);
    try {
      const { prefix } = await draftWithObject();
      omp.script.push(
        await goodPng(),
        new DrawError('quota_exhausted', 'image limit reached', {
          retryable: true,
          retryAfterMs: 3_600_000,
        }),
      );
      const { job } = await drawView(prefix, { views: ['side', 'top'], backend: 'omp' });
      expect(job?.state).toBe('succeeded');
      const result = job?.result as {
        status: string;
        view: string;
        error: { code: string; retryAfterMs: number };
        views: { view: string; accepted: boolean }[];
      };
      expect(result).toMatchObject({
        status: 'failed',
        view: 'top',
        error: { code: 'quota_exhausted', retryAfterMs: 3_600_000 },
      });
      expect(result.views).toMatchObject([{ view: 'side', accepted: true }]);
      expect((await fetch(`${base}${prefix}/drawn/side.png`)).status).toBe(200); // kept and served after the stop
    } finally {
      await stopDaemon();
    }
  });

  test('a view that throws after another was kept does not hide the kept one', async () => {
    await startDaemon(readyBin);
    try {
      const { prefix } = await draftWithObject();
      // `side` is drawn and kept; the backend then crashes with something that is not a draw failure value
      omp.script.push(await goodPng(), new Error('backend crashed'));
      const { job } = await drawView(prefix, { views: ['side', 'top'], backend: 'omp' });
      expect(job?.state).toBe('failed');
      const listed = (await (await fetch(`${base}${prefix}/drawn`)).json()) as {
        views: { view: string; source: string }[];
      };
      expect(listed.views).toMatchObject([{ view: 'side', source: 'generated' }]);
      const file = await fetch(`${base}${prefix}/drawn/side.png`);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('image/png');
      expect((await fetch(`${base}${prefix}/drawn/other.png`)).status).toBe(404);
    } finally {
      await stopDaemon();
    }
  });

  test('a re-analysis that gives the key another picture starts without the old drawings', async () => {
    await startDaemon(readyBin);
    try {
      const { draftId, prefix } = await draftWithObject();
      omp.script.push(await goodPng());
      await drawView(prefix, { views: ['side'], backend: 'omp' });
      expect(((await (await fetch(`${base}${prefix}/drawn`)).json()) as { views: unknown[] }).views.length).toBe(1);
      // recalibrate and analyse again: the sidecar numbers its objects from 1 again, and this time the tool is another one
      vision.bar = { r: 20, g: 120, b: 220 };
      await post(`/api/tools/drafts/${draftId}/calibration`, { mmPerPx: 1 });
      const again = await post('/api/jobs', { kind: 'tools.analyze', input: { draftId } });
      expect((await waitJob(((await again.json()) as { job: { id: string } }).job.id)).state).toBe('succeeded');
      expect(((await (await fetch(`${base}${prefix}/drawn`)).json()) as { views: unknown[] }).views).toEqual([]);
      expect((await fetch(`${base}${prefix}/drawn/side.png`)).status).toBe(404);
      // the new picture draws and keeps its own
      omp.script.push(await goodPng());
      await drawView(prefix, { views: ['side'], backend: 'omp' });
      expect((await fetch(`${base}${prefix}/drawn/side.png`)).status).toBe(200);
    } finally {
      await stopDaemon();
    }
  });

  test('auto with nothing logged in ends in manual_pending, names what would automate it, and collects the upload', async () => {
    await startDaemon(loggedOutBin);
    try {
      const { prefix } = await draftWithObject();
      omp.script.push(new DrawError('login_required', 'omp has no image-capable credentials'));
      chatgpt.script.push(new DrawError('login_required', 'not logged in'));
      const first = await drawView(prefix, { views: ['side'] });
      const pending = first.job?.result as {
        status: string;
        view: string;
        manual: { jobId: string; prompt: string; refCount: number };
        automation: { id: string; state: string; steps: string[] }[];
      };
      expect(pending.status).toBe('manual_pending');
      expect(pending.view).toBe('side');
      expect(pending.manual.prompt).toContain('SIDE');
      expect(pending.manual.refCount).toBe(1);
      const ompStatus = pending.automation.find((s) => s.id === 'omp');
      expect(ompStatus?.state).toBe('login_required');
      expect(ompStatus?.steps.join('\n')).toContain('omp login openai-codex');
      expect(pending.automation.some((s) => s.id === 'manual')).toBe(false);

      // the user generates the picture elsewhere and uploads it; the same request collects it
      const upload = await fetch(`${base}/api/draw/manual/${pending.manual.jobId}/inbox`, {
        method: 'POST',
        body: await goodPng(),
      });
      expect(upload.status).toBe(201);
      omp.script.push(new DrawError('login_required', 'omp has no image-capable credentials'));
      chatgpt.script.push(new DrawError('login_required', 'not logged in'));
      const second = await drawView(prefix, { views: ['side'] });
      const done = second.job?.result as {
        status: string;
        views: { backend: string; accepted: boolean; source: string }[];
      };
      expect(done.status).toBe('done');
      expect(done.views[0]).toMatchObject({
        backend: 'manual',
        accepted: true,
        source: 'generated',
      });
    } finally {
      await stopDaemon();
    }
  });

  test('bad requests are 4xx in the documented shape, not failed jobs', async () => {
    await startDaemon(readyBin);
    try {
      const { prefix, draftId } = await draftWithObject();
      const badView = await post(`${prefix}/draw-view`, { views: ['bottom'] });
      expect(badView.status).toBe(400);
      expect(((await badView.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_body',
      );
      const notJson = await fetch(`${base}${prefix}/draw-view`, { method: 'POST', body: '{nope' });
      expect(notJson.status).toBe(400);
      expect(((await notJson.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_json',
      );
      const unknown = await post(`/api/tools/drafts/${draftId}/objects/9%3A9/draw-view`, {});
      expect(unknown.status).toBe(404);
      expect((await fetch(`${base}${prefix}/draw-view`)).status).toBe(405);
      const nothingDrawn = (await (await fetch(`${base}${prefix}/drawn`)).json()) as {
        views: unknown[];
      };
      expect(nothingDrawn.views).toEqual([]);
    } finally {
      await stopDaemon();
    }
  });
});
