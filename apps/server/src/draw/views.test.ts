import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  type DrawBackend,
  type DrawCandidate,
  DrawError,
  type DrawRequest,
  type DrawResult,
} from '@hsw-editor/draw';
import sharp from 'sharp';
import { saveImage } from './image.ts';
import { createDrawRuntime } from './runtime.ts';
import { type Scratch, scratchDir, writeObjectPng } from './test-helpers.ts';
import { generateViews } from './views.ts';

let scratch: Scratch;
beforeEach(async () => {
  scratch = await scratchDir();
});
afterEach(() => scratch.cleanup());

async function grayPng(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 512, height: 512, channels: 3, background: '#999999' } })
      .png()
      .toBuffer(),
  );
}

/** Backend that answers each request from a script of image bytes (or an error) and records refs. */
function scripted(
  script: Array<Uint8Array | DrawError>,
): DrawBackend & { requests: DrawRequest[] } {
  const requests: DrawRequest[] = [];
  return {
    id: 'omp',
    requests,
    async draw(req): Promise<DrawResult> {
      requests.push(req);
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      if (next instanceof DrawError) throw next;
      const image = await saveImage(req.outDir, `fake-${requests.length}`, next);
      return { ok: true, backend: 'omp', images: [image], meta: { elapsedMs: 1 } };
    },
  };
}

async function setup(script: Array<Uint8Array | DrawError>) {
  const subject = `${scratch.dir}/subject.png`;
  await writeObjectPng(subject);
  const backend = scripted(script);
  const runtime = createDrawRuntime({
    env: { HSW_EDITOR_DATA_DIR: scratch.dir },
    backends: { omp: backend },
  });
  await runtime.setSettings({ backend: 'omp' });
  const attached: DrawCandidate[] = [];
  const hooks = {
    signal: new AbortController().signal,
    progress: () => undefined,
    log: () => undefined,
    attach: async (c: DrawCandidate) => void attached.push(c),
  };
  return { subject, backend, runtime, attached, hooks };
}

async function goodPng(): Promise<Uint8Array> {
  const path = `${scratch.dir}/good.png`;
  await writeObjectPng(path);
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

test('accepted views are attached and chained as refs; rejected ones are kept but not attached', async () => {
  const { subject, backend, runtime, attached, hooks } = await setup([
    await goodPng(),
    await grayPng(),
    await goodPng(),
  ]);
  const outcome = await generateViews(
    runtime,
    {
      tag: 'wall/box',
      object: { name: 'box' },
      views: ['front', 'side', 'top'],
      subjectPaths: [subject],
    },
    hooks,
  );
  expect(outcome.status).toBe('done');
  expect(outcome.candidates.map((c) => [c.view, c.accepted])).toEqual([
    ['front', true],
    ['side', false],
    ['top', true],
  ]);
  expect(outcome.candidates[1]?.quality.issues.map((i) => i.code)).toContain(
    'background_not_white',
  );
  expect(attached.map((c) => c.view)).toEqual(['front', 'top']);
  expect(attached.every((c) => c.source === 'generated' && c.promptTemplateVersion === 1)).toBe(
    true,
  );
  // front: subject only; side: subject + accepted front; top: subject + front (rejected side not chained)
  expect(backend.requests.map((r) => r.refs.map((ref) => ref.role))).toEqual([
    ['subject'],
    ['subject', 'view'],
    ['subject', 'view'],
  ]);
  expect(backend.requests[2]?.refs[1]?.path).toBe(outcome.candidates[0]?.path);
});

test('a backend failure stops the plan and reports the failing view and code', async () => {
  const { subject, runtime, attached, hooks } = await setup([
    await goodPng(),
    new DrawError('quota_exhausted', 'limit', { retryAfterMs: 120_000 }),
  ]);
  const outcome = await generateViews(
    runtime,
    { tag: 'wall/box', object: { name: 'box' }, views: ['front', 'side'], subjectPaths: [subject] },
    hooks,
  );
  expect(outcome).toMatchObject({
    status: 'failed',
    view: 'side',
    code: 'quota_exhausted',
    retryAfterMs: 120_000,
  });
  expect(outcome.candidates).toHaveLength(1);
  expect(attached).toHaveLength(1);
});
