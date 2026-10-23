import { beforeAll, describe, expect, test } from 'bun:test';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { placementOfPose } from './body.ts';
import { rankHolders } from './rank.ts';
import { analyseWallPhysics } from './wall.ts';
import { barTool, moved, shelf, slotBlock } from './shapes.testkit.ts';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const pose = (x: number, y: number, z: number) =>
  placementOfPose({ x, y, z, rotX: 0, rotY: 0, rotZ: 0 });

describe('wall physics', () => {
  test('a tool with nothing under it is flagged, a seated one is not, a free tool is ignored', () => {
    const holder = slotBlock('h1', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const second = moved(
      slotBlock('h2', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 }),
      200,
      0,
      0,
    );
    const report = analyseWallPhysics({
      holders: [
        { id: 'h1', body: holder },
        { id: 'h2', body: second },
      ],
      tools: [
        { id: 'seated', body: barTool('a'), placement: pose(0, 4, 10), holderId: 'h1' },
        { id: 'floating', body: barTool('b'), placement: pose(200, 24, 10), holderId: 'h2' },
        { id: 'loose', body: barTool('c'), placement: pose(500, 0, 30), holderId: null },
      ],
      wasm,
    });
    expect(report.tools.map((t) => t.toolId)).toEqual(['seated', 'floating']);
    const [seated, floating] = report.tools;
    expect(seated?.problems).toEqual([]);
    expect(seated?.removal?.verdict).toBe('free');
    expect(floating?.problems.map((p) => p.code)).toContain('falls');
    expect(floating?.problems.find((p) => p.code === 'falls')?.severity).toBe('error');
    expect(report.flagged).toBe(1);
  });

  test('another tool hanging next to a tool is an obstacle for it', () => {
    const holder = shelf('s', 100, 0, 40);
    const report = analyseWallPhysics({
      holders: [{ id: 's', body: holder }],
      tools: [
        { id: 'one', body: barTool('one'), placement: pose(0, 0, 20), holderId: 's' },
        { id: 'two', body: barTool('two'), placement: pose(26, 0, 20), holderId: 's' },
      ],
      wasm,
    });
    const one = report.tools.find((t) => t.toolId === 'one');
    expect(one?.removal?.neighbourGapMm).toBeLessThan(12);
    expect(one?.problems.map((p) => p.code)).toContain('removal_two_hands');
  });
});

describe('holder ranking', () => {
  test('the holder that really holds the tool beats the one that only fits on paper', () => {
    const snug = slotBlock('snug', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const flat = shelf('flat', 60, 0, 40);
    const tool = barTool();
    const ranked = rankHolders(
      tool,
      [
        {
          holderId: 'flat',
          holder: flat,
          neighbours: [],
          anchor: [0, 0, 20],
          halfWidthMm: 10,
          tipDown: false,
          compatScore: 0.95,
        },
        {
          holderId: 'snug',
          holder: snug,
          neighbours: [],
          anchor: [0, 40, 10],
          halfWidthMm: 10,
          tipDown: false,
          compatScore: 0.7,
        },
      ],
      { wasm },
    );
    expect(ranked.map((r) => r.holderId)).toEqual(['snug', 'flat']);
    expect(ranked[0]?.seat.report.status).toBe('stable');
    expect(ranked[1]?.seat.report.status).not.toBe('stable');
  });
});
