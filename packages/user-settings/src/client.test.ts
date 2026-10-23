import { afterEach, describe, expect, jest, test } from 'bun:test';
import type { JsonValue } from '@hsw-editor/core';
import { createSettingsClient, SETTINGS_MIRROR_KEY, type SettingsStorage } from './client.ts';
import {
  applySettingsPut,
  defaultSettingsDocument,
  type SettingsDocument,
  type SettingsPutBody,
} from './contract.ts';
import { type PutResult, SettingsRejectedError, type SettingsTransport } from './transport.ts';

afterEach(() => jest.useRealTimers());

const CLOCK = new Date('2026-10-22T00:00:00Z');

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string): string | null => this.items.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.items.set(key, value);
  removeItem = (key: string): void => void this.items.delete(key);
}

/** In-memory server with the real merge rules; `online` toggles connectivity, `puts` records every request. */
class FakeServer implements SettingsTransport {
  document: SettingsDocument = defaultSettingsDocument();
  online = true;
  gets = 0;
  puts: SettingsPutBody[] = [];
  rejectWith: SettingsRejectedError | undefined;
  /** Runs before a PUT is evaluated (to inject a concurrent write). */
  beforePut: (() => void) | undefined;
  /** Awaited inside `put` so tests can hold a request in flight. */
  gate: Promise<void> | undefined;
  /** Called as soon as a PUT reaches the server, before the gate. */
  onPutStart: (() => void) | undefined;
  /** Runs inside `get` after the document is read (to inject a local edit mid-request). */
  afterGet: (() => void) | undefined;

  get(): Promise<SettingsDocument> {
    this.gets += 1;
    if (!this.online) return Promise.reject(new Error('offline'));
    const document = this.document;
    this.afterGet?.();
    return Promise.resolve(document);
  }

  async put(body: SettingsPutBody): Promise<PutResult> {
    if (!this.online) throw new Error('offline');
    this.puts.push(body);
    this.onPutStart?.();
    if (this.gate !== undefined) await this.gate;
    if (!this.online) throw new Error('offline');
    this.beforePut?.();
    if (this.rejectWith !== undefined) throw this.rejectWith;
    if (body.baseRev !== undefined && body.baseRev !== this.document.rev) {
      return { kind: 'conflict', document: this.document };
    }
    this.document = applySettingsPut(this.document, body, CLOCK);
    return { kind: 'ok', document: this.document };
  }

  /** Another device writes. */
  remoteWrite(data: Record<string, JsonValue | null>): void {
    this.document = applySettingsPut(this.document, { data }, CLOCK);
  }
}

interface MirrorShape {
  serverRev: number | null;
  server: Record<string, JsonValue>;
  pending: Record<string, JsonValue | null>;
}

function mirrorOf(storage: MemoryStorage): MirrorShape {
  return JSON.parse(storage.items.get(SETTINGS_MIRROR_KEY) ?? 'null') as MirrorShape;
}

describe('offline-first reads', () => {
  test('reads the mirror synchronously before any network contact', () => {
    const storage = new MemoryStorage();
    createSettingsClient({ storage }).set('keymap', { 'cmd+k': 'palette' });
    const reopened = createSettingsClient({ storage, transport: new FakeServer() });
    expect(reopened.get('keymap')).toEqual({ 'cmd+k': 'palette' });
    expect(reopened.get('absent')).toBeUndefined();
    reopened.dispose();
  });

  test('a corrupt mirror is ignored', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_MIRROR_KEY, '{broken');
    expect(createSettingsClient({ storage }).get('x')).toBeUndefined();
    storage.setItem(SETTINGS_MIRROR_KEY, JSON.stringify({ schema: 9 }));
    expect(createSettingsClient({ storage }).get('x')).toBeUndefined();
  });

  test('set writes the mirror immediately', () => {
    const storage = new MemoryStorage();
    const client = createSettingsClient({
      storage,
      transport: new FakeServer(),
      debounceMs: 10_000,
    });
    client.set('settings', { theme: 'dark' });
    expect(mirrorOf(storage).pending).toEqual({ settings: { theme: 'dark' } });
    client.dispose();
  });

  test('a throwing storage does not break the client', () => {
    const storage: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    const client = createSettingsClient({ storage });
    client.set('a', 1);
    expect(client.get('a')).toBe(1);
  });
});

describe('no transport', () => {
  test('is a local store: status local, sync is a no-op', async () => {
    const client = createSettingsClient();
    client.set('a', [1, 2]);
    client.remove('b');
    expect(client.get('a')).toEqual([1, 2]);
    expect(client.status()).toBe('local');
    expect(await client.sync()).toBe('local');
    expect(await client.flush()).toBe('local');
    expect(client.serverRev()).toBeNull();
  });

  test('rejects invalid namespaces and over-deep values', () => {
    const client = createSettingsClient();
    expect(() => client.set('Bad', 1)).toThrow();
    let deep: JsonValue = 1;
    for (let i = 0; i < 17; i++) deep = [deep];
    expect(() => client.set('ok', deep)).toThrow();
  });
});

describe('pushing', () => {
  test('debounces and coalesces rapid edits into one PUT', async () => {
    const server = new FakeServer();
    jest.useFakeTimers();
    const client = createSettingsClient({ transport: server, debounceMs: 5 });
    client.set('a', 1);
    client.set('a', 2);
    client.set('b', 3);
    expect(server.puts).toHaveLength(0);
    jest.advanceTimersByTime(10);
    jest.useRealTimers();
    await client.flush(); // joins the cycle the timer already queued
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]?.data).toEqual({ a: 2, b: 3 });
    expect(server.document.data).toEqual({ a: 2, b: 3 });
    expect(client.status()).toBe('synced');
    expect(client.pendingNamespaces()).toEqual([]);
    client.dispose();
  });

  test('single in flight: an edit during a request goes out in the next one, never lost', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    let release: () => void = () => undefined;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    client.set('a', 1);
    const started = new Promise<void>((resolve) => (server.onPutStart = resolve));
    const firstFlush = client.flush();
    await started;
    client.set('a', 2);
    const secondFlush = client.flush();
    expect(server.puts).toHaveLength(1);
    server.gate = undefined;
    release();
    await Promise.all([firstFlush, secondFlush]);
    expect(server.puts).toHaveLength(2);
    expect(server.document.data).toEqual({ a: 2 });
    expect(client.pendingNamespaces()).toEqual([]);
    client.dispose();
  });

  test('an edit equal to the server value is dropped on reconcile without bumping rev', async () => {
    const server = new FakeServer();
    server.remoteWrite({ a: 1 });
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    client.set('a', 5);
    client.set('a', 1);
    const rev = server.document.rev;
    await client.sync();
    expect(server.puts).toHaveLength(0);
    expect(server.document.rev).toBe(rev);
    expect(client.pendingNamespaces()).toEqual([]);
    client.dispose();
  });

  test('reverting to a stale mirrored value while offline keeps the edit (last explicit choice wins)', async () => {
    const server = new FakeServer();
    server.remoteWrite({ theme: 'dark' });
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    server.online = false;
    server.document = applySettingsPut(server.document, { data: { theme: 'light' } }, CLOCK);
    client.set('theme', 'light');
    client.set('theme', 'dark');
    expect(client.pendingNamespaces()).toEqual(['theme']);
    server.online = true;
    await client.sync();
    expect(client.get('theme')).toBe('dark');
    expect(server.document.data['theme']).toBe('dark');
    client.dispose();
  });

  test('remove deletes the namespace on the server', async () => {
    const server = new FakeServer();
    server.remoteWrite({ a: 1, b: 2 });
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    client.remove('a');
    expect(client.get('a')).toBeUndefined();
    await client.flush();
    expect(server.document.data).toEqual({ b: 2 });
    client.dispose();
  });
});

describe('offline then reconnect', () => {
  test('offline edit stays pending, survives a reload, and is pushed after reconnect', async () => {
    const storage = new MemoryStorage();
    const server = new FakeServer();
    server.remoteWrite({ keymap: { old: 1 }, palette: ['x'] });
    server.online = false;
    const client = createSettingsClient({ transport: server, storage, debounceMs: 10_000 });
    client.set('keymap', { mine: 1 });
    expect(await client.flush()).toBe('offline');
    expect(client.status()).toBe('offline');
    expect(client.pendingNamespaces()).toEqual(['keymap']);
    client.dispose();

    const reloaded = createSettingsClient({ transport: server, storage, debounceMs: 10_000 });
    expect(reloaded.get('keymap')).toEqual({ mine: 1 });
    server.online = true;
    expect(await reloaded.sync()).toBe('synced');
    expect(server.document.data).toEqual({ keymap: { mine: 1 }, palette: ['x'] });
    expect(reloaded.get('palette')).toEqual(['x']);
    expect(mirrorOf(storage).pending).toEqual({});
    reloaded.dispose();
  });

  test('reconnect adopts newer server namespaces but keeps pending ones (stale data never clobbers)', async () => {
    const server = new FakeServer();
    server.remoteWrite({ keymap: { v: 1 }, settings: { theme: 'light' } });
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    server.online = false;
    client.set('keymap', { v: 'local-edit' });
    await client.flush();

    server.online = true;
    server.remoteWrite({
      keymap: { v: 'other-device' },
      settings: { theme: 'dark' },
      palette: ['new'],
    });
    await client.sync();

    expect(server.puts.at(-1)?.baseRev).toBe(server.document.rev - 1);
    expect(client.get('keymap')).toEqual({ v: 'local-edit' });
    expect(client.get('settings')).toEqual({ theme: 'dark' });
    expect(client.get('palette')).toEqual(['new']);
    expect(server.document.data['keymap']).toEqual({ v: 'local-edit' });
    expect(server.document.data['settings']).toEqual({ theme: 'dark' });
    client.dispose();
  });

  test('an edit made while the GET is in flight survives the stale document', async () => {
    const server = new FakeServer();
    server.remoteWrite({ a: 'server' });
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    server.afterGet = () => client.set('a', 'local');
    await client.sync();
    expect(client.get('a')).toBe('local');
    expect(server.document.data['a']).toBe('local');
    client.dispose();
  });

  test('sync with unreachable server resolves offline and keeps the mirror', async () => {
    const server = new FakeServer();
    server.online = false;
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    client.set('a', 1);
    expect(await client.sync()).toBe('offline');
    expect(client.get('a')).toBe(1);
    expect(client.serverRev()).toBeNull();
    client.dispose();
  });
});

describe('409 handling', () => {
  test('refetches and retries once with the new baseRev', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    client.set('mine', 1);
    server.beforePut = () => {
      server.beforePut = undefined;
      server.remoteWrite({ theirs: 2 });
    };
    expect(await client.flush()).toBe('synced');
    expect(server.puts.map((put) => put.baseRev)).toEqual([0, 1]);
    expect(server.document.data).toEqual({ theirs: 2, mine: 1 });
    expect(client.get('theirs')).toBe(2);
    client.dispose();
  });

  test('two conflicts in a row leave the edit pending (status conflict) for the next sync', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    client.set('mine', 1);
    let writes = 0;
    server.beforePut = () => server.remoteWrite({ [`other${writes++}`]: 1 });
    expect(await client.flush()).toBe('conflict');
    expect(client.pendingNamespaces()).toEqual(['mine']);
    server.beforePut = undefined;
    expect(await client.sync()).toBe('synced');
    expect(server.document.data['mine']).toBe(1);
    client.dispose();
  });
});

describe('permanent rejection', () => {
  test('drops the refused patch, adopts the server value and reports it', async () => {
    const server = new FakeServer();
    server.remoteWrite({ a: 'good' });
    const rejected: string[] = [];
    const client = createSettingsClient({
      transport: server,
      debounceMs: 10_000,
      onRejected: (error) => rejected.push(error.code),
    });
    await client.sync();
    client.set('a', 'too-big');
    server.rejectWith = new SettingsRejectedError(413, 'payload_too_large', 'too large');
    expect(await client.flush()).toBe('rejected');
    expect(rejected).toEqual(['payload_too_large']);
    expect(client.pendingNamespaces()).toEqual([]);
    expect(client.get('a')).toBe('good');
    client.dispose();
  });
});

describe('subscriptions and remote notifications', () => {
  test('per-namespace listeners fire only for their namespace and only on real changes', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    const keymap: Array<JsonValue | undefined> = [];
    const settings: Array<JsonValue | undefined> = [];
    const stop = client.subscribe('keymap', (value) => keymap.push(value));
    client.subscribe('settings', (value) => settings.push(value));

    client.set('keymap', { a: 1 });
    client.set('keymap', { a: 1 });
    expect(keymap).toEqual([{ a: 1 }]);
    expect(settings).toEqual([]);

    server.remoteWrite({ settings: { theme: 'dark' } });
    await client.sync();
    expect(settings).toEqual([{ theme: 'dark' }]);
    expect(keymap).toEqual([{ a: 1 }]);

    stop();
    client.set('keymap', { a: 2 });
    expect(keymap).toEqual([{ a: 1 }]);
    client.dispose();
  });

  test('onChange reports changed namespaces', () => {
    const seen: string[][] = [];
    const client = createSettingsClient({ onChange: (names) => seen.push([...names]) });
    client.set('a', 1);
    client.set('b', 2);
    client.remove('a');
    expect(seen).toEqual([['a'], ['b'], ['a']]);
  });

  test('notifyServerRev only reconciles when the server is ahead', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    const gets = server.gets;
    await client.notifyServerRev(0);
    expect(server.gets).toBe(gets);
    server.remoteWrite({ fresh: true });
    await client.notifyServerRev(1);
    expect(server.gets).toBe(gets + 1);
    expect(client.get('fresh')).toBe(true);
    client.dispose();
  });

  test('lastSyncedAt uses the injected clock', async () => {
    const client = createSettingsClient({
      transport: new FakeServer(),
      now: () => new Date('2026-10-22T12:00:00Z'),
      debounceMs: 10_000,
    });
    expect(client.lastSyncedAt()).toBeNull();
    await client.sync();
    expect(client.lastSyncedAt()).toBe('2026-10-22T12:00:00.000Z');
    client.dispose();
  });
});

describe('review regressions', () => {
  test('get never returns inherited Object properties', () => {
    const client = createSettingsClient();
    expect(client.get('constructor')).toBeUndefined();
    expect(client.get('toString')).toBeUndefined();
  });

  test('a throwing listener neither wedges sync nor starves other listeners', async () => {
    const server = new FakeServer();
    server.remoteWrite({ a: 1 });
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    const seen: Array<JsonValue | undefined> = [];
    client.subscribe('a', () => {
      throw new Error('listener bug');
    });
    client.subscribe('a', (value) => seen.push(value));
    expect(await client.sync()).toBe('synced');
    expect(seen).toEqual([1]);
    client.set('b', 2);
    expect(await client.flush()).toBe('synced');
    expect(server.document.data['b']).toBe(2);
    client.dispose();
  });

  test('remove() while a push of the same namespace is in flight is not lost', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    let release: () => void = () => undefined;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (server.onPutStart = resolve));
    client.set('a', 1);
    const first = client.flush();
    await started;
    client.remove('a');
    expect(client.pendingNamespaces()).toEqual(['a']);
    server.gate = undefined;
    release();
    await first;
    await client.flush();
    expect(client.get('a')).toBeUndefined();
    expect(server.document.data).toEqual({});
    client.dispose();
  });

  test('one refused namespace does not drop the valid ones sent with it', async () => {
    const server = new FakeServer();
    const rejected: string[] = [];
    const refuse = new SettingsRejectedError(413, 'payload_too_large', 'too large');
    const original = server.put.bind(server);
    server.put = (body) =>
      Object.hasOwn(body.data, 'huge') ? Promise.reject(refuse) : original(body);
    const withHandler = createSettingsClient({
      transport: server,
      debounceMs: 10_000,
      onRejected: (error) => rejected.push(error.code),
    });
    withHandler.set('keymap', { a: 1 });
    withHandler.set('huge', 'x');
    await withHandler.flush();
    expect(rejected).toEqual(['payload_too_large']);
    expect(server.document.data).toEqual({ keymap: { a: 1 } });
    expect(withHandler.get('huge')).toBeUndefined();
    withHandler.dispose();
  });

  test('an SSE announcement of our own rev does not trigger a refetch, a foreign one does', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    client.set('a', 1);
    await client.flush();
    const gets = server.gets;
    await client.notifyServerRev(server.document.rev);
    expect(server.gets).toBe(gets);
    server.remoteWrite({ b: 2 });
    await client.notifyServerRev(server.document.rev);
    expect(client.get('b')).toBe(2);
    client.dispose();
  });

  test('notifyServerRev retries pending edits after a failed push even if the rev is unchanged', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    server.online = false;
    client.set('a', 1);
    expect(await client.flush()).toBe('offline');
    server.online = true;
    await client.notifyServerRev(server.document.rev);
    expect(server.document.data).toEqual({ a: 1 });
    client.dispose();
  });

  test('notifyServerRev refetches when the server rev went backwards (reset or restored file)', async () => {
    const server = new FakeServer();
    server.remoteWrite({ keymap: { x: 1 } });
    server.remoteWrite({ palette: ['a'] });
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    expect(client.serverRev()).toBe(2);
    server.document = defaultSettingsDocument();
    await client.notifyServerRev(0);
    expect(client.serverRev()).toBe(0);
    expect(client.get('keymap')).toBeUndefined();
    client.dispose();
  });

  test('an announcement during an in-flight PUT that is then refused is still fetched', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    let release: () => void = () => undefined;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (server.onPutStart = resolve));
    server.rejectWith = new SettingsRejectedError(400, 'invalid_body', 'bad');
    client.set('mine', 1);
    const flushing = client.flush();
    await started;
    server.remoteWrite({ theirs: 2 });
    const notified = client.notifyServerRev(server.document.rev);
    server.gate = undefined;
    release();
    await Promise.all([flushing, notified]);
    await client.flush(); // joins the refetch cycle finish() queued; never fetches on its own
    expect(client.get('theirs')).toBe(2);
    client.dispose();
  });

  test('a parked announcement is dropped once a later fetch has covered it', async () => {
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, debounceMs: 10_000 });
    await client.sync();
    let release: () => void = () => undefined;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (server.onPutStart = resolve));
    client.set('mine', 1);
    const flushing = client.flush();
    await started;
    void client.notifyServerRev(5);
    server.online = false;
    server.gate = undefined;
    release();
    expect(await flushing).toBe('offline');
    server.online = true;
    server.remoteWrite({ a: 1 });
    server.remoteWrite({ b: 1 });
    await client.sync();
    const gets = server.gets;
    await client.flush();
    expect(server.gets).toBe(gets);
    client.dispose();
  });

  test('status is unsynced before first contact with a transport', () => {
    const client = createSettingsClient({ transport: new FakeServer(), debounceMs: 10_000 });
    expect(client.status()).toBe('unsynced');
    client.dispose();
  });

  test('a disposed client no longer persists or syncs', async () => {
    const storage = new MemoryStorage();
    const server = new FakeServer();
    const client = createSettingsClient({ transport: server, storage, debounceMs: 10_000 });
    client.dispose();
    client.set('a', 1);
    expect(storage.items.size).toBe(0);
    await client.sync();
    expect(server.gets).toBe(0);
  });
});
