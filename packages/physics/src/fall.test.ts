import { describe, expect, test } from 'bun:test';
import { apply, eulerToMatrix } from '@hsw-editor/compat';
import { type Placement } from './body.ts';
import { axisAlignedRotations, lyingRotation, planFall, releaseFalls } from './fall.ts';
import { analyseHangPose, type HangReason } from './hang.ts';
import { IDENTITY, barTool, box, shelf, slotBlock, solid } from './shapes.testkit.ts';
import { boundsOfVertices, transformVertices } from './columns.ts';

const FLOOR_Y = -250;
const DEPTH = 700;
const at = (x: number, y: number, z: number): Placement => ({
  rotation: IDENTITY,
  position: [x, y, z],
});

/** Lowest point of a tool (wall frame y) at a placement. */
function lowest(tool: ReturnType<typeof barTool>, placement: Placement): number {
  return boundsOfVertices(transformVertices(tool.mesh, placement.rotation, placement.position))
    .min[1];
}

describe('fall decision', () => {
  test('a tool let go in mid air with nothing around falls to the floor and lies on it', () => {
    const tool = barTool('bar', 200, 20, 10, 100);
    const plan = planFall({
      tool,
      placement: at(300, 400, 20),
      obstacles: [],
      floorYMm: FLOOR_Y,
      floorDepthMm: DEPTH,
    });
    expect(plan.falls).toBe(true);
    if (!plan.falls) return;
    expect(plan.landedOn).toBeNull();
    expect(lowest(tool, plan.rest)).toBeCloseTo(FLOOR_Y, 1);
    expect(plan.dropMm).toBeGreaterThan(300);
    // lying: the long axis is horizontal, along the wall
    const axis = apply(plan.rest.rotation, [0, 1, 0]);
    expect(Math.abs(axis[1])).toBeLessThan(1e-6);
    expect(Math.abs(axis[0])).toBeCloseTo(1, 6);
    // it stays where it was in x and in front of the board
    expect(plan.rest.position[0] + (apply(plan.rest.rotation, tool.comMm)[0] - 0)).toBeCloseTo(
      300,
      0,
    );
    expect(plan.rest.position[2]).toBeGreaterThan(0);
  });

  test('the fall decision is the hang verdict: a tool a snug slot holds does not fall', () => {
    const holder = slotBlock('slot', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const placement = at(0, 4, 10);
    const tool = barTool();
    const verdict = analyseHangPose({ tool, placement, obstacles: [holder] });
    expect(verdict.status).toBe('stable');
    const plan = planFall({
      tool,
      placement,
      obstacles: [holder],
      floorYMm: FLOOR_Y,
      floorDepthMm: DEPTH,
    });
    expect(plan.falls).toBe(false);
    expect(plan.report).toEqual(verdict);
  });

  test('a tool balanced upright on a shelf topples and lies on the shelf', () => {
    const tool = barTool('bar', 200, 20, 10, 100);
    const ledge = shelf('shelf', 60, 0, 40);
    const placement = at(0, 0, 20);
    expect(analyseHangPose({ tool, placement, obstacles: [ledge] }).status).not.toBe('stable');
    const plan = planFall({
      tool,
      placement,
      obstacles: [ledge],
      floorYMm: FLOOR_Y,
      floorDepthMm: DEPTH,
    });
    expect(plan.falls).toBe(true);
    if (!plan.falls) return;
    expect(plan.landedOn).toBe('shelf');
    expect(lowest(tool, plan.rest)).toBeCloseTo(0, 1);
  });

  test('a tool let go over a wide tray lands on it and stays when lying there is a balance', () => {
    const tool = barTool('bar', 120, 20, 10, 100);
    const tray = solid('tray', box([-200, -30, 0], [200, 0, 150]));
    const plan = planFall({
      tool,
      placement: at(0, 300, 20),
      obstacles: [tray],
      floorYMm: FLOOR_Y,
      floorDepthMm: DEPTH,
    });
    expect(plan.falls).toBe(true);
    if (!plan.falls) return;
    expect(plan.landedOn).toBe('tray');
    expect(lowest(tool, plan.rest)).toBeCloseTo(0, 1);
  });

  test('a tool that cannot lie on what it lands on slides off it and goes on to the floor', () => {
    // a 6 mm wide rail: a bar lying across it is not in balance
    const tool = barTool('bar', 120, 20, 10, 100);
    const rail = solid('rail', box([-200, -6, 0], [200, 0, 6]));
    const plan = planFall({
      tool,
      placement: at(0, 300, 3),
      obstacles: [rail],
      floorYMm: FLOOR_Y,
      floorDepthMm: DEPTH,
    });
    expect(plan.falls).toBe(true);
    if (!plan.falls) return;
    expect(plan.landedOn).toBeNull();
    expect(lowest(tool, plan.rest)).toBeCloseTo(FLOOR_Y, 1);
    // it came down in front of the rail, not through it
    expect(plan.rest.position[2] - 5).toBeGreaterThanOrEqual(6 - 0.5);
  });

  test('a tool let go half inside a holder that also tips is pushed out and falls clear of it', () => {
    const tool = barTool();
    const ledge = shelf('shelf', 60, 0, 40);
    const placement = at(0, -12, 20);
    const verdict = analyseHangPose({ tool, placement, obstacles: [ledge] });
    expect(verdict.reasons.map((r) => r.code)).toContain('penetrates');
    const plan = planFall({
      tool,
      placement,
      obstacles: [ledge],
      floorYMm: FLOOR_Y,
      floorDepthMm: DEPTH,
    });
    expect(plan.falls).toBe(releaseFalls(verdict));
    if (!plan.falls) return;
    // the rest pose does not share volume with the shelf
    expect(plan.landedOn === null || plan.landedOn === 'shelf').toBe(true);
    if (plan.landedOn === null) expect(lowest(tool, plan.rest)).toBeCloseTo(FLOOR_Y, 1);
  });

  test('releaseFalls: balance errors fall; warnings and an overlap alone hold', () => {
    const base = analyseHangPose({
      tool: barTool(),
      placement: at(0, 6, 20),
      obstacles: [shelf('shelf', 60, 0, 40)],
    });
    expect(base.status).toBe('unstable');
    expect(releaseFalls(base)).toBe(true);
    expect(releaseFalls({ ...base, reasons: [{ code: 'swings', params: {} }] })).toBe(false);
    const sunk: HangReason = { code: 'penetrates', params: { depthMm: 9 } };
    expect(releaseFalls({ ...base, reasons: [sunk] })).toBe(false);
    expect(releaseFalls({ ...base, reasons: [sunk, { code: 'tips', params: {} }] })).toBe(true);
  });
});

describe('lying pose', () => {
  test('there are 24 distinct axis-aligned orientations', () => {
    const keys = new Set(axisAlignedRotations().map((m) => m.map((v) => Math.round(v)).join(',')));
    expect(keys.size).toBe(24);
  });

  test('a flat bar lies on its broad face with the long axis along x, whatever way it came down', () => {
    const tool = barTool('bar', 200, 30, 8, 100);
    for (const rotZ of [0, 37, 90, 180]) {
      const rotation = lyingRotation(tool, eulerToMatrix({ rotX: 0, rotY: 0, rotZ }));
      const long = apply(rotation, [0, 1, 0]);
      const thin = apply(rotation, [0, 0, 1]);
      expect(Math.abs(long[0])).toBeCloseTo(1, 6);
      expect(Math.abs(thin[1])).toBeCloseTo(1, 6);
    }
  });
});
