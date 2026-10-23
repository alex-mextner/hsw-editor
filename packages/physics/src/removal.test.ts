import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { SolidBody, type Placement, type ToolBody } from './body.ts';
import { RemovalProbe } from './removal.ts';
import { IDENTITY, barTool, box, shelf, slotBlock, solid } from './shapes.testkit.ts';

let wasm: ManifoldToplevel;
let probe: RemovalProbe;

beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
  probe = new RemovalProbe(wasm);
});
afterAll(() => probe.dispose());

const at = (x: number, y: number, z: number): Placement => ({
  rotation: IDENTITY,
  position: [x, y, z],
});
const asObstacle = (id: string, tool: ToolBody, placement: Placement): SolidBody =>
  new SolidBody(id, tool.mesh, placement.rotation, placement.position);

describe('removal ergonomics', () => {
  test('a bar standing in an open slot lifts straight out', () => {
    const holder = slotBlock('slot', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const report = probe.analyse({
      tool: barTool(),
      placement: at(0, 4, 10),
      holder,
      neighbours: [],
    });
    expect(report.verdict).toBe('free');
    expect(report.path).toBe('lift');
    // The butt has to rise from the floor (4) above the rim (40).
    expect(report.liftMm).toBeGreaterThanOrEqual(35);
    expect(report.liftMm).toBeLessThanOrEqual(40);
    expect(report.convenience).toBeGreaterThan(0.9);
  });

  test('a bar in a slot open at the front is pulled out, which is shorter than lifting', () => {
    const holder = solid(
      'open',
      box([-31, 0, 0], [-11, 40, 20]),
      box([11, 0, 0], [31, 40, 20]),
      box([-11, 0, 0], [11, 40, 4]),
      box([-11, 0, 4], [11, 4, 20]),
    );
    const report = probe.analyse({
      tool: barTool(),
      placement: at(0, 4, 10),
      holder,
      neighbours: [],
    });
    expect(report.verdict).toBe('free');
    expect(report.path).toBe('pull');
    expect(report.pullMm).toBeGreaterThan(5);
  });

  test('a lid just above the bar and walls around it leave no way out', () => {
    const holder = slotBlock('slot', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const lid = solid('lid', box([-60, 205, 0], [60, 215, 40]));
    const report = probe.analyse({
      tool: barTool(),
      placement: at(0, 4, 10),
      holder,
      neighbours: [lid],
    });
    expect(report.verdict).toBe('blocked');
    expect(report.convenience).toBe(0);
    expect(report.blockedBy.length).toBeGreaterThan(0);
  });

  test('a neighbour a few millimetres from the grip means two hands', () => {
    const holder = shelf('shelf', 100, 0, 40);
    const tool = barTool();
    const neighbour = asObstacle('next', barTool('next'), at(26, 0, 20));
    const report = probe.analyse({
      tool,
      placement: at(0, 0, 20),
      holder,
      neighbours: [neighbour],
    });
    expect(report.verdict).toBe('needs_two_hands');
    expect(report.reasons.map((r) => r.code)).toContain('cramped');
    expect(report.neighbourGapMm).toBeLessThan(12);
    expect(report.convenience).toBeLessThanOrEqual(0.3);
  });

  test('the same neighbour farther away leaves room for a hand', () => {
    const holder = shelf('shelf', 100, 0, 40);
    const neighbour = asObstacle('next', barTool('next'), at(60, 0, 20));
    const report = probe.analyse({
      tool: barTool(),
      placement: at(0, 0, 20),
      holder,
      neighbours: [neighbour],
    });
    expect(report.verdict).toBe('free');
    expect(report.neighbourGapMm).toBeGreaterThan(12);
  });

  test('a heavy tool needs a second hand', () => {
    const holder = shelf('shelf', 100, 0, 40);
    const heavy: ToolBody = { ...barTool(), id: 'heavy', massG: 4200 };
    const report = probe.analyse({ tool: heavy, placement: at(0, 0, 20), holder, neighbours: [] });
    expect(report.verdict).toBe('needs_two_hands');
    expect(report.reasons.map((r) => r.code)).toContain('heavy');
  });

  test('the sweep sees a lip the rasters would round away', () => {
    // A hook-like lip: a thin plate over the bar at y = 30..30.6, narrower than a raster cell column pair.
    const holder = slotBlock('slot', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const bar = barTool('short', 25, 20, 10, 50);
    const lip = solid('lip', box([-11, 30, 4], [11, 30.6, 16]));
    const report = probe.analyse({ tool: bar, placement: at(0, 4, 10), holder, neighbours: [lip] });
    expect(report.verdict).not.toBe('free');
  });

  test('unrelated geometry far away does not matter', () => {
    const holder = shelf('shelf', 100, 0, 40);
    const far = solid('far', box([300, 0, 0], [320, 50, 20]));
    const report = probe.analyse({
      tool: barTool(),
      placement: at(0, 0, 20),
      holder,
      neighbours: [far],
    });
    expect(report.verdict).toBe('free');
  });
});
