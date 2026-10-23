import { describe, expect, test } from 'bun:test';
import { rotationZ } from '@hsw-editor/compat';
import { analyseHangPose } from './hang.ts';
import { IDENTITY, barTool, box, rodZ, shelf, slotBlock, solid, union } from './shapes.testkit.ts';
import type { Placement, ToolBody } from './body.ts';

const upright = (x: number, y: number, z: number): Placement => ({
  rotation: IDENTITY,
  position: [x, y, z],
});
const codes = (r: { reasons: { code: string }[] }): string[] => r.reasons.map((x) => x.code);

describe('hang stability', () => {
  test('a bar held by a snug slot is stable under a bump and a pull', () => {
    const holder = slotBlock('slot', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const report = analyseHangPose({
      tool: barTool(),
      placement: upright(0, 4, 10),
      obstacles: [holder],
    });
    expect(report.status).toBe('stable');
    expect(report.reasons).toEqual([]);
    expect(report.marginsG.left).toBeGreaterThanOrEqual(0.3);
    expect(report.marginsG.right).toBeGreaterThanOrEqual(0.3);
    expect(report.contactCount).toBeGreaterThan(2);
  });

  test('the same bar standing free on a shelf tips over under a small bump', () => {
    const report = analyseHangPose({
      tool: barTool(),
      placement: upright(0, 0, 20),
      obstacles: [shelf('shelf', 60, 0, 40)],
    });
    expect(codes(report)).toContain('tips');
    expect(report.status).not.toBe('stable');
    expect(report.marginsG.left).toBeLessThan(0.15);
  });

  test('a tool above the holder levitates and says how far', () => {
    const report = analyseHangPose({
      tool: barTool(),
      placement: upright(0, 6, 20),
      obstacles: [shelf('shelf', 60, 0, 40)],
    });
    expect(report.status).toBe('unstable');
    expect(report.score).toBe(0);
    const levitating = report.reasons.find((r) => r.code === 'levitating');
    expect(levitating?.params.gapMm).toBeCloseTo(6, 0);
  });

  test('a tool sunk into the holder is reported as not seated', () => {
    const report = analyseHangPose({
      tool: barTool(),
      placement: upright(0, -12, 20),
      obstacles: [shelf('shelf', 60, 0, 40)],
    });
    expect(codes(report)).toContain('penetrates');
    expect(report.status).toBe('unstable');
  });

  test('a tool hanging by a hole on a peg swings, in proportion to the lever', () => {
    // Bar 20 x 200 with a 10 x 10 hole at y = 185..195, hung on a 3 mm radius peg along Z.
    const mesh = union(
      box([-10, 0, -5], [-5, 200, 5]),
      box([5, 0, -5], [10, 200, 5]),
      box([-5, 0, -5], [5, 185, 5]),
      box([-5, 195, -5], [5, 200, 5]),
    );
    const tool: ToolBody = {
      id: 'holey',
      mesh,
      massG: 100,
      comMm: [0, 100, 0],
      hang: { point: [0, 190, 0], kind: 'hole', diameterMm: 10 },
    };
    const peg = solid('peg', rodZ(0, 0, 3, 0, 60), box([-30, -30, -4], [30, 30, 0]));
    const report = analyseHangPose({ tool, placement: upright(0, 3 - 195, 30), obstacles: [peg] });
    expect(codes(report)).toContain('swings');
    expect(report.swingDeg).toBeGreaterThan(10);
    expect(report.score).toBeLessThan(1);
    // A short lever swings less than the reporting threshold.
    const stubby: ToolBody = { ...tool, comMm: [0, 150, 0] };
    const calm = analyseHangPose({
      tool: stubby,
      placement: upright(0, 3 - 195, 30),
      obstacles: [peg],
    });
    expect(codes(calm)).not.toContain('swings');
  });

  test('a tool resting on a slippery shelf slides off and needs retention', () => {
    const lying: Placement = { rotation: rotationZ(90), position: [60, 10, 20] };
    const holder = shelf('shelf', 120, 0, 40);
    const rough = analyseHangPose({ tool: barTool(), placement: lying, obstacles: [holder] });
    expect(codes(rough)).not.toContain('slides_off');
    const slippery = analyseHangPose({
      tool: barTool(),
      placement: lying,
      obstacles: [holder],
      options: {
        equilibrium: {
          frictionMu: 0.08,
          torqueScaleMm: 50,
          tolerance: 0.03,
          looseGapMm: 0.6,
          wallTiltDeg: 0,
        },
      },
    });
    expect(codes(slippery)).toContain('slides_off');
    expect(codes(slippery)).toContain('needs_retention');
  });

  test('a tool with its centre of gravity beyond the support falls off', () => {
    // Lying bar from x = -60 to 140 on a shelf that ends at x = 0: CoM at x = 40 is off the edge.
    const placement: Placement = { rotation: rotationZ(-90), position: [-60, 10, 20] };
    const holder = solid('edge', box([-120, -4, 0], [0, 0, 40]), box([-120, -40, 0], [0, 0, 4]));
    const report = analyseHangPose({ tool: barTool(), placement, obstacles: [holder] });
    expect(report.status).toBe('unstable');
    expect(codes(report).some((c) => c === 'tips' || c === 'falls')).toBe(true);
  });

  test('a tool heavier than the mount carries is overloaded', () => {
    const holder = slotBlock('slot', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const report = analyseHangPose({
      tool: barTool(),
      placement: upright(0, 4, 10),
      obstacles: [holder],
      options: { maxLoadG: 60 },
    });
    expect(codes(report)).toContain('overloaded');
    expect(report.score).toBeLessThanOrEqual(0.3);
  });

  test('a bin much wider than the tool lets it tip, a snug rack does not (bin and rack styles)', () => {
    const rack = slotBlock('rack', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const bin = slotBlock('bin', { halfX: 40, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const inRack = analyseHangPose({
      tool: barTool(),
      placement: upright(0, 4, 10),
      obstacles: [rack],
    });
    const inBin = analyseHangPose({
      tool: barTool(),
      placement: upright(0, 4, 10),
      obstacles: [bin],
    });
    expect(inRack.status).toBe('stable');
    expect(inBin.status).not.toBe('stable');
    expect(codes(inBin)).toContain('tips');
  });

  test('a flat tool on the board falls without a magnet and is held with one (magnet style)', () => {
    const plate: ToolBody = {
      id: 'plate',
      mesh: union(box([-20, 0, 0], [20, 40, 6])),
      massG: 60,
      comMm: [0, 20, 3],
    };
    const placement = upright(0, 50, 0);
    const free = analyseHangPose({ tool: plate, placement, obstacles: [] });
    expect(codes(free)).toContain('levitating');
    const held = analyseHangPose({
      tool: plate,
      placement,
      obstacles: [],
      options: {
        equilibrium: {
          frictionMu: 0.35,
          torqueScaleMm: 50,
          tolerance: 0.03,
          looseGapMm: 0.6,
          wallTiltDeg: 0,
          magnetPullG: 6,
        },
      },
    });
    expect(held.status).not.toBe('unstable');
    expect(codes(held)).not.toContain('levitating');
    expect(codes(held)).not.toContain('falls');
  });
});
