import { afterAll, describe, expect, mock, test } from 'bun:test';
import { makeElement } from '@hsw-editor/bank/testing';
import type { VariantResponse } from '@hsw-editor/bank';
import {
  applyOp,
  boardSizeMm,
  cellCenter,
  checkWall,
  createEmptyWall,
  DEFAULT_BOARD,
  itemWorldAabb,
  type Aabb,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import * as realBank from '@/bank/client.ts';
import type { ToolDragPayload } from '@/scene/toolDrop.ts';
import { toolBox, toolBoxCentreOf } from './attach.ts';
import type { ToolAddPlan } from './autoPlace.ts';

// Plain copy: a namespace shows the mocked exports once mock.module patched the loaded module.
const realBankExports = { ...realBank };

/** What the bank answers for the rail resized by its `strapWidth` param: 200 mm wide instead of 120. */
const WIDE_VARIANT: VariantResponse = {
  glbUrl: '/bank/assets/glb/wide.glb',
  bboxMm: { min: { x: -100, y: -20, z: 0 }, max: { x: 100, y: 20, z: 40 } },
  dimsMm: { x: 200, y: 40, z: 40 },
  footprint: { cells: [{ dCol: 0, dRow2: 0 }], cols: 1, rows: 1 },
  mountingCells: [{ dCol: 0, dRow2: 0 }],
  paramHash: 'wide',
  params: { strapWidth: 60 },
  cached: true,
};
const variantRequests: string[] = [];
mock.module('@/bank/client.ts', () => ({
  ...realBankExports,
  requestVariant: async (elementId: string) => {
    variantRequests.push(elementId);
    return WIDE_VARIANT;
  },
}));

const { planToolAdd } = await import('./autoPlace.ts');

const board = { ...DEFAULT_BOARD, cols: 30, rows: 30 };
const size = boardSizeMm(board);
const MIDDLE = { x: size.width / 2, y: size.height / 2 };

const RAIL = makeElement({
  id: 'rail',
  ru: 'Рейка',
  en: 'Rail',
  category: 'holders/screwdrivers',
  dims: [120, 40, 40],
  fitsTool: [{ toolClass: 'screwdriver', capacity: 3 }],
});
const HOOK = makeElement({
  id: 'tape-hook',
  ru: 'Крюк',
  en: 'Hook',
  category: 'hooks/tape',
  dims: [40, 40, 50],
  fitsTool: [{ toolClass: 'tape-measure', capacity: 1 }],
});
const bank = new Map([
  [RAIL.id, RAIL],
  [HOOK.id, HOOK],
]);

const SCREWDRIVER: ToolDragPayload = {
  toolClass: 'screwdriver',
  label: 'Screwdriver',
  dimsMm: { x: 28, y: 210, z: 28 },
};
const PLIERS: ToolDragPayload = {
  toolClass: 'pliers',
  label: 'Pliers',
  dimsMm: { x: 75, y: 180, z: 25 },
};

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

function wallWith(...items: WallItem[]): Wall {
  return { ...createEmptyWall('w', 'W', board), items };
}

/** Plans an add and applies it; fails the test when there was no room. */
function add(
  wall: Wall,
  payload: ToolDragPayload,
  reference = MIDDLE,
): { wall: Wall; plan: Exclude<ToolAddPlan, { kind: 'no-room' | 'refused' }> } {
  const plan = planToolAdd(wall, bank, payload, reference);
  if (plan.kind === 'no-room' || plan.kind === 'refused')
    throw new Error(`expected a spot, got ${plan.kind}`);
  return {
    wall: plan.ops.reduce((current, op) => applyOp(current, op).wall, wall),
    plan,
  };
}

function itemById(wall: Wall, id: string): WallItem {
  const found = wall.items.find((item) => item.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

/** World box of a wall item's solid: the holder's bank bbox, or the tool's drawn box. */
function boxOf(item: WallItem, wall: Wall): Aabb {
  if (item.kind === 'holder') {
    const spec = bank.get(item.bankId ?? '');
    if (!spec) throw new Error('unknown holder');
    return itemWorldAabb(spec.bboxMm, item.pose);
  }
  const dims = toolBox(item, wall);
  const centre = toolBoxCentreOf(item, wall);
  return itemWorldAabb(
    {
      min: {
        x: centre.x - dims.x / 2,
        y: centre.y - dims.y / 2,
        z: centre.z - dims.z / 2,
      },
      max: {
        x: centre.x + dims.x / 2,
        y: centre.y + dims.y / 2,
        z: centre.z + dims.z / 2,
      },
    },
    item.pose,
  );
}

function overlap2d(a: Aabb, b: Aabb): boolean {
  return a.min.x < b.max.x && b.min.x < a.max.x && a.min.y < b.max.y && b.min.y < a.max.y;
}

function insideBoard(box: Aabb): boolean {
  return box.min.x >= 0 && box.min.y >= 0 && box.max.x <= size.width && box.max.y <= size.height;
}

describe('planToolAdd: hanging on a holder', () => {
  test('a screwdriver goes on the compatible rail however far the view centre is from it', () => {
    const wall = wallWith(holder('rail', 'rail', 6, 10));
    const { wall: after, plan } = add(wall, SCREWDRIVER, { x: 553, y: -172 });
    expect(plan.kind).toBe('hung');
    const tool = itemById(after, plan.itemId);
    expect(tool.parentId).toBe('rail');
    expect(tool.slot).toBeDefined();
  });

  test('the nearest compatible holder wins, an incompatible one next to the reference is ignored', () => {
    const near = holder('hook', 'tape-hook', 15, 15);
    const far = holder('rail', 'rail', 4, 4);
    const wall = wallWith(near, far);
    const { wall: after, plan } = add(wall, SCREWDRIVER, near.pose);
    expect(plan.kind).toBe('hung');
    expect(itemById(after, plan.itemId).parentId).toBe('rail');
  });

  test('four screwdrivers on a rail of three: three hang on distinct slots, the fourth lies free inside the board', () => {
    let wall = wallWith(holder('rail', 'rail', 6, 10));
    const plans: { id: string; kind: string }[] = [];
    for (let n = 0; n < 4; n += 1) {
      const result = add(wall, SCREWDRIVER, { x: 553, y: -172 });
      wall = result.wall;
      plans.push({ id: result.plan.itemId, kind: result.plan.kind });
    }
    expect(plans.map((entry) => entry.kind)).toEqual(['hung', 'hung', 'hung', 'free']);
    const slots = plans.slice(0, 3).map((entry) => itemById(wall, entry.id).slot);
    expect(new Set(slots).size).toBe(3);
    const free = itemById(wall, plans[3]!.id);
    expect(free.parentId).toBeUndefined();
    const freeBox = boxOf(free, wall);
    expect(insideBoard(freeBox)).toBe(true);
    for (const other of wall.items.filter((item) => item.id !== free.id)) {
      expect(overlap2d(freeBox, boxOf(other, wall))).toBe(false);
    }
    expect(checkWall(wall).filter((warning) => warning.code === 'out_of_board')).toEqual([]);
  });

  test('a hung tool does not land on a free tool already standing where its slot is', () => {
    const wall = wallWith(holder('rail', 'rail', 6, 10));
    const first = add(wall, SCREWDRIVER);
    const hungAt = itemById(first.wall, first.plan.itemId).pose;
    const blocker: WallItem = {
      id: 'blocker',
      kind: 'tool',
      toolClass: 'pliers',
      modelRefId: 'blockerModel',
      pose: { ...hungAt, rotX: 0, rotY: 0, rotZ: 0 },
      params: {},
      source: { type: 'manual' },
      locked: false,
    };
    const withBlocker: Wall = {
      ...wall,
      models: [
        {
          id: 'blockerModel',
          label: 'blocker',
          status: 'chosen',
          source: { type: 'library', by: 'preset' },
          dimensionsMm: { x: 10, y: 10, z: 10 },
        },
      ],
      items: [...wall.items, blocker],
    };
    const second = add(withBlocker, SCREWDRIVER);
    const tool = itemById(second.wall, second.plan.itemId);
    expect(overlap2d(boxOf(tool, second.wall), boxOf(blocker, second.wall))).toBe(false);
  });
});

describe('planToolAdd: free spots', () => {
  test('with no compatible holder every tool gets its own spot inside the board', () => {
    let wall = wallWith(holder('hook', 'tape-hook', 15, 15));
    const ids: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const result = add(wall, n % 2 === 0 ? PLIERS : SCREWDRIVER, {
        x: 553,
        y: -172,
      });
      expect(result.plan.kind).toBe('free');
      wall = result.wall;
      ids.push(result.plan.itemId);
    }
    const poses = ids.map((id) => `${itemById(wall, id).pose.x},${itemById(wall, id).pose.y}`);
    expect(new Set(poses).size).toBe(4);
    const items = wall.items;
    for (const [index, item] of items.entries()) {
      const box = boxOf(item, wall);
      expect(insideBoard(box)).toBe(true);
      for (const other of items.slice(index + 1)) {
        expect(overlap2d(box, boxOf(other, wall))).toBe(false);
      }
    }
    expect(checkWall(wall)).toEqual([]);
  });

  test('the spot nearest to the reference wins, next to what is already there', () => {
    const wall = wallWith();
    const first = add(wall, PLIERS, MIDDLE);
    const second = add(first.wall, PLIERS, MIDDLE);
    const a = boxOf(itemById(second.wall, first.plan.itemId), second.wall);
    const b = boxOf(itemById(second.wall, second.plan.itemId), second.wall);
    const gapX = Math.max(a.min.x - b.max.x, b.min.x - a.max.x);
    const gapY = Math.max(a.min.y - b.max.y, b.min.y - a.max.y);
    expect(Math.max(gapX, gapY)).toBeLessThan(30);
  });

  test('a free tool keeps clear of a holder that does not take it, even with the reference on that holder', () => {
    const hook = holder('hook', 'tape-hook', 15, 15);
    const wall = wallWith(hook);
    const { wall: after, plan } = add(wall, SCREWDRIVER, hook.pose);
    expect(plan.kind).toBe('free');
    expect(overlap2d(boxOf(itemById(after, plan.itemId), after), boxOf(hook, after))).toBe(false);
  });

  test('a holder that left the bank index still keeps tools off the spot the scene draws it on', () => {
    const gone = holder('gone', 'removed-from-bank', 15, 15);
    const wall = wallWith(gone);
    const { wall: after, plan } = add(wall, SCREWDRIVER, gone.pose);
    expect(plan.kind).toBe('free');
    const box = boxOf(itemById(after, plan.itemId), after);
    // The scene draws a holder without a known element as a 30 x 30 mm placeholder on its origin.
    const placeholder = { x: gone.pose.x - 15, y: gone.pose.y - 15, size: 30 };
    expect(
      box.min.x < placeholder.x + placeholder.size &&
        placeholder.x < box.max.x &&
        box.min.y < placeholder.y + placeholder.size &&
        placeholder.y < box.max.y,
    ).toBe(false);
  });

  test('a holder resized by its params keeps tools off the box the scene draws', async () => {
    const wide: WallItem = { ...holder('wide', 'rail', 15, 15), params: { strapWidth: 60 } };
    const wall = wallWith(wide);
    // The first plan asks the bank for the resized model (as the scene does); once it has arrived, footprints use it.
    planToolAdd(wall, bank, PLIERS, wide.pose);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(variantRequests).toEqual(['rail']);
    const { wall: after, plan } = add(wall, PLIERS, wide.pose);
    expect(plan.kind).toBe('free');
    const drawn = itemWorldAabb(WIDE_VARIANT.bboxMm, wide.pose);
    expect(overlap2d(boxOf(itemById(after, plan.itemId), after), drawn)).toBe(false);
  });

  test('says there is no room when the board cannot take the tool', () => {
    const tiny = { ...board, cols: 3, rows: 3 };
    const wall = createEmptyWall('w', 'W', tiny);
    expect(planToolAdd(wall, bank, SCREWDRIVER, { x: 10, y: 10 }).kind).toBe('no-room');
  });
});

// Bun keeps module mocks for the rest of the process: hand the real module back to later test files.
afterAll(() => {
  mock.module('@/bank/client.ts', () => realBankExports);
});
