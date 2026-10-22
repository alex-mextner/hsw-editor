import { describe, expect, test } from 'bun:test';
import { applyOp, checkWall, OpError, type Op, type Wall, type WallItem } from '@hsw-editor/core';
import {
  autoAttach,
  auditHangs,
  evaluateHolders,
  hungTools,
  planAddHung,
  planDetach,
  planHang,
  planMoveHolder,
  planRemoveHolder,
  planRotateHolder,
  resolveDrop,
  unmountedTools,
} from './attach.ts';
import { contentOf, contextFor, holder, TOOLS, toolItem, wallWith } from './fixtures/testing.ts';
import { apply, eulerToMatrix, matrixToEuler } from './rotation.ts';

const RAIL = 'refit-screwdriver-rail-3';
const CRADLE = 'refit-tape-measure-cradle';
const FORK = 'hammer-fork-handlewidth20';

/** Rail, tape cradle and hammer fork side by side, plus free tools to hang. */
function room(extra: readonly WallItem[] = []): Wall {
  return wallWith([
    holder('rail', RAIL, 5, 10),
    holder('cradle', CRADLE, 12, 10),
    holder('fork', FORK, 20, 10),
    toolItem('drv1', 'screwdriver'),
    toolItem('drv2', 'screwdriver'),
    toolItem('drv3', 'screwdriver'),
    toolItem('drv4', 'screwdriver'),
    toolItem('tape', 'tape-measure'),
    toolItem('ham', 'hammer'),
    ...extra,
  ]);
}

function find(wall: Wall, id: string): WallItem {
  const item = wall.items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
}

function apply1(wall: Wall, op: Op): Wall {
  return applyOp(wall, op).wall;
}

function dropOn(wall: Wall, toolId: string, holderId: string): Wall {
  const holderItem = find(wall, holderId);
  const { resolution, op } = autoAttach(contextFor(wall), find(wall, toolId), {
    x: holderItem.pose.x,
    y: holderItem.pose.y,
  });
  if (resolution.kind !== 'attach' || op === null)
    throw new Error(`${toolId} did not attach: ${resolution.kind}`);
  return apply1(wall, op);
}

describe('three tools hang on matching holders', () => {
  test('each tool snaps onto the holder meant for it', () => {
    let wall = room();
    wall = dropOn(wall, 'drv1', 'rail');
    wall = dropOn(wall, 'tape', 'cradle');
    wall = dropOn(wall, 'ham', 'fork');
    expect(find(wall, 'drv1').parentId).toBe('rail');
    expect(find(wall, 'tape').parentId).toBe('cradle');
    expect(find(wall, 'ham').parentId).toBe('fork');
    expect(checkWall(wall).filter((w) => w.code !== 'out_of_board')).toEqual([]);
  });

  test('a screwdriver stands tip down in a rail hole: tip below the rail top, handle above', () => {
    const wall = dropOn(room(), 'drv1', 'rail');
    const rail = find(wall, 'rail');
    const drv = find(wall, 'drv1');
    const tool = TOOLS['screwdriver'];
    if (tool === undefined) throw new Error('no tool');
    const matrix = eulerToMatrix(drv.pose);
    const tip = apply(matrix, [0, tool.lengthMm, 0]);
    const butt = apply(matrix, [0, 0, 0]);
    const top = rail.pose.y; // rail bbox.max.y === 0: the hole opens at the anchor height
    expect(drv.pose.y + tip[1]).toBeLessThan(top);
    expect(drv.pose.y + butt[1]).toBeGreaterThan(top);
    expect(drv.pose.rotZ).toBe(180);
    expect(drv.pose.rotX).toBe(0);
    expect(drv.slot).toBe(1); // dropped on the holder centre: the middle of three slots
  });

  test('a tape measure rests upright in the cradle, against the back plate', () => {
    const wall = dropOn(room(), 'tape', 'cradle');
    const cradle = find(wall, 'cradle');
    const tape = find(wall, 'tape');
    expect(tape.pose.rotZ).toBe(0);
    expect(tape.pose.x).toBeCloseTo(cradle.pose.x, 6);
    expect(tape.pose.z).toBeCloseTo(4 + 30, 6); // plate + half the thickness
  });

  test('a saw hangs from its hole on a hook, working end down; a cable on its loop, working end up', () => {
    const hooks = wallWith([
      holder('hook', 'j-hook-reach100-bardiameter10', 8, 8),
      holder('hook2', 'j-hook-reach100-bardiameter10', 14, 8),
    ]);
    const withTools: Wall = {
      ...hooks,
      items: [...hooks.items, toolItem('saw', 'saw'), toolItem('cab', 'cable')],
    };
    const sawHung = dropOn(withTools, 'saw', 'hook');
    expect(find(sawHung, 'saw').pose.rotZ).toBe(180); // hole near the butt: butt up, blade hangs down
    const cableHung = dropOn(withTools, 'cab', 'hook2');
    expect(find(cableHung, 'cab').pose.rotZ).toBe(0); // loop at the working end: working end up, loop on the bar
  });
});

describe('refusal of unsuitable mounts', () => {
  test('a screwdriver dropped on the tape cradle is refused with the reason, and nothing changes', () => {
    const wall = room();
    const cradle = find(wall, 'cradle');
    const result = autoAttach(contextFor(wall), find(wall, 'drv1'), {
      x: cradle.pose.x,
      y: cradle.pose.y,
    });
    expect(result.op).toBeNull();
    expect(result.resolution).toMatchObject({ kind: 'refuse', holderId: 'cradle' });
    if (result.resolution.kind !== 'refuse') throw new Error('expected refusal');
    expect(result.resolution.compat.reasons[0]?.code).toBe('class_mismatch');
  });

  test('a free drop far from every holder stays free', () => {
    expect(resolveDrop(contextFor(room()), find(room(), 'drv1'), { x: 20, y: 700 }).kind).toBe(
      'free',
    );
  });

  test('a drop inside an incompatible holder is refused unless a compatible slot is within reach', () => {
    // The cradle overlaps the rail's right end: slot 2 of the rail is ~32 mm from (180, 250) and ~56 mm from (205, 250).
    const wall = wallWith([
      holder('rail', RAIL, 5, 10),
      holder('cradle', CRADLE, 8, 10),
      toolItem('drv', 'screwdriver'),
    ]);
    const ctx = contextFor(wall);
    const near = resolveDrop(ctx, find(wall, 'drv'), { x: 180, y: 250 });
    expect(near).toMatchObject({ kind: 'attach', target: { holderId: 'rail', slot: 2 } });
    const far = resolveDrop(ctx, find(wall, 'drv'), { x: 205, y: 250 });
    expect(far).toMatchObject({ kind: 'refuse', holderId: 'cradle' });
  });

  test('the fourth screwdriver is refused by a full 3-slot rail', () => {
    let wall = room();
    for (const id of ['drv1', 'drv2', 'drv3']) wall = dropOn(wall, id, 'rail');
    const rail = find(wall, 'rail');
    const result = autoAttach(contextFor(wall), find(wall, 'drv4'), {
      x: rail.pose.x,
      y: rail.pose.y,
    });
    expect(result.op).toBeNull();
    expect(result.resolution).toMatchObject({ kind: 'refuse', holderId: 'rail' });
    if (result.resolution.kind === 'refuse')
      expect(result.resolution.compat.reasons[0]?.code).toBe('slots_full');
  });

  test('evaluateHolders tells the UI which holders to light up for a dragged tool', () => {
    const wall = room();
    const verdicts = Object.fromEntries(
      evaluateHolders(contextFor(wall), find(wall, 'drv1')).map((e) => [e.holderId, e.compat.ok]),
    );
    expect(verdicts).toEqual({ rail: true, cradle: false, fork: false });
  });
});

describe('tall holders', () => {
  test('a drop anywhere on a compatible tall holder snaps to its slot, even 160 mm below the hole', () => {
    const wall = wallWith([
      holder('pocket', 'refit-wrench-pocket', 6, 12),
      toolItem('wr', 'wrench'),
    ]);
    const pocket = find(wall, 'pocket');
    const resolution = resolveDrop(contextFor(wall), find(wall, 'wr'), {
      x: pocket.pose.x,
      y: pocket.pose.y - 150,
    });
    expect(resolution).toMatchObject({ kind: 'attach', target: { holderId: 'pocket', slot: 0 } });
  });

  test('an incompatible holder nearby does not steal a drop made inside the compatible one', () => {
    const wall = wallWith([
      holder('pocket', 'refit-wrench-pocket', 6, 12),
      holder('cradle', CRADLE, 9, 4),
      toolItem('wr', 'wrench'),
    ]);
    const pocket = find(wall, 'pocket');
    const resolution = resolveDrop(contextFor(wall), find(wall, 'wr'), {
      x: pocket.pose.x,
      y: pocket.pose.y - 150,
    });
    expect(resolution.kind).toBe('attach');
  });
});

describe('slots and uniqueness', () => {
  test('three screwdrivers take three distinct slots, left to right by drop position', () => {
    let wall = room();
    for (const id of ['drv1', 'drv2', 'drv3']) wall = dropOn(wall, id, 'rail');
    const slots = ['drv1', 'drv2', 'drv3'].map((id) => find(wall, id).slot);
    expect(new Set(slots).size).toBe(3);
    expect(wall.items.filter((i) => i.parentId === 'rail')).toHaveLength(3);
    expect(checkWall(wall).map((w) => w.code)).not.toContain('slot_collision');
  });

  test('no tool is ever attached to two mounts: every tool has exactly one parent and (parent, slot) is unique', () => {
    let wall = room();
    for (const id of ['drv1', 'drv2', 'drv3', 'drv4']) {
      const target = find(wall, 'rail');
      const result = autoAttach(contextFor(wall), find(wall, id), {
        x: target.pose.x,
        y: target.pose.y,
      });
      if (result.op !== null) wall = apply1(wall, result.op);
    }
    for (const id of ['tape', 'ham']) {
      const target = find(wall, id === 'tape' ? 'cradle' : 'fork');
      const result = autoAttach(contextFor(wall), find(wall, id), {
        x: target.pose.x,
        y: target.pose.y,
      });
      if (result.op !== null) wall = apply1(wall, result.op);
    }
    const seen = new Set<string>();
    for (const item of wall.items.filter((i) => i.kind === 'tool' && i.parentId !== undefined)) {
      const key = `${item.parentId}#${item.slot}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(find(wall, 'drv4').parentId).toBeUndefined();
  });

  test('the result depends only on the inputs: item order and repeated calls change nothing', () => {
    // Two identical rails equidistant from the drop point: the tie breaks on holder id, never on wall order.
    const base = [
      holder('railB', RAIL, 5, 10),
      holder('railA', RAIL, 5, 12),
      toolItem('drv', 'screwdriver'),
    ];
    const forward = wallWith(base);
    const reversed = wallWith([...base].reverse());
    const at = {
      x: find(forward, 'railB').pose.x,
      y: (find(forward, 'railB').pose.y + find(forward, 'railA').pose.y) / 2,
    };
    const a = resolveDrop(contextFor(forward), find(forward, 'drv'), at);
    const b = resolveDrop(contextFor(reversed), find(reversed, 'drv'), at);
    const c = resolveDrop(contextFor(forward), find(forward, 'drv'), at);
    expect(a.kind).toBe('attach');
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    if (a.kind === 'attach') expect(a.target.holderId).toBe('railA');
  });
});

describe('re-hang', () => {
  test('dragging a hung tool near a second suitable rail re-hangs it; near a cradle it is refused', () => {
    const wall = dropOn(
      wallWith([
        holder('railA', RAIL, 3, 10),
        holder('railB', RAIL, 16, 10),
        holder('cradle', CRADLE, 10, 10),
        toolItem('drv', 'screwdriver'),
      ]),
      'drv',
      'railA',
    );
    const ctx = contextFor(wall);
    const railB = find(wall, 'railB');
    const moved = autoAttach(ctx, find(wall, 'drv'), { x: railB.pose.x, y: railB.pose.y });
    expect(moved.resolution).toMatchObject({ kind: 'attach', target: { holderId: 'railB' } });
    const cradle = find(wall, 'cradle');
    const refused = autoAttach(ctx, find(wall, 'drv'), { x: cradle.pose.x, y: cradle.pose.y });
    expect(refused.resolution.kind).toBe('refuse');
    expect(refused.op).toBeNull();
  });

  test("the tool's own slot counts as free, so dropping it back where it hangs is a no-op", () => {
    const wall = dropOn(room(), 'drv1', 'rail');
    const rail = find(wall, 'rail');
    const drv = find(wall, 'drv1');
    const again = autoAttach(contextFor(wall), drv, { x: rail.pose.x, y: rail.pose.y });
    expect(again.resolution).toMatchObject({
      kind: 'attach',
      target: { holderId: 'rail', slot: 1 },
    });
    if (again.op === null) throw new Error('expected a batch');
    expect(applyOp(wall, again.op).changed).toBe(false);
  });

  test('hang, detach and re-hang batches are invertible and one undo step each', () => {
    const wall = room();
    const rail = find(wall, 'rail');
    const first = autoAttach(contextFor(wall), find(wall, 'drv1'), {
      x: rail.pose.x,
      y: rail.pose.y,
    });
    if (first.op === null) throw new Error('expected hang');
    const hung = applyOp(wall, first.op);
    expect(hung.changed).toBe(true);
    expect(contentOf(applyOp(hung.wall, hung.inverse).wall)).toEqual(contentOf(wall));

    const detach = applyOp(hung.wall, planDetach(find(hung.wall, 'drv1')));
    expect(find(detach.wall, 'drv1').parentId).toBeUndefined();
    expect(find(detach.wall, 'drv1').slot).toBeUndefined();
    expect(contentOf(applyOp(detach.wall, detach.inverse).wall)).toEqual(contentOf(hung.wall));

    const manual = applyOp(
      wall,
      planHang(find(wall, 'drv1'), {
        holderId: 'rail',
        slot: 1,
        compat: { ok: true, score: 1, reasons: [], clearances: [], entryIndex: 0 },
        placement: {
          pose: { x: 10, y: 20, z: 30, rotX: 0, rotY: 0, rotZ: 180 },
          workingEnd: 'down',
        },
        distanceMm: 0,
      }),
    );
    expect(find(manual.wall, 'drv1')).toMatchObject({
      parentId: 'rail',
      slot: 1,
      pose: { x: 10, y: 20, z: 30, rotZ: 180 },
    });
    expect(contentOf(applyOp(manual.wall, manual.inverse).wall)).toEqual(contentOf(wall));
  });

  test('a draft anchored to a cell still lands on the slot, without keeping the cell', () => {
    const wall = room();
    const rail = find(wall, 'rail');
    const draft = toolItem('drv9', 'screwdriver', { cell: { col: 30, row: 3 } });
    const resolution = resolveDrop(contextFor(wall), draft, { x: rail.pose.x, y: rail.pose.y });
    if (resolution.kind !== 'attach') throw new Error('expected attach');
    const added = find(applyOp(wall, planAddHung(draft, resolution.target)).wall, 'drv9');
    expect(added.cell).toBeUndefined();
    expect(added.pose.x).toBeCloseTo(resolution.target.placement.pose.x, 6);
    expect(added.pose.y).toBeCloseTo(resolution.target.placement.pose.y, 6);
  });

  test('adding a new tool already hung inverts to its removal', () => {
    const wall = room();
    const rail = find(wall, 'rail');
    const draft = toolItem('drv9', 'screwdriver');
    const resolution = resolveDrop(contextFor(wall), draft, { x: rail.pose.x, y: rail.pose.y });
    if (resolution.kind !== 'attach') throw new Error('expected attach');
    const added = applyOp(wall, planAddHung(draft, resolution.target));
    expect(find(added.wall, 'drv9')).toMatchObject({
      parentId: 'rail',
      slot: resolution.target.slot,
    });
    expect(contentOf(applyOp(added.wall, added.inverse).wall)).toEqual(contentOf(wall));
  });
});

describe('holders carry and release their tools', () => {
  function hungWall(): Wall {
    let wall = room();
    wall = dropOn(wall, 'drv1', 'rail');
    wall = dropOn(wall, 'drv2', 'rail');
    return dropOn(wall, 'tape', 'cradle');
  }

  test('moving a holder moves its tools by the same vector and leaves others alone; undo restores everything', () => {
    const wall = hungWall();
    const before = ['drv1', 'drv2', 'tape'].map((id) => find(wall, id).pose);
    const op = planMoveHolder(wall, 'rail', { cell: { col: 7, row: 14 } });
    const moved = applyOp(wall, op);
    const rail0 = find(wall, 'rail').pose;
    const rail1 = find(moved.wall, 'rail').pose;
    const dx = rail1.x - rail0.x;
    const dy = rail1.y - rail0.y;
    for (const [index, id] of ['drv1', 'drv2'].entries()) {
      const pose = find(moved.wall, id).pose;
      expect(pose.x).toBeCloseTo((before[index]?.x ?? 0) + dx, 5);
      expect(pose.y).toBeCloseTo((before[index]?.y ?? 0) + dy, 5);
      expect(find(moved.wall, id).parentId).toBe('rail');
    }
    expect(find(moved.wall, 'tape').pose).toEqual(find(wall, 'tape').pose);
    expect(contentOf(applyOp(moved.wall, moved.inverse).wall)).toEqual(contentOf(wall));
  });

  test('rotating a holder orbits and turns its tools rigidly; distances and relative angle are kept', () => {
    const wall = hungWall();
    const rail = find(wall, 'rail');
    const drv = find(wall, 'drv1');
    const radius = Math.hypot(drv.pose.x - rail.pose.x, drv.pose.y - rail.pose.y);
    const rotated = applyOp(wall, planRotateHolder(wall, 'rail', 60));
    const rail1 = find(rotated.wall, 'rail');
    const drv1 = find(rotated.wall, 'drv1');
    expect(rail1.pose.rotZ).toBe(60);
    expect(Math.hypot(drv1.pose.x - rail1.pose.x, drv1.pose.y - rail1.pose.y)).toBeCloseTo(
      radius,
      5,
    );
    expect(drv1.pose.rotZ).toBeCloseTo((drv.pose.rotZ + 60) % 360, 5);
    expect(contentOf(applyOp(rotated.wall, rotated.inverse).wall)).toEqual(contentOf(wall));
  });

  test('a tool hung on a rotated holder matches the same tool carried by rotating the holder', () => {
    const base = wallWith([holder('rail', RAIL, 5, 10), toolItem('drv', 'screwdriver')]);
    const hungThenRotated = applyOp(
      dropOn(base, 'drv', 'rail'),
      planRotateHolder(dropOn(base, 'drv', 'rail'), 'rail', 120),
    ).wall;
    const rotatedThenHung = dropOn(
      applyOp(base, { type: 'rotateItem', id: 'rail', rotZ: 120 }).wall,
      'drv',
      'rail',
    );
    const a = find(hungThenRotated, 'drv').pose;
    const b = find(rotatedThenHung, 'drv').pose;
    for (const key of ['x', 'y', 'z', 'rotX', 'rotY', 'rotZ'] as const)
      expect(a[key]).toBeCloseTo(b[key], 4);
  });

  test('removing a holder detaches its tools first, reports them, and is undone as one step', () => {
    const wall = hungWall();
    const plan = planRemoveHolder(wall, 'rail');
    expect(plan.detached).toEqual(['drv1', 'drv2']);
    const removed = applyOp(wall, plan.op);
    expect(removed.wall.items.some((item) => item.id === 'rail')).toBe(false);
    expect(removed.warnings.map((w) => w.code)).not.toContain('missing_parent');
    expect(unmountedTools(removed.wall).map((item) => item.id)).toEqual(
      expect.arrayContaining(['drv1', 'drv2', 'drv3', 'drv4', 'ham']),
    );
    expect(hungTools(removed.wall, 'rail')).toEqual([]);
    expect(find(removed.wall, 'drv1').pose).toEqual(find(wall, 'drv1').pose);
    expect(contentOf(applyOp(removed.wall, removed.inverse).wall)).toEqual(contentOf(wall));
  });

  test('a locked tool blocks moving or removing its holder instead of being left behind', () => {
    const wall = apply1(hungWall(), { type: 'lock', id: 'drv1', locked: true });
    expect(() => planMoveHolder(wall, 'rail', { cell: { col: 7, row: 14 } })).toThrow(OpError);
    expect(() => planRemoveHolder(wall, 'rail')).toThrow(/locked/);
    expect(() => planRemoveHolder(wall, 'nope')).toThrow(/does not exist/);
  });
});

describe('audit and flags', () => {
  test('a stored hang that no longer fits is reported with the reasons', () => {
    const wall = apply1(room(), { type: 'attachItem', id: 'tape', parentId: 'rail', slot: 0 });
    const audit = auditHangs(contextFor(wall));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ toolId: 'tape', holderId: 'rail' });
    expect(audit[0]?.compat.reasons[0]?.code).toBe('class_mismatch');
  });

  test('a slot beyond the holder capacity is reported although the class fits', () => {
    const wall = apply1(room(), { type: 'attachItem', id: 'drv1', parentId: 'rail', slot: 99 });
    const audit = auditHangs(contextFor(wall));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.compat.reasons).toEqual([
      { code: 'slot_out_of_range', params: { slot: 99, slots: 3 } },
    ]);
  });

  test('only tools can be added hung', () => {
    const wall = room();
    const rail = find(wall, 'rail');
    const resolution = resolveDrop(contextFor(wall), find(wall, 'drv1'), {
      x: rail.pose.x,
      y: rail.pose.y,
    });
    if (resolution.kind !== 'attach') throw new Error('expected attach');
    expect(() => planAddHung(holder('h9', RAIL, 1, 1), resolution.target)).toThrow(/only tools/);
  });

  test('tools without a mount are listed as unmounted', () => {
    expect(unmountedTools(dropOn(room(), 'drv1', 'rail')).map((item) => item.id)).not.toContain(
      'drv1',
    );
    expect(unmountedTools(room()).map((item) => item.id)).toContain('drv1');
  });
});

describe('rotation maths', () => {
  test('euler -> matrix -> euler -> matrix is the identity on a grid of angles', () => {
    for (const rotX of [0, 30, 90, 200, 340]) {
      for (const rotY of [0, 45, 80, 90, 270, 315]) {
        for (const rotZ of [0, 60, 180, 275]) {
          const m = eulerToMatrix({ rotX, rotY, rotZ });
          const again = eulerToMatrix(matrixToEuler(m));
          for (let i = 0; i < 9; i++) expect(again[i]).toBeCloseTo(m[i] ?? 0, 6);
          expect(matrixToEuler(m).rotY).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  test('Rx(90) takes the tool axis out of the wall, Rz(180) turns it downwards', () => {
    const out = apply(eulerToMatrix({ rotX: 90, rotY: 0, rotZ: 0 }), [0, 1, 0]);
    expect(out[2]).toBeCloseTo(1, 9);
    const down = apply(eulerToMatrix({ rotX: 0, rotY: 0, rotZ: 180 }), [0, 1, 0]);
    expect(down[1]).toBeCloseTo(-1, 9);
  });
});

describe('review regressions', () => {
  test('a drop inside a compatible holder wins over a nearer slot of another holder and over an overlapping incompatible one', () => {
    const wall = wallWith([
      holder('pocket', 'refit-wrench-pocket', 6, 12),
      holder('rail', RAIL, 6, 8),
      toolItem('wr', 'wrench'),
    ]);
    const pocket = find(wall, 'pocket');
    const resolution = resolveDrop(contextFor(wall), find(wall, 'wr'), {
      x: pocket.pose.x,
      y: pocket.pose.y - 150,
    });
    expect(resolution).toMatchObject({ kind: 'attach', target: { holderId: 'pocket' } });
  });

  test('moving a holder onto itself changes nothing, tools included', () => {
    const wall = dropOn(room(), 'drv1', 'rail');
    const rail = find(wall, 'rail');
    if (rail.cell === undefined) throw new Error('rail is cell-anchored');
    const op = planMoveHolder(wall, 'rail', { cell: rail.cell });
    expect(applyOp(wall, op).changed).toBe(false);
    expect(applyOp(wall, planRotateHolder(wall, 'rail', rail.pose.rotZ)).changed).toBe(false);
  });

  test('an over-full holder flags only the surplus tool', () => {
    let wall = room();
    for (const id of ['drv1', 'drv2', 'drv3']) wall = dropOn(wall, id, 'rail');
    wall = apply1(wall, { type: 'attachItem', id: 'drv4', parentId: 'rail', slot: 3 });
    expect(auditHangs(contextFor(wall)).map((a) => a.toolId)).toEqual(['drv4']);
  });
});
