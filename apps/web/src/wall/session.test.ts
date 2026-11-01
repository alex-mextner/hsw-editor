/** The first edit of a template wall clones it: against a fake daemon, through the real session and sync. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { applyOp, createEmptyWall, type Op, type Wall, type WallItem } from '@hsw-editor/core';
import { localeStore } from '@/i18n/index.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { installFetch, restoreFetch } from '@/test/fetchStub.ts';
import { closeWall, openWall, redoEdit, sessionStore, submitOps, undoEdit } from './session.ts';

function holder(id: string, col: number): WallItem {
  return {
    id,
    kind: 'holder',
    bankId: 'hook',
    cell: { col, row: 1 },
    pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

interface Stored {
  wall: Wall;
  template: boolean;
}

const notFound = (): Response =>
  Response.json({ error: { code: 'wall_not_found', message: 'no' } }, { status: 404 });

function readWall(stored: Stored | undefined): Response {
  if (!stored) return notFound();
  return Response.json({
    wall: stored.wall,
    canUndo: false,
    canRedo: false,
    warnings: [],
    ...(stored.template ? { template: true } : {}),
  });
}

function cloneWall(walls: Map<string, Stored>, sourceId: string, init: RequestInit | undefined) {
  const source = walls.get(sourceId);
  const body = JSON.parse(String(init?.body)) as { id: string; name: string };
  if (!source) return notFound();
  const copy: Wall = { ...source.wall, id: body.id, name: body.name, rev: 0 };
  walls.set(body.id, { wall: copy, template: false });
  return Response.json(
    { wall: copy, canUndo: false, canRedo: false, warnings: [] },
    { status: 201 },
  );
}

function applyWallOps(stored: Stored | undefined, init: RequestInit | undefined): Response {
  const body = JSON.parse(String(init?.body)) as { ops: Op[] };
  if (!stored) return notFound();
  const [op] = body.ops;
  if (!op) throw new Error('no op');
  const result = applyOp(stored.wall, op);
  stored.wall = result.wall;
  return Response.json({
    rev: result.wall.rev,
    changed: result.changed,
    op,
    inverse: result.inverse,
    wall: result.wall,
    warnings: [],
    canUndo: true,
    canRedo: false,
  });
}

/** The slice of the daemon the session uses: wall reads, clone and ops. */
function fakeDaemon(walls: Map<string, Stored>, log: string[]) {
  return (url: string, init: RequestInit | undefined): Response => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    log.push(`${method} ${path}`);
    const [, id, action] = /^\/api\/walls\/([^/]+)(?:\/(clone|ops))?$/.exec(path) ?? [];
    if (id === undefined)
      return Response.json({ error: { code: 'not_found', message: path } }, { status: 404 });
    if (action === undefined && method === 'GET') return readWall(walls.get(id));
    if (action === 'clone' && method === 'POST') return cloneWall(walls, id, init);
    if (action === 'ops' && method === 'POST') return applyWallOps(walls.get(id), init);
    return Response.json({ error: { code: 'not_found', message: path } }, { status: 404 });
  };
}

class QuietEventSource {
  static readonly urls: string[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    QuietEventSource.urls.push(url);
  }
  addEventListener(): void {}
  close(): void {}
}

const realEventSource = globalThis.EventSource;
const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
/** A device's storage that outlives a page: what a reload keeps. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}
let walls: Map<string, Stored>;
let log: string[];

async function until(done: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !done(); tries += 1) await Bun.sleep(1);
  expect(done()).toBe(true);
}

beforeEach(() => {
  localeStore.set('en');
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  QuietEventSource.urls.length = 0;
  Reflect.set(globalThis, 'EventSource', QuietEventSource);
  walls = new Map([
    [
      'showcase',
      {
        wall: { ...createEmptyWall('showcase', 'Showcase'), items: [holder('h1', 1)] },
        template: true,
      },
    ],
    ['garage', { wall: createEmptyWall('garage', 'Garage'), template: false }],
  ]);
  log = [];
  installFetch(fakeDaemon(walls, log));
});

afterEach(() => {
  closeWall();
  restoreFetch();
  Reflect.set(globalThis, 'EventSource', realEventSource);
  if (realStorage) Object.defineProperty(globalThis, 'localStorage', realStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
  currentWallId.set(null);
});

const addHolder: Op = { type: 'addItem', item: holder('h2', 5) };

describe('first edit of a template wall', () => {
  test('clones the wall, switches to the copy and applies the edit there; the template is untouched', async () => {
    openWall('showcase');
    await until(() => sessionStore.get()?.status === 'ready');

    expect(submitOps([addHolder])).toEqual({ ok: true });
    const open = sessionStore.get();
    expect(open?.wallId).not.toBe('showcase');
    expect(open?.wall?.name).toBe('Showcase (copy)');
    expect(open?.wall?.items.map((item) => item.id)).toEqual(['h1', 'h2']);
    expect(currentWallId.get()).toBe(open?.wallId ?? null);

    await until(() => open !== null && walls.get(open.wallId)?.wall.items.length === 2);
    const cloneId = open?.wallId ?? '';
    expect(log.filter((entry) => entry.includes('/clone'))).toEqual([
      'POST /api/walls/showcase/clone',
    ]);
    expect(log.indexOf('POST /api/walls/showcase/clone')).toBeLessThan(
      log.indexOf(`POST /api/walls/${cloneId}/ops`),
    );
    expect(walls.get('showcase')?.wall.items.map((item) => item.id)).toEqual(['h1']);
    // The event stream of the copy opens once the copy exists.
    await until(() => QuietEventSource.urls.some((url) => url.includes(cloneId)));
  });

  test('a second edit stays on the copy', async () => {
    openWall('showcase');
    await until(() => sessionStore.get()?.status === 'ready');
    submitOps([addHolder]);
    const first = sessionStore.get()?.wallId;
    submitOps([{ type: 'addItem', item: holder('h3', 7) }]);
    expect(sessionStore.get()?.wallId).toBe(first ?? '');
    await until(() => log.some((entry) => entry.includes('/ops')));
    expect(log.filter((entry) => entry.includes('/clone'))).toHaveLength(1);
  });

  test('an ordinary wall is edited in place', async () => {
    openWall('garage');
    await until(() => sessionStore.get()?.status === 'ready');
    submitOps([addHolder]);
    expect(sessionStore.get()?.wallId).toBe('garage');
    expect(log.some((entry) => entry.includes('/clone'))).toBe(false);
  });

  test('an edit that changes nothing, or is refused, stays on the template', async () => {
    openWall('showcase');
    await until(() => sessionStore.get()?.status === 'ready');
    expect(submitOps([{ type: 'removeItem', id: 'nothing-here' }]).ok).toBe(false);
    expect(submitOps([])).toEqual({ ok: true });
    expect(sessionStore.get()?.wallId).toBe('showcase');
    expect(log.some((entry) => entry.includes('/clone'))).toBe(false);
  });

  test('a long wall name still fits the daemon limit after the copy suffix', async () => {
    const name = 'n'.repeat(200);
    walls.set('long', { wall: { ...createEmptyWall('long', name), items: [] }, template: true });
    openWall('long');
    await until(() => sessionStore.get()?.status === 'ready');
    submitOps([addHolder]);
    expect(sessionStore.get()?.wall?.name.length).toBeLessThanOrEqual(200);
  });

  test('a copy whose creation failed is made again when it is reopened, not shown as deleted', async () => {
    let failClone = true;
    installFetch((url, init) => {
      if (failClone && url.endsWith('/clone')) throw new TypeError('network down');
      return fakeDaemon(walls, log)(url, init);
    });
    openWall('showcase');
    await until(() => sessionStore.get()?.status === 'ready');
    submitOps([addHolder]);
    const copyId = sessionStore.get()?.wallId ?? '';
    await Bun.sleep(30);
    expect(walls.has(copyId)).toBe(false);

    // Reload: the copy is opened by id with the service not knowing it yet.
    closeWall();
    failClone = false;
    openWall(copyId);
    await until(() => walls.has(copyId));
    await until(() => sessionStore.get()?.status === 'ready');
    expect(sessionStore.get()?.status).toBe('ready');
    expect(walls.get(copyId)?.wall.items.map((item) => item.id)).toContain('h1');
    // The event stream of a recovered copy opens after its saved edits are back.
    await until(() => QuietEventSource.urls.some((url) => url.includes(copyId)));
  });

  test('undo and redo never reach the template: nothing is sent for it', async () => {
    openWall('showcase');
    await until(() => sessionStore.get()?.status === 'ready');
    undoEdit();
    redoEdit();
    await Bun.sleep(20);
    expect(log.some((entry) => entry.endsWith('/undo') || entry.endsWith('/redo'))).toBe(false);
    expect(sessionStore.get()?.canUndo).toBe(false);
  });
});
