/** Integration tests: the real daemon on an ephemeral port against a temp data dir. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApiErrorBody,
  InputRequest,
  ApplyResponse,
  HistoryEntry,
  JsonValue,
  ModelUploadResponse,
  PhotoUploadResponse,
  RevConflictBody,
  WallExport,
  WallResponse,
  WallSummary,
} from '@hsw-editor/core';
import { HistoryEntrySchema } from '@hsw-editor/core';
import sharp from 'sharp';
import { z } from 'zod';
import type { HealthPayload } from './handler.ts';
import { type JobRegistry, registerJob } from './jobs.ts';
import { startServer, type RunningServer } from './server.ts';

const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

const JobStateFrameSchema = z.looseObject({ state: z.string() });
const RequestInputFrameSchema = z.looseObject({
  request: z.looseObject({
    id: z.string(),
    createdBy: z.looseObject({ kind: z.string(), name: z.string().optional() }),
  }),
});
const ErrorFrameSchema = z.looseObject({ error: z.looseObject({ code: z.string() }) });

let running: RunningServer;
let root: string;
let base: string;
const jobRegistry: JobRegistry = new Map();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-api-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html>app</html>');
  writeFileSync(join(dist, 'sw.js'), 'self.skipWaiting()');
  writeFileSync(join(dist, 'assets/app-abc123.js'), 'console.log(1)');

  registerJob(
    {
      kind: 'test.count',
      inputSchema: z.object({ wallId: z.string(), steps: z.number().int().min(1) }),
      async run(input, ctx) {
        for (let done = 1; done <= input.steps; done++) {
          if (ctx.signal.aborted) return { stopped: done };
          ctx.progress({ done, total: input.steps, message: `step ${done}` });
          await Promise.resolve();
        }
        await ctx.walls.apply(input.wallId, {
          ops: [{ type: 'rename', name: 'renamed by job' }],
          actor: { kind: 'agent', name: 'job' },
        });
        return { counted: input.steps };
      },
    },
    jobRegistry,
  );
  registerJob(
    {
      kind: 'test.slow',
      inputSchema: z.object({}),
      async run(_input, ctx) {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
        return { aborted: true };
      },
    },
    jobRegistry,
  );
  registerJob(
    {
      kind: 'test.ask',
      inputSchema: z.object({ wallId: z.string() }),
      async run(input, ctx) {
        const answered = await ctx.walls.askUser(
          input.wallId,
          { kind: 'dimension', payload: { fields: [{ key: 'length', unit: 'mm' }] } },
          { kind: 'agent', name: 'ask-job' },
          ctx.signal,
        );
        return { got: answered.answer ?? null };
      },
    },
    jobRegistry,
  );
  registerJob(
    {
      kind: 'test.fail',
      inputSchema: z.object({}),
      run: () => Promise.reject(new Error('boom')),
    },
    jobRegistry,
  );

  running = await startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home: join(root, 'home'),
      webDist: dist,
      allowedOrigins: ['http://127.0.0.1:5194'],
      heartbeatMs: 40,
    },
    { modules: [], jobRegistry },
  );
  base = running.url;
});

afterAll(async () => {
  await running.stop();
  rmSync(root, { recursive: true, force: true });
});

/** `Response.json()` is untyped; tests name the expected shape at the call site (`json<ApplyResponse>()`) and assert on it. */
interface TypedResponse extends Omit<Response, 'json'> {
  json<T>(): Promise<T>;
}

async function http(url: string, init?: RequestInit): Promise<TypedResponse> {
  const response = await fetch(url, init);
  // one deliberate cast: same object, narrower json() signature
  return response as TypedResponse;
}

function post(
  path: string,
  body: JsonValue,
  headers: Record<string, string> = {},
): Promise<TypedResponse> {
  return http(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function createWall(id: string, name = 'Garage'): Promise<WallResponse> {
  const response = await post('/api/walls', { id, name });
  expect(response.status).toBe(201);
  return response.json();
}

const addHolder = (id: string, col: number, row: number): JsonValue => ({
  type: 'addItem',
  item: { id, kind: 'holder', bankId: 'hook', cell: { col, row } },
});

interface Frame {
  id: string | undefined;
  event: string;
  data: JsonValue;
}

/** The slice of ReadableStreamDefaultReader the client uses. */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<void>;
}

/** Incremental SSE reader: frames are awaited one by one, so tests wait on events, not on time. */
class SseClient {
  private readonly reader: ChunkReader;
  private readonly decoder = new TextDecoder();
  private buffer = '';

  constructor(response: Response) {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    this.reader = reader;
  }

  /** Next data frame; `undefined` when the server closed the stream. Fails after a safety timeout. */
  async next(timeoutMs = 4000): Promise<Frame | undefined> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const frame = parseFrame(raw);
        if (frame !== undefined) return frame;
        continue;
      }
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('timed out waiting for an SSE frame')), timeoutMs);
        }),
      ]);
      if (chunk.done) return undefined;
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** `count` frames, optionally only of one event type (heartbeats may interleave). */
  async take(count: number, only?: string): Promise<Frame[]> {
    const frames: Frame[] = [];
    while (frames.length < count) {
      const frame = await this.next();
      if (frame === undefined) break;
      if (only === undefined || frame.event === only) frames.push(frame);
    }
    return frames;
  }

  /** Reads until the stream ends. */
  async drain(): Promise<Frame[]> {
    const frames: Frame[] = [];
    for (let frame = await this.next(); frame !== undefined; frame = await this.next())
      frames.push(frame);
    return frames;
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}

function parseFrame(raw: string): Frame | undefined {
  const lines = raw.split('\n');
  const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
  if (event === undefined) return undefined; // retry/comment frames
  const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  return {
    id: lines.find((line) => line.startsWith('id: '))?.slice(4),
    event,
    data: JSON.parse(data.join('\n')),
  };
}

async function openSse(path: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const response = await http(`${base}${path}`, { headers });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return new SseClient(response);
}

describe('security guard', () => {
  test('foreign Host headers (DNS rebinding) are refused', async () => {
    const response = await running.server.fetch(new Request('http://evil.example:8794/api/walls'));
    expect(response.status).toBe(403);
    const body = ErrorFrameSchema.parse(await response.json());
    expect(body.error.code).toBe('forbidden_host');
    const lan = await running.server.fetch(new Request('http://192.168.1.5:8794/'));
    expect(lan.status).toBe(403);
  });

  test('cross-origin requests are refused, the dev origin and no-Origin pass, no CORS headers are sent', async () => {
    const evil = await http(`${base}/api/walls`, { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect((await evil.json<ApiErrorBody>()).error.code).toBe('forbidden_origin');
    const evilPost = await post('/api/walls', { name: 'x' }, { origin: 'http://localhost:9999' });
    expect(evilPost.status).toBe(403);
    expect(
      (await http(`${base}/api/walls`, { headers: { origin: 'http://127.0.0.1:5194' } })).status,
    ).toBe(200);
    const same = await http(`${base}/api/health`, { headers: { origin: base } });
    expect(same.status).toBe(200);
    expect(same.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await http(`${base}/api/walls`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5194', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('health reports the data dir', async () => {
    const body: HealthPayload = await (await http(`${base}/api/health`)).json();
    expect(body).toMatchObject({ ok: true, name: 'hsw-editor', home: join(root, 'home') });
  });
});

describe('walls and ops over HTTP', () => {
  test('create, list, ops with actors, undo/redo, conflict, errors, export, delete', async () => {
    const created = await createWall('crud', 'Workshop');
    expect(created.wall).toMatchObject({ id: 'crud', rev: 0, name: 'Workshop' });
    expect((await post('/api/walls', { id: 'crud', name: 'again' })).status).toBe(409);

    const listed: { walls: WallSummary[] } = await (await http(`${base}/api/walls`)).json();
    expect(listed.walls.find((wall) => wall.id === 'crud')).toMatchObject({ rev: 0, items: 0 });

    const applied: ApplyResponse = await (
      await post('/api/walls/crud/ops', {
        ops: [addHolder('a', 2, 2), addHolder('b', 2, 2)],
        baseRev: 0,
        actor: { kind: 'agent', name: 'omp' },
        label: 'two holders',
      })
    ).json();
    expect(applied).toMatchObject({ rev: 1, changed: true, canUndo: true, canRedo: false });
    expect(applied.warnings.map((warning) => warning.code)).toEqual(['cell_collision']);
    expect(applied.op).toMatchObject({ type: 'batch', label: 'two holders' });

    // conflict: stale baseRev -> 409 with the current wall, nothing applied
    const stale = await post('/api/walls/crud/ops', {
      ops: [{ type: 'rename', name: 'Mine' }],
      baseRev: 0,
    });
    expect(stale.status).toBe(409);
    const conflict: RevConflictBody = await stale.json();
    expect(conflict).toMatchObject({ error: { code: 'rev_conflict' }, currentRev: 1 });
    expect(conflict.wall.items).toHaveLength(2);

    // no baseRev: last writer wins; same value again is a no-op
    const renamed: ApplyResponse = await (
      await post('/api/walls/crud/ops', { ops: [{ type: 'rename', name: 'Mine' }] })
    ).json();
    expect(renamed.rev).toBe(2);
    const again: ApplyResponse = await (
      await post('/api/walls/crud/ops', { ops: [{ type: 'rename', name: 'Mine' }] })
    ).json();
    expect(again).toMatchObject({ rev: 2, changed: false });

    const undone: ApplyResponse = await (
      await post('/api/walls/crud/undo', { actor: { kind: 'human' } })
    ).json();
    expect(undone.wall.name).toBe('Workshop');
    expect(undone).toMatchObject({ rev: 3, canRedo: true });
    const redone: ApplyResponse = await (await post('/api/walls/crud/redo', {})).json();
    expect(redone.wall.name).toBe('Mine');
    expect((await post('/api/walls/crud/redo', {})).status).toBe(409);

    // validation and reducer errors have stable shapes
    const typo = await post('/api/walls/crud/ops', {
      ops: [{ type: 'rotateItem', id: 'a', rotation: 90 }],
    });
    expect(typo.status).toBe(400);
    const typoBody: ApiErrorBody = await typo.json();
    expect(typoBody.error.code).toBe('invalid_body');
    expect(JSON.stringify(typoBody.error.details)).toContain('ops');
    const missing = await post('/api/walls/crud/ops', {
      ops: [{ type: 'removeItem', id: 'ghost' }],
    });
    expect(missing.status).toBe(422);
    expect((await missing.json<ApiErrorBody>()).error).toMatchObject({
      code: 'op_failed',
      details: { code: 'item_not_found' },
    });
    expect((await http(`${base}/api/walls/nope`)).status).toBe(404);
    expect((await http(`${base}/api/walls/..%2Fetc`)).status).toBe(400);
    const badJson = await http(`${base}/api/walls/crud/ops`, { method: 'POST', body: '{nope' });
    expect((await badJson.json<ApiErrorBody>()).error.code).toBe('invalid_json');
    expect((await http(`${base}/api/nothing`)).status).toBe(404);

    const history: { entries: HistoryEntry[] } = await (
      await http(`${base}/api/walls/crud/history?since=0`)
    ).json();
    expect(
      history.entries.map((entry) => `${entry.kind}:${entry.rev}:${entry.actor.kind}`),
    ).toEqual(['op:1:agent', 'op:2:human', 'undo:3:human', 'redo:4:human']);
    const exported: WallExport = await (await http(`${base}/api/walls/crud/export`)).json();
    expect(exported).toMatchObject({ format: 'hsw-editor-wall', wall: { rev: 4 } });
    expect(exported.history).toHaveLength(5);

    const deleted = await http(`${base}/api/walls/crud`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await http(`${base}/api/walls/crud`)).status).toBe(404);
  });
});

describe('two clients and the event stream', () => {
  test('SSE delivers every op with actor and rev and resumes after a disconnect without gaps or repeats', async () => {
    await createWall('live');
    const stream = await openSse('/api/walls/live/events');
    expect((await stream.take(1)).map((frame) => frame.event)).toEqual(['snapshot']);

    // client A (human, UI) and client B (agent) write concurrently over HTTP
    const [a, b] = await Promise.all([
      post('/api/walls/live/ops', {
        ops: [addHolder('a', 1, 1)],
        actor: { kind: 'human', name: 'ui' },
      }),
      post('/api/walls/live/ops', {
        ops: [addHolder('b', 2, 1)],
        actor: { kind: 'agent', name: 'omp' },
      }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await post('/api/walls/live/undo', { actor: { kind: 'human', name: 'ui' } });

    const frames = await stream.take(3, 'op');
    await stream.close();
    expect(frames.map((frame) => `${frame.event}:${frame.id}`)).toEqual(['op:1', 'op:2', 'op:3']);
    const entries = frames.map((frame) => HistoryEntrySchema.parse(frame.data));
    const actors = entries.map((entry) =>
      entry.kind === 'create' ? '' : `${entry.kind}:${entry.actor.name}`,
    );
    expect(actors.sort()).toEqual(['op:omp', 'op:ui', 'undo:ui']);

    // reconnect after rev 1 (EventSource sends Last-Event-ID): 2..3 are replayed once, then live ops follow
    const resumed = await openSse('/api/walls/live/events', { 'last-event-id': '1' });
    await post('/api/walls/live/ops', { ops: [addHolder('c', 3, 1)] });
    const second = await resumed.take(3, 'op');
    await resumed.close();
    expect(second.map((frame) => `${frame.event}:${frame.id}`)).toEqual(['op:2', 'op:3', 'op:4']);
  });

  test('heartbeats carry the rev; a cursor ahead of the server falls back to a snapshot', async () => {
    await createWall('beats');
    await post('/api/walls/beats/ops', { ops: [addHolder('a', 1, 1)] });
    // real timers on purpose: the heartbeat interval (40 ms in this test) is the behaviour under test
    const beats = await openSse('/api/walls/beats/events?since=1');
    const two = await beats.take(2);
    await beats.close();
    expect(two.map((frame) => frame.event)).toEqual(['heartbeat', 'heartbeat']);
    expect(two[0]?.data).toEqual({ rev: 1 });

    const ahead = await openSse('/api/walls/beats/events?since=999');
    expect((await ahead.take(1))[0]?.event).toBe('snapshot');
    await ahead.close();
    expect((await http(`${base}/api/walls/none/events`)).status).toBe(404);
  });

  test('deleting a wall closes its stream with a deleted event', async () => {
    await createWall('doomed');
    const stream = await openSse('/api/walls/doomed/events');
    await stream.take(1); // snapshot: the listener is registered
    await http(`${base}/api/walls/doomed`, { method: 'DELETE' });
    expect((await stream.drain()).map((frame) => frame.event)).toEqual(['deleted']);
  });
});

describe('assets', () => {
  test('photo upload stores the file, adds a photo op and serves it back immutably', async () => {
    await createWall('pics');
    const form = new FormData();
    form.set('file', new File([ONE_PIXEL_PNG], 'wall.png', { type: 'image/png' }));
    form.set('actor', JSON.stringify({ kind: 'cli', name: 'test' }));
    const response = await http(`${base}/api/walls/pics/photos`, { method: 'POST', body: form });
    expect(response.status).toBe(201);
    const uploaded: PhotoUploadResponse = await response.json();
    expect(uploaded.photo).toMatchObject({
      mime: 'image/png',
      width: 1,
      height: 1,
      name: 'wall.png',
      origin: 'upload',
    });
    expect(uploaded.photo.file).toMatch(/^photos\/p-.*\.png$/);
    expect(uploaded.wall.photos).toHaveLength(1);
    expect(uploaded.rev).toBe(1);

    const file = await http(`${base}/api/walls/pics/photos/${uploaded.photo.id}/file`);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(ONE_PIXEL_PNG);

    const text = new FormData();
    text.set('file', new File(['not an image'], 'x.png'));
    expect(
      (await http(`${base}/api/walls/pics/photos`, { method: 'POST', body: text })).status,
    ).toBe(415);
    expect((await post('/api/walls/pics/photos', {})).status).toBe(415);
    const wall: WallResponse = await (await http(`${base}/api/walls/pics`)).json();
    expect(wall.wall.photos).toHaveLength(1); // rejected uploads leave no trace
  });

  test('a phone JPEG tagged with EXIF orientation 6 is stored upright', async () => {
    await createWall('rot');
    const raw = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#c33' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const form = new FormData();
    form.set('file', new File([raw], 'IMG_0001.jpeg', { type: 'image/jpeg' }));
    const response = await http(`${base}/api/walls/rot/photos`, { method: 'POST', body: form });
    expect(response.status).toBe(201);
    const uploaded: PhotoUploadResponse = await response.json();
    expect(uploaded.photo).toMatchObject({ mime: 'image/jpeg', width: 20, height: 40 });
    const file = await http(`${base}/api/walls/rot/photos/${uploaded.photo.id}/file`);
    const stored = sharp(new Uint8Array(await file.arrayBuffer()));
    expect((await stored.metadata()).orientation).toBeUndefined();
  });

  test('model upload adds a candidate model ref', async () => {
    await createWall('models');
    const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]);
    const form = new FormData();
    form.set('file', new File([glb], 'hammer.glb'));
    form.set('label', 'Hammer A');
    const response = await http(`${base}/api/walls/models/models`, { method: 'POST', body: form });
    expect(response.status).toBe(201);
    const uploaded: ModelUploadResponse = await response.json();
    expect(uploaded.model).toMatchObject({
      label: 'Hammer A',
      status: 'candidate',
      source: { type: 'upload' },
    });
    const served = await http(`${base}/api/walls/models/models/${uploaded.model.id}/file`);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(glb);
    const junk = new FormData();
    junk.set('file', new File(['{}'], 'x.gltf'));
    expect(
      (await http(`${base}/api/walls/models/models`, { method: 'POST', body: junk })).status,
    ).toBe(415);
  });
});

describe('jobs', () => {
  test('a job reports progress over SSE, applies ops through the store and finishes', async () => {
    await createWall('jobwall');
    const submitted = await post('/api/jobs', {
      kind: 'test.count',
      wallId: 'jobwall',
      input: { wallId: 'jobwall', steps: 3 },
    });
    expect(submitted.status).toBe(202);
    const { job }: { job: { id: string } } = await submitted.json();
    const frames = await (await openSse(`/api/jobs/${job.id}/events`)).drain(); // ends with the terminal state
    const states = frames
      .filter((frame) => frame.event === 'state')
      .map((frame) => JobStateFrameSchema.parse(frame.data).state);
    expect(states).toEqual(['queued', 'running', 'succeeded']);
    expect(frames.filter((frame) => frame.event === 'progress')).toHaveLength(3);
    const finished: { job: { state: string; result: JsonValue } } = await (
      await http(`${base}/api/jobs/${job.id}`)
    ).json();
    expect(finished.job).toMatchObject({ state: 'succeeded', result: { counted: 3 } });
    const wall: WallResponse = await (await http(`${base}/api/walls/jobwall`)).json();
    expect(wall.wall.name).toBe('renamed by job');
    const history: { entries: HistoryEntry[] } = await (
      await http(`${base}/api/walls/jobwall/history?since=0`)
    ).json();
    expect(history.entries[0]).toMatchObject({ actor: { kind: 'agent', name: 'job' } });

    // late subscribers replay the whole log and the stream ends
    const late = await (await openSse(`/api/jobs/${job.id}/events`)).drain();
    expect(late.length).toBe(frames.length);
  });

  test('cancel aborts the handler; failures are reported; bad input and unknown kinds are rejected', async () => {
    const slow: { job: { id: string } } = await (
      await post('/api/jobs', { kind: 'test.slow', input: {} })
    ).json();
    const slowEvents = await openSse(`/api/jobs/${slow.job.id}/events`);
    await slowEvents.take(2); // queued, running
    const cancelled: { job: { state: string } } = await (
      await post(`/api/jobs/${slow.job.id}/cancel`, {})
    ).json();
    expect(cancelled.job.state).toBe('cancelled');
    expect(
      (await slowEvents.drain()).map((frame) => JobStateFrameSchema.parse(frame.data).state),
    ).toEqual(['cancelled']);

    const failing: { job: { id: string } } = await (
      await post('/api/jobs', { kind: 'test.fail', input: {} })
    ).json();
    await (await openSse(`/api/jobs/${failing.job.id}/events`)).drain();
    const failed: { job: { state: string; error: string } } = await (
      await http(`${base}/api/jobs/${failing.job.id}`)
    ).json();
    expect(failed.job).toMatchObject({ state: 'failed', error: 'boom' });

    const invalid = await post('/api/jobs', { kind: 'test.count', input: { steps: 0 } });
    expect(invalid.status).toBe(400);
    expect((await invalid.json<ApiErrorBody>()).error.code).toBe('invalid_body');
    expect((await post('/api/jobs', { kind: 'nope', input: {} })).status).toBe(404);
    expect((await http(`${base}/api/jobs/zzz`)).status).toBe(404);
    const list: { jobs: { kind: string }[] } = await (
      await http(`${base}/api/jobs?kind=test.fail`)
    ).json();
    expect(list.jobs.every((entry) => entry.kind === 'test.fail')).toBe(true);
  });
});

describe('static app', () => {
  test('hashed assets are immutable, the shell and service worker revalidate, ETags give 304', async () => {
    const asset = await http(`${base}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await asset.text()).toBe('console.log(1)');

    const shell = await http(`${base}/walls/123`);
    expect(await shell.text()).toBe('<html>app</html>');
    expect(shell.headers.get('cache-control')).toBe('no-cache');

    const sw = await http(`${base}/sw.js`);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const etag = sw.headers.get('etag');
    expect(etag).not.toBeNull();
    const revalidated = await http(`${base}/sw.js`, { headers: { 'if-none-match': etag ?? '' } });
    expect(revalidated.status).toBe(304);

    expect((await http(`${base}/assets/missing.js`)).status).toBe(404);
    const head = await http(`${base}/sw.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const path of ['/%', '/%E0%A4', '/assets/', '/..%2F..%2Fetc%2Fpasswd']) {
      const response = await http(`${base}${path}`);
      expect(await response.text()).toBe('<html>app</html>');
    }
    expect((await http(`${base}/`, { method: 'POST', body: 'x' })).status).toBe(405);
  });
});

describe('input requests', () => {
  const dimension = {
    kind: 'dimension',
    title: 'Hammer length',
    payload: { fields: [{ key: 'length', label: 'Length', fitted: 285, min: 100, max: 500 }] },
  };

  test('an agent asks, every client sees it, the human answers, the waiting agent gets the answer', async () => {
    await createWall('asks');
    await post('/api/walls/asks/ops', { ops: [addHolder('h1', 3, 3)] });
    const stream = await openSse('/api/walls/asks/events');
    await stream.take(1, 'snapshot');

    const created = await post('/api/walls/asks/requests', {
      request: { ...dimension, itemId: 'h1' },
      actor: { kind: 'agent', name: 'vision' },
    });
    expect(created.status).toBe(201);
    const { request }: { request: InputRequest } = await created.json();
    expect(request).toMatchObject({
      kind: 'dimension',
      status: 'open',
      createdBy: { name: 'vision' },
    });
    expect(request.payload).toMatchObject({ fields: [{ key: 'length', unit: 'mm' }] });
    const [pushed] = await stream.take(1, 'request_input');
    expect(pushed?.id).toBeUndefined(); // not tied to a wall rev
    expect(RequestInputFrameSchema.parse(pushed?.data).request.id).toBe(request.id);

    // the agent long-polls while the UI answers
    const waiting = http(`${base}/api/walls/asks/requests/${request.id}?wait=5000`);
    const answered = await post(`/api/walls/asks/requests/${request.id}/answer`, {
      answer: { length: 290 },
      actor: { kind: 'human', name: 'ui' },
    });
    expect(answered.status).toBe(200);
    const result: { request: InputRequest } = await (await waiting).json();
    expect(result.request).toMatchObject({
      status: 'answered',
      answer: { length: 290 },
      resolvedBy: { name: 'ui' },
    });
    const [resolved] = await stream.take(1, 'request_resolved');
    expect(resolved?.data).toEqual({ id: request.id, status: 'answered', answer: { length: 290 } });
    await stream.close();

    const again = await post(`/api/walls/asks/requests/${request.id}/answer`, { answer: 1 });
    expect(again.status).toBe(409);
    expect((await again.json<ApiErrorBody>()).error.code).toBe('request_closed');

    const open: { requests: InputRequest[] } = await (
      await http(`${base}/api/walls/asks/requests?status=open`)
    ).json();
    expect(open.requests).toEqual([]);
    const all: { requests: InputRequest[] } = await (
      await http(`${base}/api/walls/asks/requests`)
    ).json();
    expect(all.requests.map((entry) => entry.status)).toEqual(['answered']);
  });

  test('open requests are re-sent when a client (re)connects; cancel resolves them', async () => {
    await createWall('reconnect');
    const created: { request: InputRequest } = await (
      await post('/api/walls/reconnect/requests', { request: dimension })
    ).json();
    const late = await openSse('/api/walls/reconnect/events');
    const frames = await late.take(2);
    expect(frames.map((frame) => frame.event)).toEqual(['snapshot', 'request_input']);
    const cancelled = await post(`/api/walls/reconnect/requests/${created.request.id}/cancel`, {});
    expect((await cancelled.json<{ request: InputRequest }>()).request.status).toBe('cancelled');
    expect((await late.take(1, 'request_resolved'))[0]?.data).toEqual({
      id: created.request.id,
      status: 'cancelled',
    });
    await late.close();
  });

  test('requests must point at things that exist and match their kind', async () => {
    await createWall('strict');
    const ghost = await post('/api/walls/strict/requests', {
      request: { ...dimension, itemId: 'ghost' },
    });
    expect(ghost.status).toBe(422);
    expect((await ghost.json<ApiErrorBody>()).error.code).toBe('invalid_request');
    const compare = await post('/api/walls/strict/requests', {
      request: { kind: 'compare', payload: { modelRefIds: ['m1', 'm2'] } },
    });
    expect(compare.status).toBe(422);
    const wrongShape = await post('/api/walls/strict/requests', {
      request: { kind: 'dimension', payload: { candidates: [] } },
    });
    expect(wrongShape.status).toBe(400);
    expect((await http(`${base}/api/walls/strict/requests/nope`)).status).toBe(404);
    expect((await http(`${base}/api/walls/strict/requests?status=weird`)).status).toBe(400);
  });

  test('a job can ask the user and continue with the answer', async () => {
    await createWall('jobask');
    const submitted: { job: { id: string } } = await (
      await post('/api/jobs', { kind: 'test.ask', wallId: 'jobask', input: { wallId: 'jobask' } })
    ).json();
    const stream = await openSse('/api/walls/jobask/events');
    const [pushed] = await stream.take(1, 'request_input');
    const asked = RequestInputFrameSchema.parse(pushed?.data).request;
    expect(asked.createdBy).toMatchObject({ kind: 'agent', name: 'ask-job' });
    await post(`/api/walls/jobask/requests/${asked.id}/answer`, { answer: { length: 42 } });
    await stream.close();
    await (await openSse(`/api/jobs/${submitted.job.id}/events`)).drain();
    const finished: { job: { state: string; result: JsonValue } } = await (
      await http(`${base}/api/jobs/${submitted.job.id}`)
    ).json();
    expect(finished.job).toMatchObject({ state: 'succeeded', result: { got: { length: 42 } } });
  });
});
