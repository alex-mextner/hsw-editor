import { describe, expect, test } from 'bun:test';
import type { HolderSpec, ToolInterface } from '@hsw-editor/compat';
import { type Pose, type Wall, WallItemSchema, createEmptyWall } from '@hsw-editor/core';
import { loadLimitG, planSeatAll, samePose, seatOps, seatSlotInput } from './seatPlan.ts';

const SEATED: Pose = { x: 12.5, y: 31, z: 15, rotX: 0, rotY: 90, rotZ: 180 };

function wallOf(items: Record<string, unknown>[]): Wall {
  return {
    ...createEmptyWall('w', 'W'),
    items: items.map((item) => WallItemSchema.parse({ source: { type: 'agent' }, ...item })),
  };
}

const hover = (x: number): Pose => ({ x, y: 300, z: 40, rotX: 0, rotY: 0, rotZ: 0 });

describe('samePose', () => {
  test('compares every component within 0.01', () => {
    expect(samePose(SEATED, { ...SEATED, x: 12.504 })).toBe(true);
    expect(samePose(SEATED, { ...SEATED, rotY: 91 })).toBe(false);
  });
});

describe('seatOps', () => {
  test('rotates, then moves, the tool', () => {
    expect(seatOps('t', SEATED)).toEqual({
      type: 'batch',
      label: 'seat',
      ops: [
        { type: 'rotateItem', id: 't', rotX: 0, rotY: 90, rotZ: 180 },
        { type: 'moveItem', id: 't', to: { x: 12.5, y: 31, z: 15 } },
      ],
    });
  });
});

describe('seatSlotInput', () => {
  const rail: HolderSpec = {
    id: 'rail',
    category: 'holders/screwdrivers',
    fitsTool: [{ toolClass: 'screwdriver', capacity: 3 }],
    bboxMm: { min: { x: -60, y: -20, z: 0 }, max: { x: 60, y: 20, z: 30 } },
  };
  const driver: ToolInterface = {
    toolClass: 'screwdriver',
    lengthMm: 210,
    hang: null,
    maxSection: { w: 28, t: 28, r: 20 },
    dims: { shaftDiameter: 6 },
  };
  const slot = { index: 1, anchor: [-5, 20, 10] as [number, number, number] };
  const upright: Pose = { x: 100, y: 50, z: 0, rotX: 0, rotY: 0, rotZ: 0 };

  test('puts the anchor in the wall frame, the window at most 14 mm, and the tool down tip first', () => {
    const input = seatSlotInput(upright, rail, slot, 3, { score: 0.8 }, driver);
    expect(input?.anchor).toEqual([95, 70, 10]);
    expect(input?.halfWidthMm).toBeLessThanOrEqual(14);
    expect(input?.tipDown).toBe(true);
    expect(input?.compatScore).toBe(0.8);
    expect(input?.maxLoadG).toBe(loadLimitG(driver, rail));
  });

  test('a rotated holder has no seat input', () => {
    expect(seatSlotInput({ ...upright, rotZ: 90 }, rail, slot, 3, { score: 1 }, driver)).toBeNull();
  });
});

describe('planSeatAll', () => {
  const wall = wallOf([
    { id: 'h', kind: 'holder', bankId: 'rail' },
    { id: 'a', kind: 'tool', bankId: 'tool', parentId: 'h', slot: 0, pose: hover(10) },
    { id: 'b', kind: 'tool', bankId: 'tool', parentId: 'h', slot: 1, pose: hover(50) },
    {
      id: 'locked',
      kind: 'tool',
      bankId: 'tool',
      parentId: 'h',
      slot: 2,
      locked: true,
      pose: hover(90),
    },
    { id: 'nums', kind: 'tool', bankId: 'tool', parentId: 'h', pose: hover(130) },
    { id: 'loose', kind: 'tool', bankId: 'tool', pose: hover(170) },
  ]);

  test('seats hung, slotted, unlocked tools as one list of ops and sorts out the rest', async () => {
    const plan = await planSeatAll(wall, async (tool) =>
      tool.id === 'a' ? { ...SEATED, x: 1 } : { ...SEATED, x: 2 },
    );
    expect(plan.seated).toEqual(['a', 'b']);
    expect(plan.unslotted).toEqual(['nums']);
    expect(plan.kept).toEqual([]);
    expect(plan.ops).toEqual([
      ...seatOps('a', { ...SEATED, x: 1 }).ops,
      ...seatOps('b', { ...SEATED, x: 2 }).ops,
    ]);
  });

  test('a tool already at its seat is unchanged, one without a seat is kept, a throwing seat is kept and reported', async () => {
    const failures: string[] = [];
    const plan = await planSeatAll(
      wall,
      async (tool) => {
        if (tool.id === 'a') return hover(10);
        throw new Error('model unreadable');
      },
      (id) => failures.push(id),
    );
    expect(plan.unchanged).toEqual(['a']);
    expect(plan.kept).toEqual(['b']);
    expect(failures).toEqual(['b']);
    expect(plan.ops).toEqual([]);
  });

  test('tools still waiting their turn are hidden from the one being seated, the done ones are visible at their new pose', async () => {
    const seen: Record<string, Record<string, number>> = {};
    await planSeatAll(wall, async (tool, view) => {
      seen[tool.id] = Object.fromEntries(
        view.items.filter((i) => i.kind === 'tool').map((i) => [i.id, i.pose.x]),
      );
      return { ...SEATED, x: tool.id === 'a' ? 1 : 2 };
    });
    // 'a' goes first: 'b' is still waiting; the locked tool and the one without a slot are real obstacles from the start
    expect(Object.keys(seen['a'] ?? {}).sort()).toEqual(['a', 'locked', 'loose', 'nums']);
    expect(Object.keys(seen['b'] ?? {}).sort()).toEqual(['a', 'b', 'locked', 'loose', 'nums']);
    expect(seen['b']?.['a']).toBe(1);
  });

  test('a second look puts a tool back where it began when the others it was hidden from no longer move it', async () => {
    let calls = 0;
    const plan = await planSeatAll(wall, async (tool) => {
      calls += 1;
      // first pass: a moves, b stays (unchanged); second pass: a is sent back to where it started
      if (tool.id === 'a') return calls === 1 ? SEATED : hover(10);
      return hover(50);
    });
    expect(plan.seated).toEqual([]);
    expect(plan.ops).toEqual([]);
    expect(plan.unchanged).toEqual(['b']);
  });

  test('in the second look a tool sees the poses the earlier ones took in that same look', async () => {
    const three = wallOf([
      { id: 'h', kind: 'holder', bankId: 'rail' },
      { id: 'a', kind: 'tool', bankId: 'tool', parentId: 'h', slot: 0, pose: hover(10) },
      { id: 'b', kind: 'tool', bankId: 'tool', parentId: 'h', slot: 1, pose: hover(50) },
      { id: 'c', kind: 'tool', bankId: 'tool', parentId: 'h', slot: 2, pose: hover(90) },
    ]);
    const bSaw: (number | undefined)[] = [];
    let aCalls = 0;
    await planSeatAll(three, async (tool, view) => {
      if (tool.id === 'c') return hover(90);
      if (tool.id === 'b') {
        bSaw.push(view.items.find((i) => i.id === 'a')?.pose.x);
        return { ...SEATED, x: 2 };
      }
      aCalls += 1;
      return { ...SEATED, x: aCalls === 1 ? 1 : 3 };
    });
    // first look: a was already at x=1 when b was seated; second look: a moved to x=3 before b looked again
    expect(bSaw).toEqual([1, 3]);
  });
});
