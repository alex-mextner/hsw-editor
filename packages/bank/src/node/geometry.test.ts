import { describe, expect, test } from 'bun:test';
import { geometryOf } from './geometry.ts';

describe('geometryOf', () => {
  const built = {
    bboxMm: {
      min: [-10.00049, -5, -0.2] as [number, number, number],
      max: [10, 5.0004, 20] as [number, number, number],
    },
    cells: [
      [0, 0],
      [1, 1],
      [0, 2],
    ] as [number, number][],
    mountingCells: [[1, 1]] as [number, number][],
  };

  test('rounds to a micron, clamps the bottom to the wall plane and derives dims and footprint', () => {
    const g = geometryOf(built, 'm3-screw');
    expect(g.bboxMm.min).toEqual({ x: -10, y: -5, z: 0 });
    expect(g.dimsMm).toEqual({ x: 20, y: 10, z: 20 });
    expect(g.footprint).toEqual({
      cells: [
        { dCol: 0, dRow2: 0 },
        { dCol: 1, dRow2: 1 },
        { dCol: 0, dRow2: 2 },
      ],
      cols: 2,
      rows: 2,
    });
  });

  test('mounting cells: screw holes for m3-screw, footprint otherwise, none for none', () => {
    expect(geometryOf(built, 'm3-screw').mountingCells).toEqual([{ dCol: 1, dRow2: 1 }]);
    expect(geometryOf(built, 'hex-plug').mountingCells).toHaveLength(3);
    expect(geometryOf(built, 'none').mountingCells).toEqual([]);
  });
});
