import { afterEach, beforeEach, expect, test } from 'bun:test';
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
