import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Actor, type NewInputRequest, type Op, parseOp } from '@hsw-editor/core';
import { type StoreHooks, StoreError, WallStore } from './wall-store.ts';

const human: Actor = { kind: 'human', name: 'tester' };
const agent: Actor = { kind: 'agent', name: 'omp' };

function addHolder(id: string, col: number, row: number): Op {
  return parseOp({
    type: 'addItem',
    item: { id, kind: 'holder', bankId: 'hook', cell: { col, row } },
  });
}

let home: string;
const opened: WallStore[] = [];

async function openStore(hooks?: StoreHooks): Promise<WallStore> {
  const store = new WallStore({ home, ...(hooks ? { hooks } : {}) });
  await store.init();
  opened.push(store);
  return store;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hsw-store-'));
});

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  await rm(home, { recursive: true, force: true });
});

const wallPath = (id: string, file: string): string => join(home, 'walls', id, file);

describe('history, undo and redo', () => {
  test('every op is attributed and undo/redo walk the linear stack', async () => {
    const store = await openStore();
    const { wall } = await store.create({ name: 'Garage', id: 'g' }, human);
    expect(wall.rev).toBe(0);

    await store.apply('g', { ops: [addHolder('a', 1, 1)], actor: human });
    await store.apply('g', { ops: [addHolder('b', 2, 2)], actor: agent });
    const afterTwo = (await store.get('g')).wall;
    expect(afterTwo.items.map((item) => item.id)).toEqual(['a', 'b']);

    const undone = await store.undo('g', { actor: human });
    expect(undone.wall.items.map((item) => item.id)).toEqual(['a']);
    expect(undone.canRedo).toBe(true);
    expect(undone.wall.rev).toBe(3); // undo is a new rev, history only grows
    const redone = await store.redo('g', { actor: human });
    expect(redone.wall.items.map((item) => item.id)).toEqual(['a', 'b']);

    // a new op clears the redo stack
    await store.undo('g', { actor: human });
    await store.apply('g', { ops: [addHolder('c', 3, 3)], actor: human });
    await expect(store.redo('g', { actor: human })).rejects.toMatchObject({
      code: 'nothing_to_redo',
    });

    const history = await store.history('g', -1, 100);
    expect(history.map((entry) => `${entry.kind}:${entry.rev}`)).toEqual([
      'create:0',
      'op:1',
      'op:2',
      'undo:3',
      'redo:4',
      'undo:5',
      'op:6',
    ]);
    expect(history[2]?.actor).toEqual(agent);
    await expect(
      (async () => {
        const fresh = await store.get('g');
        let current = fresh;
        while (current.canUndo) {
          await store.undo('g', { actor: human });
          current = await store.get('g');
        }
        return current.wall.items;
      })(),
    ).resolves.toEqual([]);
    await expect(store.undo('g', { actor: human })).rejects.toMatchObject({
      code: 'nothing_to_undo',
    });
  });

  test('undo/redo survive a restart', async () => {
    const first = await openStore();
    await first.create({ name: 'Garage', id: 'g' }, human);
    await first.apply('g', { ops: [addHolder('a', 1, 1)], actor: human });
    await first.apply('g', { ops: [addHolder('b', 2, 2)], actor: human });
    await first.undo('g', { actor: human });
    await first.close();

    const second = await openStore();
    const state = await second.get('g');
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(true);
    expect((await second.redo('g', { actor: human })).wall.items.map((i) => i.id)).toEqual([
      'a',
      'b',
    ]);
  });

  test('a locked item refuses edits through the store until the lock is undone', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    await store.apply('g', { ops: [addHolder('a', 1, 1)], actor: human });
    await store.apply('g', {
      ops: [parseOp({ type: 'lock', id: 'a', locked: true })],
      actor: agent,
    });
    const move = parseOp({ type: 'moveItem', id: 'a', to: { cell: { col: 5, row: 5 } } });
    await expect(store.apply('g', { ops: [move], actor: human })).rejects.toMatchObject({
      code: 'item_locked',
    });
    await store.undo('g', { actor: human }); // undoes the lock
    expect((await store.apply('g', { ops: [move], actor: human })).changed).toBe(true);
  });
});

describe('optimistic concurrency', () => {
  test('a stale baseRev is rejected with the current wall and applies nothing', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    const first = await store.apply('g', { ops: [addHolder('a', 1, 1)], baseRev: 0, actor: human });
    expect(first.wall.rev).toBe(1);
    const error = await store
      .apply('g', { ops: [addHolder('b', 2, 2)], baseRev: 0, actor: agent })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'rev_conflict' });
    expect(error).toBeInstanceOf(StoreError);
    const conflictWall = error instanceof StoreError ? error.wall : undefined;
    expect(conflictWall?.rev).toBe(1);
    expect(conflictWall?.items.map((item) => item.id)).toEqual(['a']);
    expect((await store.get('g')).wall.items).toHaveLength(1);
    // rebasing on the returned rev works
    await store.apply('g', { ops: [addHolder('b', 2, 2)], baseRev: 1, actor: agent });
    expect((await store.get('g')).wall.rev).toBe(2);
  });

  test('concurrent requests are serialised: exactly one of two same-base writers wins', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    const results = await Promise.allSettled([
      store.apply('g', { ops: [addHolder('a', 1, 1)], baseRev: 0, actor: human }),
      store.apply('g', { ops: [addHolder('b', 2, 2)], baseRev: 0, actor: agent }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await store.get('g')).wall.rev).toBe(1);
  });

  test('a batch request is one rev and atomic', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    await expect(
      store.apply('g', {
        ops: [addHolder('a', 1, 1), parseOp({ type: 'removeItem', id: 'missing' })],
        actor: human,
      }),
    ).rejects.toMatchObject({ code: 'item_not_found', opIndex: 1 });
    expect((await store.get('g')).wall.rev).toBe(0);
    const ok = await store.apply('g', {
      ops: [addHolder('a', 1, 1), addHolder('b', 2, 2)],
      actor: human,
    });
    expect(ok.wall.rev).toBe(1);
    await store.undo('g', { actor: human });
    expect((await store.get('g')).wall.items).toEqual([]); // one undo reverts the whole request
  });

  test('a no-op writes nothing', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    const result = await store.apply('g', {
      ops: [parseOp({ type: 'rename', name: 'Garage' })],
      actor: human,
    });
    expect(result.changed).toBe(false);
    expect(await store.history('g', -1, 10)).toHaveLength(1);
  });
});

describe('crash safety', () => {
  const FAIL = new Error('simulated crash');

  test('a crash between history append and wall.json rename loses nothing', async () => {
    let crash = false;
    let onDiskAtCrash = '';
    let tmpFilesAtCrash: string[] = [];
    const store = await openStore({
      beforeWallRename: async () => {
        if (!crash) return;
        // the instant before the rename: this is what a dead process would leave behind
        onDiskAtCrash = await readFile(wallPath('g', 'wall.json'), 'utf8');
        tmpFilesAtCrash = (await readdir(join(home, 'walls', 'g'))).filter((name) =>
          name.includes('.tmp-'),
        );
        throw FAIL;
      },
    });
    await store.create({ name: 'Garage', id: 'g' }, human);
    await store.apply('g', { ops: [addHolder('a', 1, 1)], actor: human });
    const snapshotBefore = await readFile(wallPath('g', 'wall.json'), 'utf8');

    crash = true;
    await expect(store.apply('g', { ops: [addHolder('b', 2, 2)], actor: human })).rejects.toBe(
      FAIL,
    );
    // at the crash point wall.json was still the old, complete document (the new one sat in a temp file)
    expect(onDiskAtCrash).toBe(snapshotBefore);
    expect(tmpFilesAtCrash).toHaveLength(1);
    await store.close();
    // emulate the dead process: stale snapshot + leftover temp file, history already has the entry
    await writeFile(wallPath('g', 'wall.json'), onDiskAtCrash);
    await writeFile(wallPath('g', 'wall.json.tmp-9-9'), '{"half":');

    const restarted = await openStore();
    const state = await restarted.get('g');
    expect(state.wall.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(state.wall.rev).toBe(2);
    expect(JSON.parse(await readFile(wallPath('g', 'wall.json'), 'utf8')).rev).toBe(2); // repaired
    expect(await readdir(join(home, 'walls', 'g'))).not.toContain('wall.json.tmp-9-9');
    expect((await restarted.undo('g', { actor: human })).wall.items.map((i) => i.id)).toEqual([
      'a',
    ]);
  });

  test('a live store recovers from an io failure and keeps serving consistent state', async () => {
    let crash = true;
    const store = await openStore({
      beforeWallRename: () => {
        if (crash) throw FAIL;
      },
    });
    await store.create({ name: 'Garage', id: 'g' }, human);
    const seen: number[] = [];
    await store.subscribe('g', 0, {
      onRequest: () => undefined,
      onResume: () => undefined,
      onEntry: (entry) => seen.push(entry.rev),
      onDeleted: () => undefined,
    });
    await expect(store.apply('g', { ops: [addHolder('a', 1, 1)], actor: human })).rejects.toBe(
      FAIL,
    );
    crash = false;
    // memory was rebuilt from disk: the op is part of the wall, listeners were told
    expect((await store.get('g')).wall.rev).toBe(1);
    expect(seen).toEqual([1]);
    await store.apply('g', { ops: [addHolder('b', 2, 2)], actor: human });
    expect((await store.get('g')).wall.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  test('a torn last history line is dropped and truncated', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    await store.apply('g', { ops: [addHolder('a', 1, 1)], actor: human });
    await store.close();
    const history = wallPath('g', 'history.jsonl');
    await appendFile(
      history,
      '{"kind":"op","rev":2,"ts":"2026-10-22T00:00:00.000Z","actor":{"kind":"hu',
    );

    const restarted = await openStore();
    const state = await restarted.get('g');
    expect(state.wall.rev).toBe(1);
    expect((await readFile(history, 'utf8')).endsWith('\n')).toBe(true);
    expect((await readFile(history, 'utf8')).trim().split('\n')).toHaveLength(2);
    // appending after the repair yields a valid file
    await restarted.apply('g', { ops: [addHolder('b', 2, 2)], actor: human });
    await restarted.close();
    const third = await openStore();
    expect((await third.get('g')).wall.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  test('lost or corrupt wall.json is rebuilt from history; stray temp files are removed', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    await store.apply('g', { ops: [addHolder('a', 1, 1)], actor: human });
    await store.apply('g', { ops: [addHolder('b', 2, 2)], actor: human });
    await store.close();
    await writeFile(wallPath('g', 'wall.json'), '{"schemaVersion":1,"id":"g","na');
    await writeFile(wallPath('g', 'wall.json.tmp-1-1'), 'partial');

    const restarted = await openStore();
    expect((await restarted.get('g')).wall.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(await readdir(join(home, 'walls', 'g'))).not.toContain('wall.json.tmp-1-1');
    expect(JSON.parse(await readFile(wallPath('g', 'wall.json'), 'utf8')).rev).toBe(2);
  });

  test('garbage in the middle of the history is reported, not silently skipped', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    await store.apply('g', { ops: [addHolder('a', 1, 1)], actor: human });
    await store.apply('g', { ops: [addHolder('b', 2, 2)], actor: human });
    await store.close();
    const history = wallPath('g', 'history.jsonl');
    const lines = (await readFile(history, 'utf8')).split('\n');
    lines[1] = 'not json';
    await writeFile(history, lines.join('\n'));
    const restarted = await openStore();
    await expect(restarted.get('g')).rejects.toMatchObject({ code: 'corrupt' });
  });

  test('a second daemon on the same home is refused while the first is alive', async () => {
    await openStore();
    const rival = new WallStore({ home });
    await expect(rival.init()).resolves.toBeUndefined(); // same pid: the lock is ours (re-entrant for tests)
    const lockFile = join(home, 'server.lock');
    await writeFile(lockFile, `${process.ppid}\n`);
    await expect(new WallStore({ home }).init()).rejects.toMatchObject({ code: 'locked' });
  });
});

describe('subscriptions', () => {
  test('resume replays missed entries in order, then goes live without gaps', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      await store.apply('g', { ops: [addHolder(id, index + 1, 1)], actor: human });
    }
    const seen: string[] = [];
    const unsubscribe = await store.subscribe('g', 1, {
      onRequest: () => undefined,
      onResume: (resume) => {
        seen.push(
          resume.kind === 'replay'
            ? `replay:${resume.entries.map((e) => e.rev).join(',')}`
            : 'snapshot',
        );
      },
      onEntry: (entry) => seen.push(`live:${entry.rev}`),
      onDeleted: () => seen.push('deleted'),
    });
    await store.apply('g', { ops: [addHolder('d', 5, 1)], actor: agent });
    expect(seen).toEqual(['replay:2,3', 'live:4']);
    unsubscribe();
    await store.apply('g', { ops: [addHolder('e', 6, 1)], actor: agent });
    expect(seen).toEqual(['replay:2,3', 'live:4']);
  });

  test('a client ahead of the server, or one with no cursor, gets a snapshot', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    const kinds: string[] = [];
    for (const since of [undefined, 99]) {
      await store.subscribe('g', since, {
        onRequest: () => undefined,
        onResume: (resume) => kinds.push(resume.kind),
        onEntry: () => undefined,
        onDeleted: () => undefined,
      });
    }
    expect(kinds).toEqual(['snapshot', 'snapshot']);
  });

  test('deleting a wall notifies listeners and moves it to the trash', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    let deleted = false;
    await store.subscribe('g', undefined, {
      onRequest: () => undefined,
      onResume: () => undefined,
      onEntry: () => undefined,
      onDeleted: () => {
        deleted = true;
      },
    });
    const trashedTo = await store.remove('g');
    expect(deleted).toBe(true);
    expect(trashedTo).toContain('.trash');
    await expect(store.get('g')).rejects.toMatchObject({ code: 'wall_not_found' });
    expect(await store.list()).toEqual([]);
  });
});

describe('ids and assets', () => {
  test('wall ids cannot escape the walls directory', async () => {
    const store = await openStore();
    for (const id of ['..', '../x', 'a/b', '.hidden', '']) {
      await expect(store.get(id)).rejects.toMatchObject({ code: 'invalid_id' });
    }
    await store.create({ name: 'Garage', id: 'g' }, human);
    const relative = await store.addAsset('g', {
      dir: 'photos',
      ext: 'png',
      bytes: new Uint8Array([1]),
    });
    expect(store.assetPath('g', relative)).toContain(join('walls', 'g', 'photos'));
    expect(() => store.assetPath('g', '../wall.json')).toThrow();
    expect(() => store.assetPath('g', 'history.jsonl')).toThrow();
  });
});

describe('input requests', () => {
  const ask: NewInputRequest = {
    kind: 'variant',
    payload: {
      candidates: [
        { id: 'long', label: 'Long' },
        { id: 'short', label: 'Short' },
      ],
    },
  };

  test('open and resolved requests survive a restart; aborting an awaited request cancels it', async () => {
    const first = await openStore();
    await first.create({ name: 'Garage', id: 'g' }, human);
    const open = await first.createRequest('g', ask, agent);
    const done = await first.createRequest('g', ask, agent);
    await first.answerRequest('g', done.id, { picked: 'long' }, human);
    await first.close();

    const second = await openStore();
    expect((await second.listRequests('g', 'open')).map((request) => request.id)).toEqual([
      open.id,
    ]);
    expect(await second.getRequest('g', done.id)).toMatchObject({
      status: 'answered',
      answer: { picked: 'long' },
    });

    const controller = new AbortController();
    const waiting = second.awaitRequest('g', open.id, controller.signal);
    controller.abort();
    expect(await waiting).toMatchObject({ status: 'cancelled' });
    await expect(second.answerRequest('g', open.id, 1, human)).rejects.toMatchObject({
      code: 'request_closed',
    });
  });

  test('a long poll returns as soon as the request is answered, or empty-handed at the timeout', async () => {
    const store = await openStore();
    await store.create({ name: 'Garage', id: 'g' }, human);
    const request = await store.createRequest('g', ask, agent);
    const polled = store.getRequest('g', request.id, 10_000);
    await store.answerRequest('g', request.id, 'ok', human);
    expect((await polled).status).toBe('answered');
    const other = await store.createRequest('g', ask, agent);
    // real timer on purpose: the timeout path of the long poll is the behaviour under test
    expect((await store.getRequest('g', other.id, 20)).status).toBe('open');
  });
});
