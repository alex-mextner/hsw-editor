import { describe, expect, test } from 'bun:test';
import { planHang, type HolderSpec } from '@hsw-editor/compat';
import {
  applyOp,
  cellCenter,
  createEmptyWall,
  DEFAULT_BOARD,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { moveItemsOps, planToolDrag } from './attach.ts';

const board = { ...DEFAULT_BOARD, cols: 30, rows: 30 };

const RAIL: HolderSpec = {
  id: 'rail',
  category: 'holders/screwdrivers',
  fitsTool: [{ toolClass: 'screwdriver', capacity: 3 }],
  bboxMm: { min: { x: -60, y: -20, z: 0 }, max: { x: 60, y: 20, z: 40 } },
};
const TAPE_HOOK: HolderSpec = {
  id: 'tape-hook',
  category: 'hooks/tape',
  fitsTool: [{ toolClass: 'tape-measure', capacity: 1 }],
  bboxMm: { min: { x: -20, y: -20, z: 0 }, max: { x: 20, y: 20, z: 50 } },
};
const bank = new Map([
  [RAIL.id, RAIL],
  [TAPE_HOOK.id, TAPE_HOOK],
]);

function holder(id: string, bankId: string, col: number, row: number): WallItem {
  const centre = cellCenter(board, { col, row });
  return {
    id,
    kind: 'holder',
    bankId,
    cell: { col, row },
    pose: { x: centre.x, y: centre.y, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

function tool(id: string, toolClass: string): WallItem {
  return {
    id,
    kind: 'tool',
    toolClass,
    modelRefId: 'm',
    pose: { x: 40, y: 40, z: 40, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

function room(): Wall {
  const empty = createEmptyWall('w', 'W', board);
  return {
    ...empty,
    models: [
      {
        id: 'm',
        label: 'tool',
        status: 'chosen',
        source: { type: 'library', by: 'preset' },
        dimensionsMm: { x: 28, y: 210, z: 28 },
      },
    ],
    items: [
      holder('rail', 'rail', 6, 10),
      holder('hook', 'tape-hook', 14, 10),
      tool('drv', 'screwdriver'),
      tool('tape', 'tape-measure'),
    ],
  };
}

const cursor = { x: 0, y: 0 };

describe('planToolDrag', () => {
  test('a screwdriver over the rail snaps onto it and the rail glows', () => {
    const wall = room();
    const rail = wall.items[0]!;
    const plan = planToolDrag(wall, bank, wall.items[2]!, rail.pose, cursor, false);
    expect(plan.resolution.kind).toBe('attach');
    expect(plan.preview.target?.holderId).toBe('rail');
    expect(plan.preview.ghost?.valid).toBe(true);
    expect(plan.preview.holders.get('rail')?.ok).toBe(true);
    expect(plan.preview.holders.get('rail')?.slots.length).toBe(3);
    expect(plan.preview.holders.get('hook')?.ok).toBe(false);
  });

  test('a screwdriver over a tape-measure hook is refused with the class reason', () => {
    const wall = room();
    const hook = wall.items[1]!;
    const plan = planToolDrag(wall, bank, wall.items[2]!, hook.pose, cursor, false);
    expect(plan.resolution.kind).toBe('refuse');
    expect(plan.preview.target).toBeNull();
    expect(plan.preview.refusal?.holderId).toBe('hook');
    expect(plan.preview.refusal?.reasons[0]?.code).toBe('class_mismatch');
  });

  test('beside an unsuitable holder (pointer outside its footprint) the tool lies free', () => {
    const wall = room();
    const hook = wall.items[1]!;
    const beside = { x: hook.pose.x + 70, y: hook.pose.y };
    const plan = planToolDrag(wall, bank, wall.items[2]!, beside, cursor, false);
    expect(plan.resolution.kind).toBe('free');
    expect(plan.preview.refusal).toBeNull();
  });

  test('Alt drops anywhere: no highlighting, no snap', () => {
    const wall = room();
    const plan = planToolDrag(wall, bank, wall.items[2]!, wall.items[0]!.pose, cursor, true);
    expect(plan.resolution.kind).toBe('free');
    expect(plan.preview.holders.size).toBe(0);
  });

  test('re-hanging only lands on a compatible mount: the hook still refuses a hung screwdriver', () => {
    let wall = room();
    const first = planToolDrag(wall, bank, wall.items[2]!, wall.items[0]!.pose, cursor, false);
    if (first.resolution.kind !== 'attach') throw new Error('expected attach');
    wall = applyOp(wall, planHang(wall.items[2]!, first.resolution.target)).wall;
    const hung = wall.items.find((item) => item.id === 'drv')!;
    expect(hung.parentId).toBe('rail');
    const again = planToolDrag(wall, bank, hung, wall.items[1]!.pose, cursor, false);
    expect(again.resolution.kind).toBe('refuse');
  });
});

describe('moveItemsOps', () => {
  test('moving a holder carries the tools hanging on it', () => {
    let wall = room();
    const plan = planToolDrag(wall, bank, wall.items[2]!, wall.items[0]!.pose, cursor, false);
    if (plan.resolution.kind !== 'attach') throw new Error('expected attach');
    wall = applyOp(wall, planHang(wall.items[2]!, plan.resolution.target)).wall;
    const before = wall.items.find((item) => item.id === 'drv')!.pose;
    const rail = wall.items.find((item) => item.id === 'rail')!;
    const ops = moveItemsOps(
      wall,
      new Map([
        ['rail', { x: rail.pose.x + 100, y: rail.pose.y, rotZ: 0, cell: { col: 10, row: 10 } }],
      ]),
    );
    const next = applyOp(wall, { type: 'batch', ops }).wall;
    const moved = next.items.find((item) => item.id === 'rail')!;
    const dx = moved.pose.x - rail.pose.x;
    const carried = next.items.find((item) => item.id === 'drv')!;
    expect(dx).not.toBe(0);
    expect(carried.pose.x - before.x).toBeCloseTo(dx, 4);
    expect(carried.parentId).toBe('rail');
  });

  test('a tool moved on its own is taken off its holder', () => {
    let wall = room();
    const plan = planToolDrag(wall, bank, wall.items[2]!, wall.items[0]!.pose, cursor, false);
    if (plan.resolution.kind !== 'attach') throw new Error('expected attach');
    wall = applyOp(wall, planHang(wall.items[2]!, plan.resolution.target)).wall;
    const ops = moveItemsOps(
      wall,
      new Map([['drv', { x: 300, y: 300, rotZ: 0, cell: undefined }]]),
    );
    const next = applyOp(wall, { type: 'batch', ops }).wall;
    expect(next.items.find((item) => item.id === 'drv')?.parentId).toBeUndefined();
  });
});
