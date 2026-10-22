/**
 * Offline end-to-end of the chatgpt-browser backend against the fake page: real Chrome (headless,
 * throw-away profile, own loopback CDP port), real CDP driving, real persisted guard state. Skipped
 * when no Chrome is installed. Proves mechanics only, not the real ChatGPT DOM.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type DrawRequest } from '@hsw-editor/draw';
import { cdpReachable } from './cdp.ts';
import { stopBrowser, findChrome } from './browser-process.ts';
import { type DrawRuntime, createDrawRuntime } from './runtime.ts';
import { decodeRaw } from './image.ts';
import { type FakeChatgpt, startFakeChatgpt } from './fixtures/fake-chatgpt.ts';
import { type Scratch, scratchDir, writeObjectPng } from './test-helpers.ts';

const chrome = findChrome();

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port ?? 0;
  await probe.stop(true);
  return port;
}

describe.skipIf(chrome === null)('chatgpt-browser backend vs offline fixture', () => {
  let scratch: Scratch;
  let fixture: FakeChatgpt;
  let runtime: DrawRuntime;
  let ref: string;
  let cdpPortValue = 0;
  const makeRuntime = (baseUrl: string) =>
    createDrawRuntime({
      env: { HSW_EDITOR_DATA_DIR: scratch.dir },
      baseUrl,
      stopWhenDone: false,
      browser: { headless: true, cdpPort: cdpPortValue, profileDir: `${scratch.dir}/profile` },
      chatgptGuard: { minIntervalMs: 0, dailyCap: 10 },
    });
  const request = (tag: string): DrawRequest => ({
    version: 1,
    prompt: 'orthographic side view, white background, no shadows',
    refs: [{ path: ref, role: 'subject' }],
    n: 1,
    size: '1024x1024',
    outDir: `${scratch.dir}/out`,
    tag,
    timeoutMs: 120_000,
  });

  beforeAll(async () => {
    scratch = await scratchDir();
    ref = `${scratch.dir}/ref.png`;
    await writeObjectPng(ref);
    fixture = startFakeChatgpt(ref);
    cdpPortValue = await freePort();
    runtime = makeRuntime(fixture.baseUrl);
  });
  afterAll(async () => {
    await stopBrowser(runtime.chatgpt.browser);
    // Chrome keeps writing to its profile while it exits; wait it out so cleanup really removes it.
    while (await cdpReachable(cdpPortValue)) await Bun.sleep(200);
    await Bun.sleep(2000);
    fixture.stop();
    await scratch.cleanup();
  });

  test('uploads the reference, sends the prompt, extracts the generated image, records the send', async () => {
    const result = await runtime.run(
      request('wall/box/side'),
      new AbortController().signal,
      'chatgpt-browser',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(1);
    const image = result.images[0];
    expect(image?.mime).toBe('image/png');
    expect(image?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // the fake "generation" returns the reference image bytes: same pixels come back out
    const raw = await decodeRaw(image?.path ?? '');
    expect([raw.width, raw.height]).toEqual([512, 512]);
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]?.files).toBe(1);
    expect(fixture.sends[0]?.text).toContain('Image 1 is a subject image.');
    expect((await runtime.store.get('chatgpt-browser')).sends).toHaveLength(1);
  }, 120_000);

  test('image-limit alert becomes quota_exhausted with the parsed reset, persisted; next call refuses locally', async () => {
    const quotaRuntime = makeRuntime(`${fixture.baseUrl}/quota`);
    const first = await quotaRuntime.run(
      request('wall/box/top'),
      new AbortController().signal,
      'chatgpt-browser',
    );
    expect(first).toMatchObject({
      ok: false,
      error: { code: 'quota_exhausted', retryAfterMs: 9_000_000, retryable: true },
    });
    const guard = await quotaRuntime.store.get('chatgpt-browser');
    expect(guard.blockedUntil).toBeGreaterThan(Date.now() + 8_900_000);

    const loadsBefore = fixture.pageLoads();
    const second = await quotaRuntime.run(
      request('wall/box/front'),
      new AbortController().signal,
      'chatgpt-browser',
    );
    expect(second).toMatchObject({ ok: false, error: { code: 'quota_exhausted' } });
    expect(fixture.pageLoads()).toBe(loadsBefore); // browser untouched
    // clear the block for the following test
    await quotaRuntime.store.update('chatgpt-browser', (g) => ({
      ...g,
      blockedUntil: 0,
      blockReason: '',
    }));
  }, 120_000);

  test('a logged-out page stops at login_required without typing anything', async () => {
    const sendsBefore = fixture.sends.length;
    const loggedOut = makeRuntime(`${fixture.baseUrl}/loggedout`);
    const result = await loggedOut.run(
      request('wall/box/back'),
      new AbortController().signal,
      'chatgpt-browser',
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'login_required', retryable: false },
    });
    expect(fixture.sends).toHaveLength(sendsBefore);
    expect((await loggedOut.store.get('chatgpt-browser')).loginRequiredAt).toBeGreaterThan(0);
  }, 120_000);
});
