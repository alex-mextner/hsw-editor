import { describe, expect, test } from 'bun:test';
import { columnCount, rasterize, spanRange, topOf } from './columns.ts';
import { IDENTITY, box, union } from './shapes.testkit.ts';

describe('column rasteriser', () => {
  test('a box is one span per covered column', () => {
    const grid = rasterize(union(box([0, 0, 0], [10, 20, 10])), IDENTITY, [0, 0, 0], 1);
    expect(columnCount(grid)).toBe(100);
    const [from, to] = spanRange(grid, 5, 5);
    expect(to - from).toBe(1);
    expect(grid.spans[2 * from]).toBeCloseTo(0, 3);
    expect(grid.spans[2 * from + 1]).toBeCloseTo(20, 3);
  });

  test('overlapping shells union by winding number, a gap stays a gap', () => {
    const mesh = union(
      box([0, 0, 0], [10, 10, 10]),
      box([0, 5, 0], [10, 25, 10]),
      box([0, 40, 0], [10, 50, 10]),
    );
    const grid = rasterize(mesh, IDENTITY, [0, 0, 0], 1);
    const [from, to] = spanRange(grid, 3, 3);
    expect(to - from).toBe(2);
    expect(grid.spans[2 * from + 1]).toBeCloseTo(25, 3);
    expect(grid.spans[2 * (from + 1)]).toBeCloseTo(40, 3);
  });

  test('a through hole leaves its columns empty', () => {
    const plate = union(
      box([0, 0, 0], [10, 5, 4]),
      box([0, 0, 6], [10, 5, 10]),
      box([0, 0, 4], [3, 5, 6]),
      box([7, 0, 4], [10, 5, 6]),
    );
    const grid = rasterize(plate, IDENTITY, [0, 0, 0], 0.5);
    expect(topOf(grid, 10, 10)).toBe(-Infinity);
    expect(topOf(grid, 2, 10)).toBeCloseTo(5, 3);
  });
});
