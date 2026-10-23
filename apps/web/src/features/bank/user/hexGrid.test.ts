import { describe, expect, test } from 'bun:test';
import { HSW_COL_PITCH_MM, HSW_ROW_PITCH_MM } from '@hsw-editor/core';
import {
  boxWithCells,
  CELL_RADIUS_MM,
  cellCentreMm,
  cellKey,
  cellWindow,
  footprintDims,
  hexCorners,
  hexSvgPoints,
  windowCells,
  windowViewBox,
} from './hexGrid.ts';

describe('cell geometry', () => {
  test('a cell sits at (dCol * colPitch, dRow2 * rowPitch / 2) from the anchor', () => {
    expect(cellCentreMm({ dCol: 0, dRow2: 0 })).toEqual({ x: 0, y: 0 });
    const next = cellCentreMm({ dCol: 1, dRow2: 1 });
    expect(next.x).toBeCloseTo(HSW_COL_PITCH_MM);
    expect(next.y).toBeCloseTo(HSW_ROW_PITCH_MM / 2);
    expect(cellCentreMm({ dCol: -2, dRow2: -4 }).y).toBeCloseTo(-2 * HSW_ROW_PITCH_MM);
  });

  test('all six neighbours are one pitch away, so the hexagons tile', () => {
    const neighbours = [
      { dCol: 0, dRow2: 2 },
      { dCol: 0, dRow2: -2 },
      { dCol: 1, dRow2: 1 },
      { dCol: 1, dRow2: -1 },
      { dCol: -1, dRow2: 1 },
      { dCol: -1, dRow2: -1 },
    ];
    for (const cell of neighbours) {
      const { x, y } = cellCentreMm(cell);
      expect(Math.hypot(x, y)).toBeCloseTo(HSW_ROW_PITCH_MM, 3);
    }
  });

  test('the hexagon corners are one circumradius from the centre', () => {
    const corners = hexCorners({ x: 10, y: -5 }, CELL_RADIUS_MM);
    expect(corners).toHaveLength(6);
    for (const corner of corners) {
      expect(Math.hypot(corner.x - 10, corner.y + 5)).toBeCloseTo(CELL_RADIUS_MM);
    }
  });

  test('svg points flip y to the downwards axis', () => {
    const up = hexSvgPoints({ dCol: 0, dRow2: 2 });
    const [firstX, firstY] = (up.split(' ')[0] ?? '').split(',').map(Number);
    expect(firstX).toBeCloseTo(CELL_RADIUS_MM);
    // The cell is HSW_ROW_PITCH_MM above the anchor, so in SVG its y is negative.
    expect(firstY).toBeCloseTo(-HSW_ROW_PITCH_MM);
  });

  test('cell keys carry both offsets (negative ones too)', () => {
    expect(cellKey({ dCol: -1, dRow2: 3 })).toBe('-1_3');
  });
});

describe('footprint dims (same formulas as packages/bank validate.ts)', () => {
  test('single cell', () => {
    expect(footprintDims([{ dCol: 0, dRow2: 0 }])).toEqual({ cols: 1, rows: 1 });
  });
  test('two cells stacked in a column span two rows', () => {
    expect(
      footprintDims([
        { dCol: 0, dRow2: 0 },
        { dCol: 0, dRow2: 2 },
      ]),
    ).toEqual({ cols: 1, rows: 2 });
  });
  test('a staggered neighbour adds a column and half a row (rounded up)', () => {
    expect(
      footprintDims([
        { dCol: 0, dRow2: 0 },
        { dCol: 1, dRow2: 1 },
      ]),
    ).toEqual({ cols: 2, rows: 2 });
  });
  test('negative offsets count from the lowest cell', () => {
    expect(
      footprintDims([
        { dCol: -1, dRow2: -1 },
        { dCol: 0, dRow2: 0 },
        { dCol: 1, dRow2: 1 },
        { dCol: 0, dRow2: 2 },
      ]),
    ).toEqual({ cols: 3, rows: 3 });
  });
  test('an empty list has no size', () => {
    expect(footprintDims([])).toEqual({ cols: 0, rows: 0 });
  });
});

describe('window around the cells', () => {
  test('the margin is added on every side and the anchor is always inside', () => {
    expect(cellWindow([{ dCol: 3, dRow2: 3 }], 1)).toEqual({
      minCol: -1,
      maxCol: 4,
      minRow2: -1,
      maxRow2: 4,
    });
  });

  test('only cells that obey the parity rule are generated', () => {
    const cells = windowCells({ minCol: -1, maxCol: 1, minRow2: -1, maxRow2: 1 });
    expect(cells.every((cell) => (cell.dRow2 - cell.dCol) % 2 === 0)).toBe(true);
    expect(cells.map(cellKey)).toEqual(['-1_1', '1_1', '0_0', '-1_-1', '1_-1']);
  });

  test('the view box encloses the extreme hexagons', () => {
    const box = windowViewBox({ minCol: 0, maxCol: 0, minRow2: 0, maxRow2: 0 });
    expect(box.width).toBeCloseTo(2 * CELL_RADIUS_MM);
    expect(box.height).toBeCloseTo(HSW_ROW_PITCH_MM);
    // y is down in SVG: the box starts above the anchor.
    expect(box.y).toBeCloseTo(-HSW_ROW_PITCH_MM / 2);
  });
});

describe('preview framing box', () => {
  const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 20 } };

  test('cells far from the element widen the box in x/y and keep z', () => {
    const framed = boxWithCells(bbox, [{ dCol: 2, dRow2: 0 }]);
    expect(framed.bbox.max.x).toBeCloseTo(2 * HSW_COL_PITCH_MM + CELL_RADIUS_MM);
    expect(framed.bbox.min.z).toBe(0);
    expect(framed.dims.z).toBe(20);
  });

  test('no cells leaves the box alone', () => {
    expect(boxWithCells(bbox, [])).toEqual({ bbox, dims: { x: 10, y: 10, z: 20 } });
  });
});
