import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, utimes } from 'node:fs/promises';
import { DrawError, type DrawRequest } from '@hsw-editor/draw';
import { ManualBackend, manualJobId } from './backends/manual.ts';
import { createDrawRoutes } from './routes.ts';
import { createDrawRuntime } from './runtime.ts';
import { pngBytes, type Scratch, scratchDir, writeObjectPng } from './test-helpers.ts';

let scratch: Scratch;
beforeEach(async () => {
  scratch = await scratchDir();
});
afterEach(() => scratch.cleanup());

async function pending(backend: ManualBackend, req: DrawRequest): Promise<DrawError> {
  try {
    await backend.draw(req);
  } catch (error) {
    if (error instanceof DrawError) return error;
    throw error;
  }
  throw new Error('expected manual_pending');
}

test('manual round trip: pending job with prompt+refs, upload via API, same request collects', async () => {
  const runtime = createDrawRuntime({ env: { HSW_EDITOR_DATA_DIR: scratch.dir } });
  const ref = `${scratch.dir}/subject.png`;
  await writeObjectPng(ref);
  const req: DrawRequest = {
    version: 1,
    prompt: 'orthographic side view of the box',
    refs: [{ path: ref, role: 'subject' }],
    n: 1,
    size: '1024x1024',
    outDir: runtime.paths.workDir,
    tag: 'wall1/box/side',
  };
  const backend = new ManualBackend();

  const first = await pending(backend, req);
  expect(first.code).toBe('manual_pending');
  expect(first.extra.jobDir).toEndWith(`manual-${manualJobId(req)}`);
  expect(await Bun.file(`${first.extra.jobDir}/prompt.txt`).text()).toContain(
    'orthographic side view',
  );

  const routes = createDrawRoutes(runtime);
  const id = manualJobId(req);
  const info = await routes(new Request(`http://x/api/draw/manual/${id}`));
  expect(info?.status).toBe(200);
  expect(await info?.json()).toMatchObject({ id, uploaded: 0, refs: ['ref-1-subject.png'] });

  const notAnImage = await routes(
    new Request(`http://x/api/draw/manual/${id}/inbox`, { method: 'POST', body: 'hello' }),
  );
  expect(notAnImage?.status).toBe(400);

  const uploaded = await routes(
    new Request(`http://x/api/draw/manual/${id}/inbox`, {
      method: 'POST',
      body: await pngBytes(64),
    }),
  );
  expect(uploaded?.status).toBe(201);

  const done = await backend.draw(req);
  expect(done).toMatchObject({
    ok: true,
    backend: 'manual',
    images: [{ mime: 'image/png', width: 64, height: 64 }],
  });
  // idempotent: asking again returns the same image, not a new job
  const again = await backend.draw(req);
  expect(again.ok && again.images[0]?.sha256).toBe(done.ok && done.images[0]?.sha256);
});

test('an oversized chunked upload is rejected without buffering it all', async () => {
  const runtime = createDrawRuntime({ env: { HSW_EDITOR_DATA_DIR: scratch.dir } });
  const req: DrawRequest = {
    version: 1,
    prompt: 'p',
    refs: [],
    n: 1,
    size: '1024x1024',
    outDir: runtime.paths.workDir,
    tag: 'big',
  };
  await pending(new ManualBackend(), req);
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent++;
      controller.enqueue(chunk);
      if (sent >= 60) controller.close();
    },
  });
  const response = await createDrawRoutes(runtime)(
    new Request(`http://x/api/draw/manual/${manualJobId(req)}/inbox`, {
      method: 'POST',
      body,
      duplex: 'half',
    }),
  );
  expect(response?.status).toBe(400);
  expect(sent).toBeLessThan(45); // stopped reading soon after the 35 MiB limit
});

test('concurrent uploads are all kept', async () => {
  const runtime = createDrawRuntime({ env: { HSW_EDITOR_DATA_DIR: scratch.dir } });
  const req: DrawRequest = {
    version: 1,
    prompt: 'p',
    refs: [],
    n: 4,
    size: '1024x1024',
    outDir: runtime.paths.workDir,
    tag: 'concurrent',
  };
  const backend = new ManualBackend();
  await pending(backend, req);
  const routes = createDrawRoutes(runtime);
  const id = manualJobId(req);
  const png = await pngBytes(32);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      routes(new Request(`http://x/api/draw/manual/${id}/inbox`, { method: 'POST', body: png })),
    ),
  );
  expect(responses.map((r) => r?.status)).toEqual([201, 201, 201, 201]);
  const info = await routes(new Request(`http://x/api/draw/manual/${id}`));
  expect(await info?.json()).toMatchObject({ uploaded: 4 });
});

test('manual upload rejects ids that are not job ids and unknown jobs', async () => {
  const runtime = createDrawRuntime({ env: { HSW_EDITOR_DATA_DIR: scratch.dir } });
  const routes = createDrawRoutes(runtime);
  const traversal = await routes(
    new Request('http://x/api/draw/manual/..%2F..%2Fetc/inbox', { method: 'POST', body: 'x' }),
  );
  expect(traversal?.status).toBe(400);
  const unknown = await routes(new Request('http://x/api/draw/manual/0123456789ab'));
  expect(unknown?.status).toBe(404);
  expect(await routes(new Request('http://x/api/other'))).toBeNull();
});

test('the newest upload (by modification time, whatever its name) is collected, so a bad first upload can be replaced', async () => {
  const runtime = createDrawRuntime({ env: { HSW_EDITOR_DATA_DIR: scratch.dir } });
  const ref = `${scratch.dir}/subject.png`;
  await writeObjectPng(ref);
  const req: DrawRequest = {
    version: 1,
    prompt: 'orthographic top view of the box',
    refs: [{ path: ref, role: 'subject' }],
    n: 1,
    size: '1024x1024',
    outDir: runtime.paths.workDir,
    tag: 'wall1/box/top',
  };
  const backend = new ManualBackend();
  const first = await pending(backend, req);
  const inbox = `${first.extra.jobDir}/inbox`;
  await Bun.write(`${inbox}/upload-9999-z.png`, await pngBytes(64)); // the first upload (later found to be unusable)
  await Bun.write(`${inbox}/a-better-drawing.png`, await pngBytes(96)); // dropped in by hand later: sorts first by name
  // utimes also moves the inode change time to now, so the times are set around now: an hour apart cannot tie
  const hour = 3_600_000;
  await utimes(`${inbox}/upload-9999-z.png`, new Date(Date.now() - hour), new Date(Date.now() - hour));
  await utimes(`${inbox}/a-better-drawing.png`, new Date(Date.now() + hour), new Date(Date.now() + hour));
  const result = await backend.draw(req);
  expect(result.ok && result.images[0]?.width).toBe(96);
});

test('earlier drawn views chained as refs are not part of the manual job identity', async () => {
  const base: DrawRequest = {
    version: 1,
    prompt: 'orthographic top view of the box',
    refs: [{ path: '/work/subject.png', role: 'subject' }],
    n: 1,
    size: '1024x1024',
    outDir: '/work',
    tag: 'wall1/box/top',
  };
  const chained: DrawRequest = {
    ...base,
    refs: [...base.refs, { path: '/work/omp-1761230000000-side.png', role: 'view' }],
  };
  // an upload made for the request without the drawn side is still collected when the side was drawn meanwhile (or elsewhere)
  expect(manualJobId(chained)).toBe(manualJobId(base));
  expect(manualJobId({ ...base, refs: [{ path: '/work/other.png', role: 'subject' }] })).not.toBe(manualJobId(base));
});

test('the job page shows only the current refs, not those of an earlier run of the same request', async () => {
  const runtime = createDrawRuntime({ env: { HSW_EDITOR_DATA_DIR: scratch.dir } });
  const subject = `${scratch.dir}/subject.png`;
  await writeObjectPng(subject);
  const side1 = `${scratch.dir}/omp-111-side.png`;
  const side2 = `${scratch.dir}/chatgpt-222-side.png`;
  await writeObjectPng(side1);
  await writeObjectPng(side2);
  const base: DrawRequest = {
    version: 1,
    prompt: 'orthographic top view of the box',
    refs: [{ path: subject, role: 'subject' }],
    n: 1,
    size: '1024x1024',
    outDir: runtime.paths.workDir,
    tag: 'wall1/box/top',
  };
  const backend = new ManualBackend();
  await pending(backend, { ...base, refs: [...base.refs, { path: side1, role: 'view' }] });
  const second = await pending(backend, { ...base, refs: [...base.refs, { path: side2, role: 'view' }] });
  const refs = (await readdir(second.extra.jobDir ?? '')).filter((name) => name.startsWith('ref-'));
  expect(refs.sort()).toEqual(['ref-1-subject.png', 'ref-2-chatgpt-222-side.png']);
});
