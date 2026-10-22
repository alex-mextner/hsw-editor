/** Integration tests: the real daemon with the client-error module against a temp data dir. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createClientErrorsModule } from './clientErrors.ts';
import { startServer, type RunningServer } from './server.ts';

const TextEntriesSchema = z.object({
  entries: z.array(
    z.object({
      message: z.string(),
      stack: z.string().optional(),
      userAgent: z.string().optional(),
    }),
  ),
});
const ROTATE_AT = 20_000;
const EntriesSchema = z.object({
  entries: z.array(z.looseObject({ kind: z.string(), message: z.string() })),
});
const ErrorSchema = z.object({ error: z.object({ code: z.string() }) });

let running: RunningServer;
let root: string;
let logFile: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-client-errors-'));
  running = await startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home: join(root, 'home'),
      webDist: join(root, 'dist'),
      allowedOrigins: ['http://127.0.0.1:5194'],
      heartbeatMs: 1000,
    },
    { modules: [createClientErrorsModule({ maxLogBytes: ROTATE_AT })] },
  );
  logFile = join(root, 'home/logs/client-errors.jsonl');
});

afterAll(async () => {
  await running.stop();
  rmSync(root, { recursive: true, force: true });
});

function report(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return fetch(`${running.url}/api/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      kind: 'asset-load',
      message: 'Could not load /bank/assets/glb/a47bacef44e3f4f4.glb: 404',
      ts: '2026-10-22T10:00:00.000Z',
      ...overrides,
    }),
  });
}

async function entries(limit?: number) {
  const query = limit === undefined ? '' : `?limit=${limit}`;
  const response = await fetch(`${running.url}/api/client-errors${query}`);
  return EntriesSchema.parse(await response.json()).entries;
}

function resetLog() {
  rmSync(join(root, 'home/logs'), { recursive: true, force: true });
}

describe('POST /api/client-errors', () => {
  test('a valid report answers 204 no-store and lands as one JSON line on disk', async () => {
    resetLog();
    const response = await report({
      bankId: 'caliper',
      status: 404,
      detail: { retries: 1, sw: true },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const lines = readFileSync(logFile, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      kind: 'asset-load',
      bankId: 'caliper',
      status: 404,
      detail: { retries: 1, sw: true },
    });
  });

  test('unknown kind, missing message and bad ts are 400 in the error envelope', async () => {
    for (const bad of [
      { kind: 'nope' },
      { message: '' },
      { message: undefined },
      { ts: 'yesterday' },
      { ts: 'March 5, 2026' },
    ]) {
      const response = await report(bad);
      expect(response.status).toBe(400);
      expect(ErrorSchema.parse(await response.json()).error.code).toBe('invalid_body');
    }
    const garbage = await fetch(`${running.url}/api/client-errors`, { method: 'POST', body: '{' });
    expect(garbage.status).toBe(400);
    expect(ErrorSchema.parse(await garbage.json()).error.code).toBe('invalid_json');
  });

  test('a body above 16 KiB is 413 and nothing is logged', async () => {
    resetLog();
    const response = await report({ detail: { blob: 'x'.repeat(17 * 1024) } });
    expect(response.status).toBe(413);
    expect(ErrorSchema.parse(await response.json()).error.code).toBe('payload_too_large');
    expect(existsSync(logFile)).toBe(false);
  });

  test('free-text fields are truncated to their caps', async () => {
    resetLog();
    await report({
      message: 'm'.repeat(3000),
      stack: 's'.repeat(5000),
      userAgent: 'u'.repeat(400),
    });
    const [entry] = TextEntriesSchema.parse({ entries: await entries() }).entries;
    expect(entry?.message).toHaveLength(2000);
    expect(entry?.stack).toHaveLength(4000);
    expect(entry?.userAgent).toHaveLength(300);
  });

  test('query strings never reach the log (url, page, message, stack, relative paths, detail)', async () => {
    resetLog();
    await report({
      message:
        'Could not load /bank/assets/glb/a.glb?token=SECRET1: 404 from https://x.test/a?k=SECRET2#frag, also a.glb?sig=SECRET6 and https://en.test/w/Honey_(gel)?tok=SECRET7',
      url: '/bank/assets/glb/a.glb?token=SECRET3',
      page: 'http://127.0.0.1:8794/walls/w1?auth=SECRET4#top',
      stack: 'Error\n    at load (http://127.0.0.1:8794/assets/app.js?sig=SECRET5:1:2)',
      detail: {
        src: 'https://cdn.test/a.glb?sig=SECRET8',
        'https://cdn.test/b.glb?sig=SECRET9': 404,
        attempts: 2,
      },
    });
    const raw = readFileSync(logFile, 'utf8');
    expect(raw).not.toContain('SECRET');
    expect(raw).toContain('/bank/assets/glb/a.glb');
    expect(raw).toContain('http://127.0.0.1:8794/walls/w1');
    expect(raw).toContain('https://cdn.test/a.glb');
    expect(raw).toContain('"attempts":2');
  });

  test('detail keys that collide after scrubbing are kept, not overwritten', async () => {
    resetLog();
    await report({
      detail: { 'https://cdn/a.glb?sig=1': 404, 'https://cdn/a.glb?sig=2': 200 },
    });
    const raw = readFileSync(logFile, 'utf8');
    expect(raw).not.toContain('sig=');
    expect(raw).toContain('"https://cdn/a.glb":404');
    expect(raw).toContain('"https://cdn/a.glb#2":200');
  });

  test('a message that is only a query string is stored as a placeholder and read back', async () => {
    resetLog();
    expect((await report({ message: '?token=SECRET' })).status).toBe(204);
    expect((await entries()).map((entry) => entry.message)).toEqual(['(scrubbed)']);
  });

  test('a foreign Origin is rejected by the guard and nothing is logged', async () => {
    resetLog();
    const response = await report({}, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(ErrorSchema.parse(await response.json()).error.code).toBe('forbidden_origin');
    const read = await fetch(`${running.url}/api/client-errors`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(read.status).toBe(403);
    expect(existsSync(logFile)).toBe(false);
    expect((await report({}, { origin: 'http://127.0.0.1:5194' })).status).toBe(204);
  });

  test('concurrent reports are all written, none interleaved or duplicated', async () => {
    resetLog();
    const count = 40;
    const padding = 'p'.repeat(300);
    const statuses = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        report({ message: `m${index} ${padding}` }).then((response) => response.status),
      ),
    );
    expect(statuses.every((status) => status === 204)).toBe(true);
    expect(existsSync(`${logFile}.1`)).toBe(false);
    const lines = readFileSync(logFile, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(count);
    const seen = lines.map((line) =>
      String(z.looseObject({ message: z.string() }).parse(JSON.parse(line)).message.split(' ')[0]),
    );
    expect(new Set(seen)).toEqual(
      new Set(Array.from({ length: count }, (_, index) => `m${index}`)),
    );
  });

  test('rotation keeps one generation once the cap is reached', async () => {
    resetLog();
    const padding = 'r'.repeat(400);
    const total = 120;
    for (let index = 0; index < total; index++) {
      expect((await report({ message: `rot${index} ${padding}` })).status).toBe(204);
    }
    expect(existsSync(`${logFile}.1`)).toBe(true);
    expect(existsSync(`${logFile}.2`)).toBe(false);
    expect(readFileSync(logFile, 'utf8').length).toBeLessThanOrEqual(ROTATE_AT);
    const messages = (await entries(500)).map((entry) => entry.message.split(' ')[0]);
    expect(messages.at(-1)).toBe(`rot${total - 1}`);
    expect(messages).toEqual(
      [...messages].sort((a, b) => Number(a?.slice(3)) - Number(b?.slice(3))),
    );
  });

  test('a body streamed without content-length is still capped at 16 KiB', async () => {
    resetLog();
    const chunk = new TextEncoder().encode('x'.repeat(4096));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 8; index++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await fetch(`${running.url}/api/client-errors`, {
      method: 'POST',
      body,
      duplex: 'half',
    });
    expect(response.status).toBe(413);
    expect(existsSync(logFile)).toBe(false);
  });
});

describe('GET /api/client-errors', () => {
  test('returns the last N entries, newest last, and skips a torn last line', async () => {
    resetLog();
    for (let index = 0; index < 5; index++) await report({ message: `e${index}` });
    appendFileSync(logFile, '{"kind":"render","message":"torn');
    const last3 = await entries(3);
    expect(last3.map((entry) => entry.message)).toEqual(['e2', 'e3', 'e4']);
    expect(await entries()).toHaveLength(5);
    const response = await fetch(`${running.url}/api/client-errors?limit=2`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('is empty with no log, caps limit at 500 and rejects a bad limit', async () => {
    resetLog();
    expect(await entries()).toEqual([]);
    expect((await fetch(`${running.url}/api/client-errors?limit=100000`)).status).toBe(200);
    for (const limit of ['0', 'abc', '1.5']) {
      const response = await fetch(`${running.url}/api/client-errors?limit=${limit}`);
      expect(response.status).toBe(400);
    }
  });

  test('tolerates a log file that is only a torn line', async () => {
    resetLog();
    await report({ message: 'seed' });
    writeFileSync(logFile, '{"kind":"ren');
    expect(await entries()).toEqual([]);
    // The next report must not be glued onto the fragment.
    expect((await report({ message: 'after-crash' })).status).toBe(204);
    expect((await entries()).map((entry) => entry.message)).toEqual(['after-crash']);
  });

  test('a disk failure is a 500 in the error envelope, not a bare page', async () => {
    resetLog();
    writeFileSync(join(root, 'home/logs'), 'not a directory');
    const response = await report();
    expect(response.status).toBe(500);
    expect(ErrorSchema.parse(await response.json()).error.code).toBe('internal');
    rmSync(join(root, 'home/logs'), { force: true });
  });
});
