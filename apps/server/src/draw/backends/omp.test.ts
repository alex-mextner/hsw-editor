import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod } from 'node:fs/promises';
import { DrawError, type DrawRequest } from '@hsw-editor/draw';
import { GuardStore } from '../guard.ts';
import { type Scratch, scratchDir, writeObjectPng } from '../test-helpers.ts';
import { OmpBackend, type OmpConfig } from './omp.ts';

let scratch: Scratch;
beforeEach(async () => {
  scratch = await scratchDir();
});
afterEach(() => scratch.cleanup());

/** A stand-in `omp` that behaves per `mode`, counting its invocations in a file. */
async function fakeOmp(
  mode: 'ok' | 'prose-then-ok' | 'no-credentials' | 'never-calls',
): Promise<OmpConfig> {
  const image = `${scratch.dir}/generated.png`;
  await writeObjectPng(image);
  const script = `${scratch.dir}/omp`;
  await Bun.write(
    script,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const counter = ${JSON.stringify(`${scratch.dir}/calls`)};
appendFileSync(counter, 'x');
const calls = readFileSync(counter, 'utf8').length;
const mode = ${JSON.stringify(mode)};
const end = (extra) => console.log(JSON.stringify({ type: 'tool_execution_end', toolName: 'generate_image', ...extra }));
console.log('{"type":"agent_start"}');
if (mode === 'never-calls' || (mode === 'prose-then-ok' && calls === 1)) {
  console.log('{"type":"message","text":"I would draw a box"}');
} else if (mode === 'no-credentials') {
  end({ isError: true, result: { content: [{ type: 'text', text: 'Image generation exhausted the resolved image chain.' }] } });
} else {
  end({ isError: false, result: { content: [], details: { imagePaths: [${JSON.stringify(image)}], model: 'gpt-image-2' } } });
}
`,
  );
  await chmod(script, 0o755);
  return { bin: script, driverModel: 'haiku', guard: { minIntervalMs: 0, dailyCap: 10 } };
}

const request = (): DrawRequest => ({
  version: 1,
  prompt: 'side view',
  refs: [],
  n: 1,
  size: '1024x1024',
  outDir: `${scratch.dir}/out`,
  tag: 'omp-test',
  timeoutMs: 60_000,
});

const callsMade = async () => (await Bun.file(`${scratch.dir}/calls`).text()).length;

test('success: parses imagePaths from the tool event, saves the image, records the send', async () => {
  const store = new GuardStore(`${scratch.dir}/guard.json`);
  const result = await new OmpBackend(store, await fakeOmp('ok')).draw(
    request(),
    new AbortController().signal,
  );
  expect(result).toMatchObject({ ok: true, backend: 'omp', meta: { model: 'gpt-image-2' } });
  expect(result.ok && result.images[0]).toMatchObject({
    mime: 'image/png',
    width: 512,
    height: 512,
  });
  expect((await store.get('omp')).sends).toHaveLength(1);
});

test('the driver model answering in prose is retried once', async () => {
  const store = new GuardStore(`${scratch.dir}/guard.json`);
  const result = await new OmpBackend(store, await fakeOmp('prose-then-ok')).draw(
    request(),
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  expect(await callsMade()).toBe(2);
});

test('a driver that never calls the tool fails after exactly two runs, as backend_unavailable', async () => {
  const store = new GuardStore(`${scratch.dir}/guard.json`);
  const failure = await new OmpBackend(store, await fakeOmp('never-calls'))
    .draw(request(), new AbortController().signal)
    .catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(DrawError);
  expect((failure as DrawError).code).toBe('backend_unavailable');
  expect(await callsMade()).toBe(2);
});

test('an empty image chain becomes login_required with the one-time command', async () => {
  const store = new GuardStore(`${scratch.dir}/guard.json`);
  const failure = await new OmpBackend(store, await fakeOmp('no-credentials'))
    .draw(request(), new AbortController().signal)
    .catch((e: unknown) => e);
  expect((failure as DrawError).code).toBe('login_required');
  expect((failure as DrawError).message).toContain('omp login openai-codex');
});

test('no second run is spawned when the request budget is nearly spent', async () => {
  const store = new GuardStore(`${scratch.dir}/guard.json`);
  const config = await fakeOmp('never-calls');
  const failure = await new OmpBackend(store, config)
    .draw({ ...request(), timeoutMs: 5000 }, new AbortController().signal)
    .catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(DrawError);
  expect(await callsMade()).toBe(1);
});
