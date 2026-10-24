import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type DrawBackend,
  type DrawBackendId,
  DrawError,
  type DrawRequest,
  type DrawResult,
} from '@hsw-editor/draw';
import { type DrawRuntime, createDrawRuntime } from './runtime.ts';
import { type Scratch, scratchDir } from './test-helpers.ts';

const request: DrawRequest = {
  version: 1,
  prompt: 'side view',
  refs: [],
  n: 1,
  size: '1024x1024',
  outDir: '/x',
  tag: 't',
};

interface Fake extends DrawBackend {
  calls: number;
}

function fake(id: DrawBackendId, outcome: () => DrawResult | DrawError): Fake {
  const backend: Fake = {
    id,
    calls: 0,
    async draw() {
      backend.calls++;
      const result = outcome();
      if (result instanceof DrawError) throw result;
      return result;
    },
  };
  return backend;
}

const okResult = (backend: DrawBackendId): DrawResult => ({
  ok: true,
  backend,
  images: [],
  meta: { elapsedMs: 1 },
});

describe('runtime auto chain', () => {
  let scratch: Scratch;
  beforeEach(async () => {
    scratch = await scratchDir();
  });
  afterEach(() => scratch.cleanup());

  const make = (backends: Partial<Record<DrawBackendId, DrawBackend>>): DrawRuntime =>
    createDrawRuntime({
      env: { HSW_EDITOR_DATA_DIR: scratch.dir },
      // draw-cli is the real `draw` unless faked: an auto chain here must never reach a real generation
      backends: {
        'draw-cli': fake('draw-cli', () => new DrawError('backend_unavailable', 'not installed')),
        ...backends,
      },
    });

  test('falls through login_required to the next backend, and remembers the login wall', async () => {
    const omp = fake('omp', () => new DrawError('login_required', 'no creds'));
    const browser = fake('chatgpt-browser', () => okResult('chatgpt-browser'));
    const runtime = make({ omp, 'chatgpt-browser': browser });
    const result = await runtime.run(request, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, backend: 'chatgpt-browser' });
    expect(omp.calls).toBe(1);
    // second request: omp is skipped locally (recorded login wall), no second omp call
    await runtime.run(request, new AbortController().signal);
    expect(omp.calls).toBe(1);
    expect(browser.calls).toBe(2);
  });

  test('quota stops the chain (never retried on the sibling backend) and blocks later calls locally', async () => {
    const omp = fake(
      'omp',
      () => new DrawError('quota_exhausted', 'limit', { retryAfterMs: 3_600_000 }),
    );
    const browser = fake('chatgpt-browser', () => okResult('chatgpt-browser'));
    const runtime = make({ omp, 'chatgpt-browser': browser });
    const first = await runtime.run(request, new AbortController().signal);
    expect(first).toMatchObject({ ok: false, error: { code: 'quota_exhausted' } });
    expect(browser.calls).toBe(0);
    const second = await runtime.run(request, new AbortController().signal);
    expect(second).toMatchObject({ ok: false, error: { code: 'quota_exhausted' } });
    expect(omp.calls).toBe(1); // second answer came from the persisted block
  });

  test('a challenge is never retried automatically', async () => {
    const omp = fake('omp', () => new DrawError('login_required', 'x'));
    const browser = fake('chatgpt-browser', () => new DrawError('challenge', 'captcha'));
    const manual = fake(
      'manual',
      () => new DrawError('manual_pending', 'upload', { jobDir: '/j' }),
    );
    const runtime = make({ omp, 'chatgpt-browser': browser, manual });
    const result = await runtime.run(request, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: { code: 'challenge' } });
    expect(manual.calls).toBe(0);
  });

  test('with nothing logged in, auto ends at manual_pending', async () => {
    const runtime = make({
      omp: fake('omp', () => new DrawError('login_required', 'x')),
      'chatgpt-browser': fake(
        'chatgpt-browser',
        () => new DrawError('backend_unavailable', 'no chrome'),
      ),
      manual: fake('manual', () => new DrawError('manual_pending', 'upload', { jobDir: '/j' })),
    });
    const result = await runtime.run(request, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      backend: 'manual',
      error: { code: 'manual_pending', jobDir: '/j' },
    });
  });

  test('settings choose one backend, with no fallthrough', async () => {
    const omp = fake('omp', () => okResult('omp'));
    const browser = fake('chatgpt-browser', () => new DrawError('login_required', 'x'));
    const runtime = make({ omp, 'chatgpt-browser': browser });
    await runtime.setSettings({ backend: 'chatgpt-browser' });
    const result = await runtime.run(request, new AbortController().signal);
    expect(result).toMatchObject({
      ok: false,
      backend: 'chatgpt-browser',
      error: { code: 'login_required' },
    });
    expect(omp.calls).toBe(0);
  });
});
