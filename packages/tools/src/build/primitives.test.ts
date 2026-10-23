import { describe, expect, test } from 'bun:test';
import { polygonArea } from '../math.ts';
import { type Mesh, analyzeMesh } from '../mesh.ts';
import {
  box,
  cylinder,
  extrude,
  lathe,
  loft,
  roundedPath,
  sphere,
  torus,
  tube,
} from './primitives.ts';
import {
  circleRing,
  crossRing,
  flutedRing,
  lobedRing,
  polygonRing,
  roundedRectRing,
} from './rings.ts';

const square = [
  [0, 0],
  [10, 0],
  [10, 6],
  [0, 6],
] as const;
const hole = [
  [3, 2],
  [7, 2],
  [7, 4],
  [3, 4],
] as const;

describe('closed-shell primitives', () => {
  const cases: Record<string, () => Mesh> = {
    box: () => box(10, 20, 6),
    roundedBox: () => box(10, 20, 6, 1.5),
    cylinder: () => cylinder(4, 20),
    sphere: () => sphere(5),
    lathe: () =>
      lathe(
        [
          [0, 0],
          [4, 1],
          [4, 9],
          [0, 10],
        ],
        24,
      ),
    loft: () =>
      loft([
        { y: 0, ring: roundedRectRing(8, 4, 1) },
        { y: 10, ring: roundedRectRing(4, 8, 2) },
      ]),
    extrude: () => extrude(square, 0, 3),
    extrudeBevel: () => extrude(square, 0, 3, { bevel: 0.6 }),
    extrudeHole: () => extrude(square, 0, 3, { holes: [hole] }),
    extrudeHoleBevel: () => extrude(square, 0, 3, { holes: [hole], bevel: 0.5 }),
    torus: () => torus(10, 2),
    tubeOpen: () =>
      tube(
        [
          [0, 0, 0],
          [0, 10, 0],
          [5, 20, 0],
        ],
        2,
        { sides: 12 },
      ),
    tubeRoundedPath: () =>
      tube(
        roundedPath(
          [
            [0, 0, 0],
            [0, 30, 0],
            [20, 30, 0],
          ],
          6,
        ),
        1.5,
      ),
  };
  for (const [name, make] of Object.entries(cases)) {
    test(`${name} is one watertight outward shell`, () => {
      const r = analyzeMesh(make());
      expect(r.openEdges).toBe(0);
      expect(r.badEdges).toBe(0);
      expect(r.volumeMm3).toBeGreaterThan(0);
      expect(r.watertight).toBe(true);
    });
  }

  test('volumes match the dimensions', () => {
    expect(analyzeMesh(box(10, 20, 6)).volumeMm3).toBeCloseTo(1200, 3);
    expect(analyzeMesh(extrude(square, 0, 3, { holes: [hole] })).volumeMm3).toBeCloseTo(
      (60 - 8) * 3,
      3,
    );
  });
});

describe('rings', () => {
  test('crossRing is the plus outline: area = 8t(R - t) + 4t^2', () => {
    const R = 3;
    const t = 1;
    expect(polygonArea(crossRing(R, t))).toBeCloseTo(8 * t * (R - t) + 4 * t * t, 6);
  });
  test('ring point counts stay constant across parameters', () => {
    expect(roundedRectRing(10, 4, 0).length).toBe(roundedRectRing(10, 4, 1.9).length);
    expect(flutedRing(5, 12, 0).length).toBe(flutedRing(5, 12, 0.3).length);
    expect(lobedRing(5, 0, 3).length).toBe(lobedRing(5, 0.5, 3).length);
    expect(circleRing(3, 20).length).toBe(20);
    expect(polygonRing(8, 5, 40).length).toBe(40);
  });
});
