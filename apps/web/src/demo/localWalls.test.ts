import { describe, expect, test } from 'bun:test';
import { createEmptyWall, type Op, type Wall, type WallItem } from '@hsw-editor/core';
import { ApiError } from '@/api/http.ts';
import { createMemoryStore } from '@/offline/kv.ts';
import { WallMirror } from '@/offline/mirror.ts';
import { parseWallRecord } from '@/offline/record.ts';
import { LocalWalls, type Exclusive } from './localWalls.ts';

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

const add = (id: string, col: number): Op => ({ type: 'addItem', item: holder(id, col) });

const templateWall = (): Wall => ({
  ...createEmptyWall('demo', 'Demo wall'),
  items: [holder('h1', 1)],
  rev: 1,
});

function service(): { walls: LocalWalls; mirror: WallMirror } {
  const mirror = new WallMirror(createMemoryStore(parseWallRecord));
  return { walls: new LocalWalls('demo', () => Promise.resolve(templateWall()), mirror), mirror };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
  return 'resolved';
}

describe('LocalWalls', () => {
  test('the template is listed first and answers with the template flag; no other wall does', async () => {
    const { walls } = service();
    expect((await walls.get('demo')).template).toBe(true);
    const clone = await walls.clone('demo', { id: 'mine', name: 'Demo wall (copy)' });
    expect((await walls.get(clone.id)).template).toBeUndefined();
    const list = await walls.list();
    expect(list.map((wall) => wall.id)).toEqual(['demo', 'mine']);
    expect(list[0]?.template).toBe(true);
  });

  test('a clone keeps the items, starts at rev 0 without history, and leaves the template alone', async () => {
    const { walls } = service();
    const clone = await walls.clone('demo', { id: 'mine', name: 'Mine' });
    expect(clone).toMatchObject({ id: 'mine', name: 'Mine', rev: 0 });
    expect(clone.items.map((item) => item.id)).toEqual(['h1']);
    expect((await walls.get('mine')).canUndo).toBe(false);
    expect(await walls.history('mine', 0, 10)).toEqual([]);

    const edit = await walls.apply('mine', [add('h2', 5)], 0, undefined);
    expect(edit.wall.items.map((item) => item.id)).toEqual(['h1', 'h2']);
    expect((await walls.get('demo')).wall.items.map((item) => item.id)).toEqual(['h1']);
  });

  test('undo and redo walk the history, always moving the revision forward, and stop at the copy', async () => {
    const { walls } = service();
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    await walls.apply('mine', [add('h2', 5)], 0, undefined);
    const undone = await walls.undo('mine', 1);
    expect(undone.wall.items.map((item) => item.id)).toEqual(['h1']);
    expect(undone.wall.rev).toBe(2);
    expect(undone).toMatchObject({ canUndo: false, canRedo: true });
    expect(await code(walls.undo('mine', undefined))).toBe('nothing_to_undo');
    const redone = await walls.redo('mine', 2);
    expect(redone.wall.items.map((item) => item.id)).toEqual(['h1', 'h2']);
    expect(redone.wall.rev).toBe(3);
    const timeline = await walls.history('mine', 0, 10);
    expect(timeline.map((entry) => `${entry.kind}:${entry.rev}`)).toEqual([
      'op:1',
      'undo:2',
      'redo:3',
    ]);
    expect(timeline[1]).toMatchObject({ ref: 1 });
    expect(await walls.history('mine', 2, 10)).toHaveLength(1);
  });

  test('a stale base revision is a rev_conflict that carries the current wall', async () => {
    const { walls } = service();
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    await walls.apply('mine', [add('h2', 5)], 0, undefined);
    try {
      await walls.apply('mine', [add('h3', 6)], 0, undefined);
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      if (error instanceof ApiError) {
        expect(error.isConflict).toBe(true);
        expect(error.body).toMatchObject({ currentRev: 1, wall: { id: 'mine' } });
      }
    }
  });

  test('an op the wall refuses is a 422 and changes nothing', async () => {
    const { walls } = service();
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    expect(await code(walls.apply('mine', [add('h1', 9)], 0, undefined))).toBe('op_failed');
    expect((await walls.get('mine')).wall.rev).toBe(0);
  });

  test('a wall of the visitor survives a reload through the mirror, a new one starts empty', async () => {
    const { walls, mirror } = service();
    const made = await walls.create({ name: 'Garage' });
    expect(made.items).toEqual([]);
    const clone = await walls.clone('demo', { id: 'mine', name: 'Mine' });
    await mirror.put({
      v: 1,
      wall: clone,
      canUndo: false,
      canRedo: false,
      edits: [],
      nextEditId: 1,
      actor: { kind: 'human' },
      savedAt: 1,
    });
    const reloaded = new LocalWalls(
      'demo',
      () => Promise.resolve(createEmptyWall('demo', 'Demo wall')),
      mirror,
    );
    expect((await reloaded.get('mine')).wall.name).toBe('Mine');
    const ids = (await reloaded.list()).map((wall) => wall.id);
    expect(ids[0]).toBe('demo');
    expect(ids.sort()).toEqual(['demo', made.id, 'mine'].sort());
    expect(await code(reloaded.get('gone'))).toBe('wall_not_found');
  });

  test('an id in use is refused, the template cannot be deleted, a clone can', async () => {
    const { walls } = service();
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    expect(await code(walls.clone('demo', { id: 'mine', name: 'again' }))).toBe('wall_exists');
    expect(await code(walls.create({ name: 'x', id: 'demo' }))).toBe('wall_exists');
    expect(await code(walls.remove('demo'))).toBe('demo_unavailable');
    await walls.remove('mine');
    expect((await walls.list()).map((wall) => wall.id)).toEqual(['demo']);
  });

  test('an edit survives a reload with no help from the editor: the service writes it itself', async () => {
    const { walls, mirror } = service();
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    await walls.apply('mine', [add('h2', 5)], 0, undefined);
    const reloaded = new LocalWalls('demo', () => Promise.resolve(templateWall()), mirror);
    expect((await reloaded.get('mine')).wall.items.map((item) => item.id)).toEqual(['h1', 'h2']);
  });

  describe('two tabs on the same storage', () => {
    /** The page lock (Web Locks) of the browser, which every tab of the origin shares. */
    function sharedLock(): Exclusive {
      let tail: Promise<unknown> = Promise.resolve();
      return (job) => {
        const run = tail.then(job);
        tail = run.catch(() => undefined);
        return run;
      };
    }

    async function twoTabs(): Promise<{ a: LocalWalls; b: LocalWalls }> {
      const { mirror } = service();
      const lock = sharedLock();
      const open = (): LocalWalls =>
        new LocalWalls(
          'demo',
          () => Promise.resolve(templateWall()),
          mirror,
          () => new Date(),
          lock,
        );
      const a = open();
      await a.clone('demo', { id: 'mine', name: 'Mine' });
      const b = open();
      await b.get('mine');
      return { a, b };
    }

    test('an edit from a tab that is behind is a rev_conflict carrying the newer wall, and overwrites nothing', async () => {
      const { a, b } = await twoTabs();
      await a.apply('mine', [add('h2', 5)], 0, undefined);
      try {
        await b.apply('mine', [add('h3', 6)], 0, undefined);
        throw new Error('expected a conflict');
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        expect(error.isConflict).toBe(true);
        expect(error.body).toMatchObject({ wall: { items: [{ id: 'h1' }, { id: 'h2' }] } });
      }
      expect((await a.get('mine')).wall.items.map((item) => item.id)).toEqual(['h1', 'h2']);
    });

    test('two edits made at the same moment from the same revision: one is saved, the other is a conflict', async () => {
      const { a, b } = await twoTabs();
      const outcomes = await Promise.allSettled([
        a.apply('mine', [add('h2', 5)], 0, undefined),
        b.apply('mine', [add('h3', 6)], 0, undefined),
      ]);
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((await a.get('mine')).wall.items).toHaveLength(2);
      expect((await b.get('mine')).wall.items).toHaveLength(2);
    });

    test('a tab that is behind and only reads takes over the newer wall instead of writing its old one back', async () => {
      const { a, b } = await twoTabs();
      await a.apply('mine', [add('h2', 5)], 0, undefined);
      expect((await b.get('mine')).wall.rev).toBe(1);
      expect((await a.get('mine')).wall.rev).toBe(1);
    });

    test('undo of the newer tab survives the other tab reading the wall', async () => {
      const { a, b } = await twoTabs();
      await a.apply('mine', [add('h2', 5)], 0, undefined);
      await b.get('mine');
      expect((await a.undo('mine', 1)).wall.items.map((item) => item.id)).toEqual(['h1']);
    });

    test('a wall deleted in one tab is gone in the other, and an edit there does not bring it back', async () => {
      const { a, b } = await twoTabs();
      await a.remove('mine');
      expect(await code(b.apply('mine', [add('h2', 5)], 0, undefined))).toBe('wall_not_found');
      expect((await b.list()).map((wall) => wall.id)).toEqual(['demo']);
    });
  });

  test('a read that overlaps an edit of the same tab does not roll the edit back', async () => {
    const { walls } = service();
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    await Promise.all([
      walls.apply('mine', [add('h2', 5)], 0, undefined),
      walls.history('mine', 0, 10),
      walls.get('mine'),
    ]);
    const after = await walls.get('mine');
    expect(after.wall.items.map((item) => item.id)).toEqual(['h1', 'h2']);
    expect(after.canUndo).toBe(true);
  });

  test('a wall name past the daemon limit is refused, so a saved wall always reads back', async () => {
    const { walls } = service();
    expect(await code(walls.create({ name: 'x'.repeat(201) }))).toBe('invalid_name');
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    expect(await code(walls.clone('demo', { id: 'other', name: 'x'.repeat(201) }))).toBe(
      'invalid_name',
    );
    const rename: Op = { type: 'rename', name: 'x'.repeat(201) };
    expect(await code(walls.apply('mine', [rename], 0, undefined))).toBe('op_failed');
  });

  test('an edit still in flight when its wall is deleted does not bring the wall back', async () => {
    const { walls, mirror } = service();
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    const edit = walls.apply('mine', [add('h2', 5)], 0, undefined);
    const removal = walls.remove('mine');
    await Promise.all([edit, removal]);
    expect(await mirror.get('mine')).toBeUndefined();
    expect((await walls.list()).map((wall) => wall.id)).toEqual(['demo']);
  });

  test('an edit that cannot be saved (storage full) is not kept in memory either, and undo history stays right', async () => {
    const { walls, mirror } = service();
    await walls.clone('demo', { id: 'mine', name: 'Mine' });
    await walls.apply('mine', [add('h2', 5)], 0, undefined);
    const put = mirror.put.bind(mirror);
    mirror.put = () => Promise.reject(new Error('QuotaExceededError'));
    await expect(walls.apply('mine', [add('h3', 6)], 1, undefined)).rejects.toThrow('Quota');
    await expect(walls.undo('mine', 1)).rejects.toThrow('Quota');
    mirror.put = put;
    const now = await walls.get('mine');
    expect(now.wall.items.map((item) => item.id)).toEqual(['h1', 'h2']);
    expect(now.wall.rev).toBe(1);
    expect(now).toMatchObject({ canUndo: true, canRedo: false });
    expect((await walls.undo('mine', 1)).wall.items.map((item) => item.id)).toEqual(['h1']);
  });
});
