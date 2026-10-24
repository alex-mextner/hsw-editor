import { afterEach, beforeEach, expect, test } from 'bun:test';
import { DrawError } from '@hsw-editor/draw';
import { mapOmpError } from './backends/omp.ts';
import {
  QUOTA_PATTERN,
  classifyProbe,
  composePrompt,
  parseRetryAfterMs,
} from './backends/chatgpt-browser.ts';
import { createDrawRuntime } from './runtime.ts';
import { createDrawRoutes } from './routes.ts';
import { getBackendStatuses } from './status.ts';
import { type Scratch, scratchDir } from './test-helpers.ts';
import { applyFailure, recordSend } from './guard.ts';

let scratch: Scratch;
let chromeBefore: string | undefined;
beforeEach(async () => {
  scratch = await scratchDir();
  // The status probe resolves Chrome from the process environment (findChrome()), not from the runtime's
  // env: pin it so the test does not depend on a Chrome being installed on the machine.
  chromeBefore = process.env['HSW_CHATGPT_CHROME'];
  process.env['HSW_CHATGPT_CHROME'] = '/bin/true';
});
afterEach(async () => {
  if (chromeBefore === undefined) delete process.env['HSW_CHATGPT_CHROME'];
  else process.env['HSW_CHATGPT_CHROME'] = chromeBefore;
  await scratch.cleanup();
});

test('omp image-chain failures map to login_required with the one-time command', () => {
  const err = mapOmpError('Image generation exhausted the resolved image chain.');
  expect(err.code).toBe('login_required');
  expect(err.message).toContain('omp login openai-codex');
  expect(mapOmpError('HTTP 429 rate limit').code).toBe('quota_exhausted');
  expect(mapOmpError('something else').code).toBe('refused');
});

test('reset hints parse into milliseconds', () => {
  expect(parseRetryAfterMs('limit resets in 2 hours 30 minutes')).toBe(9_000_000);
  expect(parseRetryAfterMs('try again in 45 minutes')).toBe(2_700_000);
  expect(parseRetryAfterMs('limit reached, come back later')).toBeUndefined();
});

test('quota wording matches limit messages but not policy refusals', () => {
  for (const quota of [
    "You've hit the limit for image generation requests. You can create more images when the limit resets in 2 hours.",
    "You've reached the free plan limit for images. Try again in 3 hours.",
    'Too many requests',
  ]) {
    expect(QUOTA_PATTERN.test(quota)).toBe(true);
  }
  for (const refusal of [
    "I can't draw this: depicting branded products is limited by policy.",
    'Here is a description of the limitations of the object.',
  ]) {
    expect(QUOTA_PATTERN.test(refusal)).toBe(false);
  }
});

test('probe classification: captcha beats login wall; logged-in composer passes', () => {
  const base = { loggedIn: false, loginWall: false, challenge: false, composer: false, title: 't' };
  expect(classifyProbe({ ...base, loginWall: true, challenge: true })?.code).toBe('challenge');
  expect(classifyProbe({ ...base, loginWall: true })?.code).toBe('login_required');
  expect(classifyProbe({ ...base, loggedIn: true, composer: true })).toBeNull();
});

test('prompt composition numbers the references', () => {
  const text = composePrompt({
    version: 1,
    prompt: 'side view',
    refs: [{ path: '/a.png', role: 'subject' }, { path: '/b.png' }],
    n: 1,
    size: '1024x1024',
    outDir: '/o',
  });
  expect(text).toStartWith(
    'Image 1 is a subject image. Image 2 is a reference image. Create an image',
  );
});

test('status reports quota block with retryAfterMs and the challenge state; GET /api/draw/backends serves it', async () => {
  const runtime = createDrawRuntime({
    env: {
      HSW_EDITOR_DATA_DIR: scratch.dir,
      HSW_OMP_BIN: '/nonexistent/omp',
      HSW_CHATGPT_HEADLESS: '1',
    },
  });
  await runtime.store.update('chatgpt-browser', (g) =>
    applyFailure(
      recordSend(g, Date.now()),
      new DrawError('quota_exhausted', 'limit', { retryAfterMs: 600_000 }),
      Date.now(),
    ),
  );
  const statuses = await getBackendStatuses(runtime);
  const browser = statuses.find((s) => s.id === 'chatgpt-browser');
  expect(browser).toMatchObject({ state: 'quota_exhausted', sendsLast24h: 1 });
  expect(browser?.retryAfterMs).toBeGreaterThan(590_000);
  expect(statuses.find((s) => s.id === 'omp')?.state).toBe('unavailable');

  const routes = createDrawRoutes(runtime);
  const res = await routes(new Request('http://x/api/draw/backends'));
  const body = (await res?.json()) as {
    settings: { backend: string };
    backends: Array<{ id: string }>;
  };
  expect(body.settings.backend).toBe('auto');
  expect(body.backends.map((b) => b.id)).toEqual(['omp', 'chatgpt-browser', 'manual']);

  const put = await routes(
    new Request('http://x/api/draw/settings', {
      method: 'PUT',
      body: JSON.stringify({ backend: 'manual' }),
    }),
  );
  expect(put?.status).toBe(200);
  expect(await runtime.getSettings()).toEqual({ backend: 'manual' });
  const bad = await routes(
    new Request('http://x/api/draw/settings', {
      method: 'PUT',
      body: JSON.stringify({ backend: 'dalle' }),
    }),
  );
  expect(bad?.status).toBe(400);
});
