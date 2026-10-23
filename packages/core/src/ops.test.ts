import { describe, expect, test } from 'bun:test';
import { boardSizeMm, cellCenter, DEFAULT_BOARD, nearestCell } from './grid.ts';
import { applyOp, checkIntegrity, OpError } from './ops.ts';
import {
  createEmptyWall,
  type Op,
  OpSchema,
  type Wall,
  type WallItem,
  WallItemSchema,
} from './schema.ts';
import { migrateWall, parseOp, parseWall, WallParseError } from './wall.ts';
import type { JsonValue } from './json.ts';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Strips `rev`: the inverse restores content, while rev only ever moves forward. */
function content(wall: Wall): Omit<Wall, 'rev'> {
  const { rev: _rev, ...rest } = wall;
  return rest;
}

function holder(id: string, col: number, row: number, extra: Partial<WallItem> = {}): WallItem {
  return WallItemSchema.parse({
    id,
    kind: 'holder',
    bankId: 'hsw-hook',
    cell: { col, row },
    ...extra,
  });
}

/** Built through the reducer so every item is in canonical (snapped, normalised) form. */
function fixture(): Wall {
  const built = applyOp(
    createEmptyWall('w1', 'Garage'),
    OpSchema.parse({
      type: 'batch',
      ops: [
        {
          type: 'addItem',
          item: holder('h1', 2, 3, { variantId: 'long', params: { length: 50 } }),
        },
        { type: 'addItem', item: holder('h2', 3, 3) },
        {
          type: 'addItem',
          item: {
            id: 't1',
            kind: 'tool',
            modelRefId: 'm1',
            parentId: 'h1',
            pose: { x: 50, y: 80, z: 12, rotZ: 30 },
            source: { type: 'vision', confidence: 0.8, photoId: 'p1' },
          },
        },
        {
          type: 'addPhoto',
          photo: { id: 'p1', file: 'photos/p1.jpg', mime: 'image/jpeg', width: 100, height: 80 },
        },
        {
          type: 'addModelRef',
          model: { id: 'm1', label: 'Hammer', source: { type: 'bank' }, score: 0.5 },
        },
      ],
    }),
  );
  return { ...built.wall, rev: 5 };
}

/** One representative op per type; every one must be exactly invertible. */
const SAMPLE_OPS: readonly Op[] = [
  { type: 'addItem', item: holder('h9', 5, 5), index: 1 },
  { type: 'addItem', item: holder('h9', 5, 5) },
  { type: 'removeItem', id: 'h2' },
  { type: 'moveItem', id: 'h1', to: { cell: { col: 7, row: 1 }, z: 4 } },
  { type: 'moveItem', id: 'h1', to: { x: 123.4, y: 56.7 } },
  { type: 'moveItem', id: 't1', to: { cell: { col: 1, row: 1 } } },
  { type: 'rotateItem', id: 'h1', rotZ: 420 },
  { type: 'rotateItem', id: 't1', rotX: 10, rotY: -20 },
  { type: 'setParams', id: 'h1', set: { length: 80, width: 12 }, unset: [] },
  { type: 'setParams', id: 'h1', unset: ['length', 'absent'] },
  { type: 'setVariant', id: 'h1', variantId: null },
  { type: 'setVariant', id: 'h1', variantId: 'short', bankId: 'hsw-clip' },
  { type: 'setVariant', id: 't1', variantId: 'x', bankId: 'tool-hammer' },
  { type: 'lock', id: 'h1', locked: true },
  { type: 'attachItem', id: 't1', parentId: 'h2', slot: 1 },
  { type: 'attachItem', id: 't1', parentId: null },
  {
    type: 'addPhoto',
    photo: {
      id: 'p2',
      file: 'photos/p2.png',
      mime: 'image/png',
      width: 1,
      height: 1,
      origin: 'generated',
      view: 'side',
    },
    index: 0,
  },
  { type: 'removePhoto', id: 'p1' },
  { type: 'setCalibration', photoId: 'p1', calibration: { method: 'two-point', mmPerPx: 0.5 } },
  { type: 'setBoard', board: { ...DEFAULT_BOARD, cols: 10, rows: 4 } },
  { type: 'rename', name: 'Shed' },
  { type: 'rename', itemId: 'h2', name: 'Left hook' },
  {
    type: 'addModelRef',
    model: {
      id: 'm2',
      label: 'Hammer 2',
      status: 'candidate',
      source: { type: 'web', url: 'https://x' },
    },
    index: 0,
  },
  {
    type: 'updateModelRef',
    id: 'm1',
    patch: { status: 'chosen', score: null, notes: 'ok', forItemId: 't1' },
  },
  { type: 'removeModelRef', id: 'm1' },
  {
    type: 'batch',
    label: 'mix',
    ops: [
      { type: 'moveItem', id: 'h1', to: { cell: { col: 9, row: 9 } } },
      { type: 'setParams', id: 'h1', set: { length: 1 } },
      { type: 'removeItem', id: 'h1' },
      { type: 'addItem', item: holder('h1', 0, 0) },
    ],
  },
];

describe('applyOp: inverse restores the wall', () => {
  for (const [index, raw] of SAMPLE_OPS.entries()) {
    test(`${index}: ${raw.type}`, () => {
      const op = OpSchema.parse(raw);
      const before = deepFreeze(fixture());
      const forward = applyOp(before, op);
      expect(forward.changed).toBe(true);
      expect(forward.wall.rev).toBe(before.rev + 1);
      expect(content(forward.wall)).not.toEqual(content(before));
      const back = applyOp(forward.wall, forward.inverse);
      expect(content(back.wall)).toEqual(content(before));
      expect(back.wall.rev).toBe(before.rev + 2);
      // redo: re-applying the op to the restored wall reproduces the forward result
      expect(content(applyOp(back.wall, op).wall)).toEqual(content(forward.wall));
      expect(checkIntegrity(forward.wall)).toEqual([]);
    });
  }
});

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOp(wall: Wall, random: () => number, counter: number): Op | null {
  const pick = <T>(list: readonly T[]): T | undefined => list[Math.floor(random() * list.length)];
  const item = pick(wall.items) ?? { id: 'none' }; // refused with item_not_found, which the test tolerates
  const cell = { col: Math.floor(random() * 14), row: Math.floor(random() * 8) };
  switch (Math.floor(random() * 11)) {
    case 0:
      return { type: 'addItem', item: holder(`r${counter}`, cell.col, cell.row) };
    case 1:
      return item && { type: 'removeItem', id: item.id };
    case 2:
      return item && { type: 'moveItem', id: item.id, to: { cell } };
    case 3:
      return (
        item && {
          type: 'moveItem',
          id: item.id,
          to: { x: random() * 500, y: random() * 500, z: random() * 20 },
        }
      );
    case 4:
      return (
        item && {
          type: 'rotateItem',
          id: item.id,
          rotZ: Math.floor(random() * 6) * 60 + (random() < 0.3 ? 7 : 0),
        }
      );
    case 5:
      return (
        item && {
          type: 'setParams',
          id: item.id,
          set: { a: Math.floor(random() * 3) },
          unset: random() < 0.5 ? ['b'] : [],
        }
      );
    case 6:
      return item && { type: 'lock', id: item.id, locked: random() < 0.5 };
    case 7:
      return {
        type: 'setBoard',
        board: {
          ...wall.board,
          cols: 8 + Math.floor(random() * 8),
          rows: 4 + Math.floor(random() * 8),
        },
      };
    case 8:
      return { type: 'rename', name: `wall ${Math.floor(random() * 3)}` };
    case 10: {
      const holderItems = wall.items.filter((candidate) => candidate.kind === 'holder');
      const parent = random() < 0.25 ? undefined : pick(holderItems);
      return (
        item && {
          type: 'attachItem',
          id: item.id,
          parentId: parent?.id ?? null,
          slot: parent === undefined ? null : Math.floor(random() * 3),
        }
      );
    }
    default:
      return (
        item && {
          type: 'setVariant',
          id: item.id,
          variantId: random() < 0.3 ? null : `v${Math.floor(random() * 3)}`,
        }
      );
  }
}

describe('applyOp: random sequences', () => {
  test('undoing every op in reverse restores the start; redoing in order reproduces the end', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = mulberry32(seed);
      const start = deepFreeze(fixture());
      let wall = start;
      const applied: { op: Op; inverse: Op; after: Wall }[] = [];
      for (let step = 0; step < 60; step++) {
        const op = randomOp(wall, random, step);
        if (op === null) continue;
        try {
          const result = applyOp(wall, OpSchema.parse(op));
          wall = deepFreeze(result.wall);
          applied.push({ op, inverse: result.inverse, after: wall });
        } catch (error) {
          expect(error).toBeInstanceOf(OpError); // refused ops (locked, duplicate) leave the wall alone
        }
        expect(checkIntegrity(wall)).toEqual([]);
      }
      let undone = wall;
      for (const entry of [...applied].reverse()) undone = applyOp(undone, entry.inverse).wall;
      expect(content(undone)).toEqual(content(start));
      let redone = undone;
      for (const entry of applied) redone = applyOp(redone, entry.op).wall;
      expect(content(redone)).toEqual(content(wall));
    }
  });
});

describe('setVariant inverse', () => {
  test('clearing the bank id is undone exactly', () => {
    const withBank = applyOp(fixture(), {
      type: 'setVariant',
      id: 't1',
      variantId: 'v1',
      bankId: 'tool-x',
    }).wall;
    const cleared = applyOp(withBank, {
      type: 'setVariant',
      id: 't1',
      variantId: null,
      bankId: null,
    });
    expect(cleared.wall.items.find((item) => item.id === 't1')?.bankId).toBeUndefined();
    expect(content(applyOp(cleared.wall, cleared.inverse).wall)).toEqual(content(withBank));
  });
});

describe('rev rules', () => {
  test('an op that changes nothing keeps the same wall object and rev', () => {
    const wall = fixture();
    for (const op of [
      { type: 'lock', id: 'h1', locked: false },
      { type: 'rename', name: 'Garage' },
      { type: 'moveItem', id: 'h1', to: { cell: { col: 2, row: 3 } } },
      { type: 'rotateItem', id: 'h1', rotZ: 0 },
      { type: 'setParams', id: 'h1', set: { length: 50 } },
      { type: 'setBoard', board: wall.board },
    ] as const) {
      const result = applyOp(wall, OpSchema.parse(op));
      expect(result.changed).toBe(false);
      expect(result.wall).toBe(wall);
      // the inverse of a no-op is a no-op too
      expect(applyOp(result.wall, result.inverse).changed).toBe(false);
    }
  });

  test('a batch is one rev, and a batch of no-ops is no rev', () => {
    const wall = fixture();
    const batch = OpSchema.parse({
      type: 'batch',
      ops: [
        { type: 'rotateItem', id: 'h1', rotZ: 60 },
        { type: 'rotateItem', id: 'h2', rotZ: 60 },
      ],
    });
    expect(applyOp(wall, batch).wall.rev).toBe(wall.rev + 1);
    const idle = OpSchema.parse({
      type: 'batch',
      ops: [{ type: 'lock', id: 'h1', locked: false }],
    });
    expect(applyOp(wall, idle).wall.rev).toBe(wall.rev);
  });

  test('a failing op inside a batch throws with its index and changes nothing', () => {
    const wall = deepFreeze(fixture());
    const batch = OpSchema.parse({
      type: 'batch',
      ops: [
        { type: 'rotateItem', id: 'h1', rotZ: 60 },
        { type: 'removeItem', id: 'missing' },
      ],
    });
    const error = (() => {
      try {
        applyOp(wall, batch);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(OpError);
    expect(error).toMatchObject({ code: 'item_not_found', opIndex: 1 });
  });
});

describe('locks and refusals', () => {
  const locked = (): Wall => applyOp(fixture(), { type: 'lock', id: 'h1', locked: true }).wall;
  test('locked items refuse edits but can be unlocked', () => {
    const wall = locked();
    for (const op of [
      { type: 'moveItem', id: 'h1', to: { cell: { col: 0, row: 0 } } },
      { type: 'rotateItem', id: 'h1', rotZ: 60 },
      { type: 'setParams', id: 'h1', set: { length: 1 } },
      { type: 'setVariant', id: 'h1', variantId: null },
      { type: 'removeItem', id: 'h1' },
      { type: 'rename', itemId: 'h1', name: 'x' },
    ] as const) {
      expect(() => applyOp(wall, OpSchema.parse(op))).toThrow(/locked/);
    }
    expect(applyOp(wall, { type: 'lock', id: 'h1', locked: false }).changed).toBe(true);
  });

  test('duplicate ids, unknown targets and contradictory params are refused', () => {
    const wall = fixture();
    const code = (op: Op): string | undefined => {
      try {
        applyOp(wall, op);
        return undefined;
      } catch (error) {
        return error instanceof OpError ? error.code : 'other';
      }
    };
    expect(code({ type: 'addItem', item: holder('h1', 9, 9) })).toBe('item_exists');
    expect(code({ type: 'moveItem', id: 'nope', to: { x: 1, y: 1 } })).toBe('item_not_found');
    expect(code({ type: 'setCalibration', photoId: 'nope', calibration: null })).toBe(
      'photo_not_found',
    );
    expect(code({ type: 'removeModelRef', id: 'nope' })).toBe('model_not_found');
    expect(code({ type: 'setParams', id: 'h1', set: { a: 1 }, unset: ['a'] })).toBe('invalid_op');
    expect(code({ type: 'rotateItem', id: 'h1' })).toBe('invalid_op');
    expect(code({ type: 'rename', name: null })).toBe('invalid_op');
    expect(code({ type: 'setVariant', id: 'h1', variantId: null, bankId: null })).toBe(
      'invalid_op',
    );
  });
});

describe('grid snapping and warnings', () => {
  test('snapped items get their x/y from the cell; setBoard re-derives them', () => {
    const wall = fixture();
    const h1 = wall.items.find((item) => item.id === 'h1');
    expect(h1?.pose).toMatchObject(cellCenter(wall.board, { col: 2, row: 3 }));
    const wider = applyOp(wall, {
      type: 'setBoard',
      board: { ...wall.board, colPitchMm: 30, rowPitchMm: 30 },
    }).wall;
    expect(wider.items.find((item) => item.id === 'h1')?.pose).toMatchObject({ x: 75, y: 105 });
    // the free tool keeps its pose
    expect(wider.items.find((item) => item.id === 't1')?.pose.x).toBe(50);
  });

  test('neighbouring cells are 23.6 mm apart and nearestCell inverts cellCenter', () => {
    const board = DEFAULT_BOARD;
    const a = cellCenter(board, { col: 4, row: 5 });
    const sameColumn = cellCenter(board, { col: 4, row: 6 });
    const nextColumn = cellCenter(board, { col: 5, row: 5 });
    expect(Math.hypot(sameColumn.x - a.x, sameColumn.y - a.y)).toBeCloseTo(23.6, 6);
    expect(Math.hypot(nextColumn.x - a.x, nextColumn.y - a.y)).toBeCloseTo(23.6, 3);
    for (let col = 0; col < board.cols; col += 5) {
      for (let row = 0; row < board.rows; row += 3) {
        const center = cellCenter(board, { col, row });
        expect(nearestCell(board, center.x + 3, center.y - 4)).toEqual({ col, row });
      }
    }
    expect(boardSizeMm(board).width).toBeCloseTo(48 * 20.4382, 6);
  });

  test('collisions, out-of-board cells and dangling refs are warnings, not errors', () => {
    const wall = fixture();
    const result = applyOp(wall, {
      type: 'batch',
      ops: [
        { type: 'addItem', item: holder('dup', 2, 3) },
        { type: 'addItem', item: holder('far', 999, 0) },
        { type: 'rotateItem', id: 'h2', rotZ: 45 },
        { type: 'removePhoto', id: 'p1' },
        { type: 'removeItem', id: 'h1' },
      ],
    });
    const codes: string[] = result.warnings.map((warning) => warning.code).sort();
    expect(codes).toEqual(
      [
        'cell_out_of_board',
        'missing_parent',
        'missing_photo',
        'out_of_board',
        'rotation_off_symmetry',
      ].sort(),
    );
    const collision = applyOp(wall, { type: 'addItem', item: holder('dup', 2, 3) }).warnings;
    expect(collision).toEqual([
      expect.objectContaining({ code: 'cell_collision', itemIds: ['h1', 'dup'] }),
    ]);
  });
});

describe('parsing and migration', () => {
  test('omitted fields get defaults and ids are generated', () => {
    const op = parseOp({
      type: 'addItem',
      item: { kind: 'holder', bankId: 'b', cell: { col: 1, row: 1 } },
    });
    if (op.type !== 'addItem') throw new Error('wrong op');
    expect(op.item.id).toMatch(/^i-/);
    expect(op.item).toMatchObject({
      locked: false,
      params: {},
      source: { type: 'manual' },
      pose: { z: 0, rotZ: 0 },
    });
  });

  test('typos and incomplete items are rejected loudly', () => {
    expect(() => parseOp({ type: 'rotateItem', id: 'a', rotation: 3 })).toThrow(WallParseError);
    expect(() => parseOp({ type: 'addItem', item: { kind: 'photo-ref' } })).toThrow(/photoId/);
    expect(() => parseOp({ type: 'addItem', item: { kind: 'tool' } })).toThrow(
      /bankId or modelRefId/,
    );
    expect(() => parseOp({ type: 'moveItem', id: '../x', to: { x: 1, y: 1 } })).toThrow(
      WallParseError,
    );
    expect(() => parseOp({ type: 'moveItem', id: 'a', to: { x: Number.NaN, y: 1 } })).toThrow();
  });

  test('migrations run in order; newer or unmigratable documents are refused', () => {
    const v0: JsonValue = { schemaVersion: 0, legacyName: 'old' };
    const migrated = migrateWall(
      v0,
      { 0: (doc) => ({ ...doc, name: doc['legacyName'] ?? null }) },
      1,
    );
    expect(migrated).toEqual({ schemaVersion: 1, legacyName: 'old', name: 'old' });
    expect(() => migrateWall({ schemaVersion: 0 }, {}, 1)).toThrow(/no migration/);
    expect(() => migrateWall({ schemaVersion: 9 })).toThrow(/newer/);
    expect(() => migrateWall({})).toThrow(/schemaVersion/);
  });

  test('a stored wall round-trips through JSON and parseWall', () => {
    const wall = applyOp(fixture(), SAMPLE_OPS.map((op) => OpSchema.parse(op))[2] as Op).wall;
    const json: JsonValue = JSON.parse(JSON.stringify(wall));
    expect(parseWall(json)).toEqual(wall);
    const duplicated: JsonValue = JSON.parse(
      JSON.stringify({ ...wall, items: [...wall.items, ...wall.items] }),
    );
    expect(() => parseWall(duplicated)).toThrow(/duplicate item/);
  });
});

describe('attachItem', () => {
  test('sets and clears parentId and slot; the wall stays free of warnings', () => {
    const attached = applyOp(fixture(), { type: 'attachItem', id: 't1', parentId: 'h2', slot: 2 });
    expect(attached.wall.items.find((item) => item.id === 't1')).toMatchObject({
      parentId: 'h2',
      slot: 2,
    });
    expect(attached.warnings.filter((w) => w.code !== 'out_of_board')).toEqual([]);
    const detached = applyOp(attached.wall, { type: 'attachItem', id: 't1', parentId: null });
    const tool = detached.wall.items.find((item) => item.id === 't1');
    expect(tool?.parentId).toBeUndefined();
    expect(tool?.slot).toBeUndefined();
  });

  test('only tools hang, a non-holder parent is flagged (not refused), and never when locked', () => {
    const wall = fixture();
    expect(() => applyOp(wall, { type: 'attachItem', id: 'h1', parentId: 'h2' })).toThrow(OpError);
    const toTool = applyOp(wall, { type: 'attachItem', id: 't1', parentId: 't1' });
    expect(toTool.warnings.map((w) => w.code)).toContain('parent_not_holder');
    expect(content(applyOp(toTool.wall, toTool.inverse).wall)).toEqual(content(wall));
    const locked = applyOp(wall, { type: 'lock', id: 't1', locked: true }).wall;
    expect(() => applyOp(locked, { type: 'attachItem', id: 't1', parentId: 'h2' })).toThrow(
      /locked/,
    );
  });

  test('re-attaching to the same holder and slot is a no-op', () => {
    const once = applyOp(fixture(), { type: 'attachItem', id: 't1', parentId: 'h2', slot: 0 });
    const again = applyOp(once.wall, { type: 'attachItem', id: 't1', parentId: 'h2', slot: 0 });
    expect(again.changed).toBe(false);
  });

  test('two tools in one slot are flagged', () => {
    const base = fixture();
    const withSecond = applyOp(base, {
      type: 'addItem',
      item: WallItemSchema.parse({
        id: 't2',
        kind: 'tool',
        bankId: 'tool-x',
        parentId: 'h1',
        slot: 0,
      }),
    }).wall;
    const result = applyOp(withSecond, { type: 'attachItem', id: 't1', parentId: 'h1', slot: 0 });
    expect(result.warnings.map((w) => w.code)).toContain('slot_collision');
  });

  test('a non-holder parent is flagged when the stored wall says so', () => {
    const wall = fixture();
    const bent: Wall = {
      ...wall,
      items: wall.items.map((item) => (item.id === 't1' ? { ...item, parentId: 'h1' } : item)),
    };
    const asTool: Wall = {
      ...bent,
      items: bent.items.map((item) =>
        item.id === 'h1' ? { ...item, kind: 'tool' as const } : item,
      ),
    };
    expect(applyOp(asTool, { type: 'rename', name: 'x' }).warnings.map((w) => w.code)).toContain(
      'parent_not_holder',
    );
  });
});

describe('attachItem edge cases', () => {
  test('a slot without a holder is accepted (old data stays loadable) and flagged', () => {
    const item = WallItemSchema.parse({ id: 't9', kind: 'tool', bankId: 'x', slot: 4 });
    const added = applyOp(fixture(), { type: 'addItem', item });
    expect(added.warnings.map((w) => w.code)).toContain('slot_without_parent');
  });

  test('hanging and detaching a stored slot-without-parent tool is undone exactly', () => {
    const item = WallItemSchema.parse({ id: 't9', kind: 'tool', bankId: 'x', slot: 4 });
    const legacy = applyOp(fixture(), { type: 'addItem', item }).wall;
    const hung = applyOp(legacy, { type: 'attachItem', id: 't9', parentId: 'h1', slot: 0 });
    expect(content(applyOp(hung.wall, hung.inverse).wall)).toEqual(content(legacy));
    const detached = applyOp(legacy, { type: 'attachItem', id: 't9', parentId: null });
    expect(detached.changed).toBe(true);
    expect(content(applyOp(detached.wall, detached.inverse).wall)).toEqual(content(legacy));
  });

  test('moving to another slot of the same holder changes only the slot; detaching a free tool is a no-op', () => {
    const first = applyOp(fixture(), { type: 'attachItem', id: 't1', parentId: 'h1', slot: 0 });
    const second = applyOp(first.wall, { type: 'attachItem', id: 't1', parentId: 'h1', slot: 2 });
    expect(second.changed).toBe(true);
    expect(content(applyOp(second.wall, second.inverse).wall)).toEqual(content(first.wall));
    const detached = applyOp(second.wall, { type: 'attachItem', id: 't1', parentId: null });
    expect(applyOp(detached.wall, { type: 'attachItem', id: 't1', parentId: null }).changed).toBe(
      false,
    );
  });

  test('a holder that no longer exists is flagged, and re-attaching away from it is undone exactly', () => {
    const orphaned = applyOp(fixture(), { type: 'removeItem', id: 'h1' }).wall;
    expect(applyOp(orphaned, { type: 'rename', name: 'x' }).warnings.map((w) => w.code)).toContain(
      'missing_parent',
    );
    const rehung = applyOp(orphaned, { type: 'attachItem', id: 't1', parentId: 'h2', slot: 1 });
    expect(content(applyOp(rehung.wall, rehung.inverse).wall)).toEqual(content(orphaned));
    const toGhost = applyOp(fixture(), { type: 'attachItem', id: 't1', parentId: 'nope' });
    expect(toGhost.warnings.map((w) => w.code)).toContain('missing_parent');
  });
});
