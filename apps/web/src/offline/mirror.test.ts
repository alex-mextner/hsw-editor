import { describe, expect, test } from 'bun:test';
import { createEmptyWall } from '@hsw-editor/core';
import { IDBFactory } from 'fake-indexeddb';
import { idbStore, offlineDbProvider } from './idb.ts';
import { createMemoryStore, type KvStore } from './kv.ts';
import { enqueueEdit, LiveRecord, newRecord, WallMirror, withServerWall } from './mirror.ts';
import { foldEdits, parseWallRecord, type WallRecord } from './record.ts';
import { edit, holder, ME, recordOf, wallWith } from './testing.ts';

const flags = { canUndo: false, canRedo: false };
const lock = { type: 'lock', id: 'a', locked: true } as const;

function memoryMirror() {
  return new WallMirror(createMemoryStore<WallRecord>(parseWallRecord));
}

describe('record helpers', () => {
  const wall = wallWith(holder('a', 1, 1));

  test('enqueueEdit flattens batches, numbers edits and remembers the base rev', () => {
    let record = newRecord(wall, ME, flags, 1);
    record = enqueueEdit(
      record,
      [
        {
          type: 'batch',
          ops: [
            { type: 'rotateItem', id: 'a', rotZ: 60 },
            { type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } },
          ],
        },
      ],
      'Re-hang',
      5,
    );
    record = enqueueEdit(record, [lock], undefined, 6);
    expect(record.edits.map((e) => [e.id, e.ops.length, e.baseRev, e.label])).toEqual([
      [1, 2, wall.rev, 'Re-hang'],
      [2, 1, wall.rev, undefined],
    ]);
    expect(record.nextEditId).toBe(3);
  });

  test('a lone batch keeps its own label as the undo-step name', () => {
    const record = enqueueEdit(
      newRecord(wall, ME, flags, 1),
      [{ type: 'batch', label: 'Tidy up', ops: [lock] }],
      undefined,
      2,
    );
    expect(record.edits[0]?.label).toBe('Tidy up');
  });

  test('an edit with no operations is not recorded: the stored queue must stay readable', () => {
    const base = newRecord(wall, ME, flags, 1);
    expect(enqueueEdit(base, [], undefined, 2)).toBe(base);
    const withEmptyBatch = enqueueEdit(base, [{ type: 'batch', ops: [] }], undefined, 2);
    expect(withEmptyBatch).toBe(base);
    // Whatever enqueueEdit accepts, parseWallRecord reads back.
    const real = enqueueEdit(base, [lock], undefined, 3);
    expect(parseWallRecord(structuredClone(real))).toEqual(real);
  });

  test('foldEdits applies in order and skips what the reducer refuses', () => {
    const edits = [
      edit(1, wall.rev, lock),
      edit(2, wall.rev, { type: 'rotateItem', id: 'a', rotZ: 60 }),
    ];
    const folded = foldEdits(wall, edits);
    expect(folded.refused).toEqual([2]);
    expect(folded.wall.items[0]?.locked).toBe(true);
  });

  test('withServerWall keeps the queue and moves the base', () => {
    const queued = enqueueEdit(newRecord(wall, ME, flags, 1), [lock], undefined, 2);
    const newer = { ...wall, rev: wall.rev + 4 };
    const next = withServerWall(queued, newer, { canUndo: true, canRedo: false }, 9);
    expect(next.wall.rev).toBe(newer.rev);
    expect(next.edits).toEqual(queued.edits);
    expect(next.canUndo).toBe(true);
  });
});

describe('parseWallRecord', () => {
  const wall = wallWith(holder('a', 1, 1));
  const good = recordOf(wall, [edit(1, wall.rev, lock)]);

  test('accepts what was written', () => {
    expect(parseWallRecord(structuredClone(good))).toEqual(good);
  });

  test.each([
    ['another version', { ...good, v: 2 }],
    ['a wall that fails the schema', { ...good, wall: { ...good.wall, rev: -1 } }],
    [
      'an unreadable edit (the whole record is refused, never a silent drop)',
      { ...good, edits: [{ ...good.edits[0], ops: [{ type: 'nonsense' }] }] },
    ],
    ['an edit with no ops', { ...good, edits: [{ ...good.edits[0], ops: [] }] }],
    ['a non-finite timestamp', { ...good, savedAt: Number.NaN }],
    ['a non-finite edit time', { ...good, edits: [{ ...good.edits[0], at: Infinity }] }],
    ['no actor', { ...good, actor: undefined }],
    ['not an object', 'text'],
  ])('rejects %s', (_name, raw) => {
    expect(parseWallRecord(raw)).toBeUndefined();
  });
});

describe('LiveRecord', () => {
  test('every change is a function of the current record and is persisted in order', async () => {
    const saved: WallRecord[] = [];
    const wall = wallWith(holder('a', 1, 1));
    const live = new LiveRecord(
      newRecord(wall, ME, flags, 0),
      (record) => {
        saved.push(record);
        return Promise.resolve();
      },
      () => 42,
    );
    await live.update((record) => enqueueEdit(record, [lock], undefined, 1));
    await live.update((record) => ({ ...record, edits: record.edits.slice(1) }));
    expect(saved.map((record) => record.edits.length)).toEqual([1, 0]);
    expect(live.read().savedAt).toBe(42);
    expect(live.read().nextEditId).toBe(2);
  });
});

describe('WallMirror', () => {
  test('stores, lists newest first with queued counts, and removes', async () => {
    const mirror = memoryMirror();
    const first = newRecord(createEmptyWall('w1', 'First'), ME, flags, 10);
    const second = enqueueEdit(
      newRecord(wallWith(holder('a', 1, 1)), ME, flags, 20),
      [lock],
      undefined,
      30,
    );
    await mirror.put(first);
    await mirror.put({ ...second, wall: { ...second.wall, id: 'w2', name: 'Second' } });
    const list = await mirror.list();
    expect(list.map((row) => [row.summary.id, row.summary.name, row.queued])).toEqual([
      ['w2', 'Second', 1],
      ['w1', 'First', 0],
    ]);
    await mirror.remove('w2');
    expect((await mirror.list()).map((row) => row.summary.id)).toEqual(['w1']);
  });

  test('a burst of puts writes the first and the newest, never an older record last', async () => {
    const written: number[] = [];
    const gates: (() => void)[] = [];
    const inner = createMemoryStore<WallRecord>(parseWallRecord);
    const slow: KvStore<WallRecord> = {
      ...inner,
      async set(key, value) {
        await new Promise<void>((resolve) => gates.push(resolve));
        written.push(value.savedAt);
        await inner.set(key, value);
      },
    };
    const mirror = new WallMirror(slow);
    const wall = createEmptyWall('w1', 'W');
    void mirror.put(newRecord(wall, ME, flags, 1));
    void mirror.put(newRecord(wall, ME, flags, 2));
    void mirror.put(newRecord(wall, ME, flags, 3));
    const flushed = mirror.flush();
    expect(gates).toHaveLength(1);
    gates.shift()?.();
    // The second write starts after a few microtasks; bounded so a regression fails instead of hanging.
    for (let ticks = 0; gates.length === 0; ticks += 1) {
      if (ticks > 100) throw new Error('the coalesced second write never started');
      await Promise.resolve();
    }
    gates.shift()?.();
    await flushed;
    expect(written).toEqual([1, 3]);
    expect((await mirror.get('w1'))?.savedAt).toBe(3);
  });

  test('prune drops the oldest clean walls beyond the limit and never one with unsent edits', async () => {
    const mirror = memoryMirror();
    for (let i = 1; i <= 5; i += 1) {
      await mirror.put(newRecord(createEmptyWall(`w${i}`, `W${i}`), ME, flags, i));
    }
    const dirty = enqueueEdit(
      newRecord(wallWith(holder('a', 1, 1)), ME, flags, 0),
      [lock],
      undefined,
      0,
    );
    await mirror.put({ ...dirty, wall: { ...dirty.wall, id: 'old-dirty' } });
    const removed = await mirror.prune(2);
    expect(removed.sort()).toEqual(['w1', 'w2', 'w3']);
    expect((await mirror.list()).map((row) => row.summary.id).sort()).toEqual([
      'old-dirty',
      'w4',
      'w5',
    ]);
  });

  test('prune does not delete a wall that got an edit after the scan (the delete re-checks atomically)', async () => {
    const inner = createMemoryStore<WallRecord>(parseWallRecord);
    const racing: KvStore<WallRecord> = {
      ...inner,
      async entries() {
        const entries = await inner.entries();
        // Between prune's scan and its delete, another tab queues an edit on w1.
        const current = await inner.get('w1');
        if (current) await inner.set('w1', enqueueEdit(current, [lock], undefined, 9));
        return entries;
      },
    };
    const mirror = new WallMirror(racing);
    await mirror.put({ ...newRecord(wallWith(holder('a', 1, 1)), ME, flags, 1) });
    await mirror.put(newRecord(createEmptyWall('w2', 'W2'), ME, flags, 2));
    expect(await mirror.prune(0)).toEqual(['w2']);
    expect((await inner.get('w1'))?.edits).toHaveLength(1);
  });
});

describe('IndexedDB store', () => {
  test('round-trips records through a real IndexedDB implementation and survives a reopen', async () => {
    const factory = new IDBFactory();
    const db = offlineDbProvider(factory);
    const mirror = new WallMirror(idbStore(db, 'walls', parseWallRecord));
    const wall = wallWith(holder('a', 1, 1));
    const record = enqueueEdit(newRecord(wall, ME, flags, 7), [lock], undefined, 8);
    await mirror.put(record);
    (await db()).close();

    const again = new WallMirror(idbStore(offlineDbProvider(factory), 'walls', parseWallRecord));
    expect(await again.get('w1')).toEqual(record);
    expect((await again.list())[0]?.queued).toBe(1);
    await again.remove('w1');
    expect(await again.get('w1')).toBeUndefined();
  });

  test('deleteIf deletes only when the stored record still satisfies the condition', async () => {
    const store = idbStore(offlineDbProvider(new IDBFactory()), 'walls', parseWallRecord);
    const clean = newRecord(createEmptyWall('w1', 'W'), ME, flags, 1);
    await store.set('w1', clean);
    expect(await store.deleteIf('w1', (current) => current.edits.length > 0)).toBe(false);
    expect(await store.get('w1')).toBeDefined();
    expect(await store.deleteIf('w1', (current) => current.edits.length === 0)).toBe(true);
    expect(await store.get('w1')).toBeUndefined();
    expect(await store.deleteIf('w1', () => true)).toBe(false);
  });

  test('a corrupt record is invisible, not fatal', async () => {
    const db = offlineDbProvider(new IDBFactory());
    const raw = idbStore<unknown>(db, 'walls', (value) => value);
    await raw.set('w9', { v: 99 });
    const mirror = new WallMirror(idbStore(db, 'walls', parseWallRecord));
    expect(await mirror.get('w9')).toBeUndefined();
    expect(await mirror.list()).toEqual([]);
  });
});
