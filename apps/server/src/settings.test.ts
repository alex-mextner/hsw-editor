/** `GET|PUT /api/settings` against the real daemon on an ephemeral port and a temp data dir. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SettingsDocument, SettingsRevConflictBody } from '@hsw-editor/user-settings';
import { SETTINGS_MAX_BYTES } from '@hsw-editor/user-settings';
import { startServer, type RunningServer } from './server.ts';

let root: string;
let home: string;
let running: RunningServer;

async function boot(): Promise<RunningServer> {
  return startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home,
      webDist: join(root, 'dist'),
      allowedOrigins: [],
      heartbeatMs: 1000,
    },
    { modules: [] },
  );
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-settings-'));
  home = join(root, 'home');
  running = await boot();
});

afterEach(async () => {
  await running.stop();
  rmSync(root, { recursive: true, force: true });
});

function put(body: object | string): Promise<Response> {
  return fetch(`${running.url}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readDocument(): Promise<SettingsDocument> {
  const response = await fetch(`${running.url}/api/settings`);
  return (await response.json()) as SettingsDocument;
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let level = 1; level < depth; level++) value = [value];
  return value;
}

const file = (): string => join(home, 'settings.json');

describe('GET /api/settings', () => {
  test('serves defaults when the file is absent and writes nothing', async () => {
    const response = await fetch(`${running.url}/api/settings`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: 1,
      rev: 0,
      updatedAt: '1970-01-01T00:00:00.000Z',
      data: {},
    });
    expect(existsSync(file())).toBe(false);
  });

  test('is refused for a foreign Origin like every other route', async () => {
    const response = await fetch(`${running.url}/api/settings`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('forbidden_origin');
  });
});

describe('PUT /api/settings', () => {
  test('merges namespaces, bumps rev and writes the file atomically with mode 0600', async () => {
    const first = await put({
      data: { keymap: { 'cmd+k': 'palette' }, settings: { theme: 'dark' } },
    });
    expect(first.status).toBe(200);
    const doc1 = (await first.json()) as SettingsDocument;
    expect(doc1.rev).toBe(1);
    expect(doc1.data).toEqual({ keymap: { 'cmd+k': 'palette' }, settings: { theme: 'dark' } });

    const second = await put({
      baseRev: 1,
      data: { settings: { theme: 'light' }, palette: ['a'] },
    });
    const doc2 = (await second.json()) as SettingsDocument;
    expect(doc2.rev).toBe(2);
    expect(doc2.data).toEqual({
      keymap: { 'cmd+k': 'palette' },
      settings: { theme: 'light' },
      palette: ['a'],
    });

    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual(doc2);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(await readDocument()).toEqual(doc2);
  });

  test('null deletes a namespace; deleting an absent one and re-putting equal data do not bump rev', async () => {
    await put({ data: { a: 1, b: 2 } });
    const deleted = (await (await put({ data: { a: null } })).json()) as SettingsDocument;
    expect(deleted.rev).toBe(2);
    expect(deleted.data).toEqual({ b: 2 });
    const noop = (await (await put({ data: { a: null, b: 2 } })).json()) as SettingsDocument;
    expect(noop.rev).toBe(2);
  });

  test('deleting an inherited-looking name that is absent does not bump rev', async () => {
    const doc = (await (await put({ data: { constructor: null } })).json()) as SettingsDocument;
    expect(doc.rev).toBe(0);
    expect(existsSync(file())).toBe(false);
  });

  test('stale baseRev -> 409 rev_conflict with the current document, nothing written', async () => {
    await put({ data: { a: 1 } });
    const response = await put({ baseRev: 0, data: { a: 2 } });
    expect(response.status).toBe(409);
    const body = (await response.json()) as SettingsRevConflictBody;
    expect(body.error.code).toBe('rev_conflict');
    expect(body.currentRev).toBe(1);
    expect(body.settings.data).toEqual({ a: 1 });
    expect(JSON.parse(readFileSync(file(), 'utf8')).data).toEqual({ a: 1 });
  });

  test.each([
    ['not JSON', '{nope', 'invalid_json'],
    ['bad namespace name', { data: { 'Bad Name': 1 } }, 'invalid_body'],
    ['namespace starting with a digit', { data: { '1x': 1 } }, 'invalid_body'],
    ['missing data', { baseRev: 0 }, 'invalid_body'],
    ['unknown top-level key', { data: {}, extra: 1 }, 'invalid_body'],
    ['negative baseRev', { baseRev: -1, data: {} }, 'invalid_body'],
    ['fractional baseRev', { baseRev: 1.5, data: {} }, 'invalid_body'],
    ['too deep value', { data: { deep: nested(17) } }, 'invalid_body'],
    ['array body', [], 'invalid_body'],
  ])('%s -> 400 %s', async (_name, body, code) => {
    const response = await put(body);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe(code);
    expect(existsSync(file())).toBe(false);
  });

  test('depth 16 is accepted', async () => {
    expect((await put({ data: { deep: nested(16) } })).status).toBe(200);
  });

  test('more than 64 namespaces -> 400', async () => {
    const data: Record<string, number> = {};
    for (let i = 0; i < 65; i++) data[`ns${i}`] = i;
    const response = await put({ data });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_body');
  });

  test('64 namespaces are accepted', async () => {
    const data: Record<string, number> = {};
    for (let i = 0; i < 64; i++) data[`ns${i}`] = i;
    expect((await put({ data })).status).toBe(200);
  });

  test('body above the cap -> 413 payload_too_large', async () => {
    const response = await put({ data: { big: 'x'.repeat(SETTINGS_MAX_BYTES + 1) } });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('payload_too_large');
    expect(existsSync(file())).toBe(false);
  });

  test('a document that grows past the cap through merging -> 413', async () => {
    const chunk = 'y'.repeat(100 * 1024);
    expect((await put({ data: { a: chunk, b: chunk } })).status).toBe(200);
    const response = await put({ data: { c: chunk } });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe('payload_too_large');
    expect(Object.keys((await readDocument()).data).sort()).toEqual(['a', 'b']);
  });

  test('concurrent PUTs are serialized: every one lands and revs are consecutive', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => put({ data: { [`ns${i}`]: i } })),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const docs = (await Promise.all(responses.map((r) => r.json()))) as SettingsDocument[];
    expect(docs.map((doc) => doc.rev).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    const got = await readDocument();
    expect(got.rev).toBe(20);
    expect(Object.keys(got.data)).toHaveLength(20);
  });

  test('concurrent PUTs with the same baseRev: exactly one wins, the rest get 409', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => put({ baseRev: 0, data: { [`ns${i}`]: i } })),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409, 409]);
  });
});

describe('persistence and recovery', () => {
  test('a restarted daemon serves what was written', async () => {
    await put({ data: { keymap: { a: 'b' } } });
    await running.stop();
    running = await boot();
    const doc = await readDocument();
    expect(doc.rev).toBe(1);
    expect(doc.data).toEqual({ keymap: { a: 'b' } });
  });

  test.each([
    ['invalid JSON', '{not json'],
    [
      'wrong schema version',
      JSON.stringify({ schema: 2, rev: 1, updatedAt: '2026-01-01T00:00:00Z', data: {} }),
    ],
    [
      'bad namespace on disk',
      JSON.stringify({ schema: 1, rev: 1, updatedAt: '2026-01-01T00:00:00Z', data: { 'X!': 1 } }),
    ],
  ])('corrupt file (%s) is kept aside and defaults are served', async (_name, content) => {
    await running.stop();
    writeFileSync(file(), content);
    running = await boot();
    const doc = await readDocument();
    expect(doc.rev).toBe(0);
    expect(doc.data).toEqual({});
    const aside = readdirSync(home).filter((name) => name.startsWith('settings.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(home, aside[0] ?? ''), 'utf8')).toBe(content);
    const next = (await (await put({ data: { a: 1 } })).json()) as SettingsDocument;
    expect(next.rev).toBe(1);
  });
});

describe('GET /api/settings/events', () => {
  test('announces the current rev, then every accepted write', async () => {
    const controller = new AbortController();
    const response = await fetch(`${running.url}/api/settings/events`, {
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no stream body');
    const decoder = new TextDecoder();
    let text = '';
    const waitFor = async (needle: string): Promise<void> => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        text += decoder.decode(value);
      }
    };
    await waitFor('event: settings\ndata: {"rev":0}');
    await put({ data: { a: 1 } });
    await waitFor('event: settings\ndata: {"rev":1}');
    controller.abort();
  });
});
