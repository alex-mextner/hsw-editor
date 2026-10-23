import { describe, expect, test } from 'bun:test';
import type { CellOffset } from '@hsw-editor/bank';
import {
  clampMounting,
  defaultMountingKind,
  mountingIssue,
  paintFootprintCell,
  paintMountingCell,
  toggleFootprintCell,
  toggleMountingCell,
  type CellSets,
} from './cellEdit.ts';
import { cellKey } from './hexGrid.ts';

const A: CellOffset = { dCol: 0, dRow2: 0 };
const B: CellOffset = { dCol: 0, dRow2: 2 };
const C: CellOffset = { dCol: 1, dRow2: 1 };
const keys = (cells: readonly CellOffset[]): string[] => cells.map(cellKey);

const start: CellSets = { footprint: [A, B], mounting: [B] };

describe('footprint editing', () => {
  test('the anchor cannot be removed', () => {
    expect(toggleFootprintCell(start, A)).toBe(start);
    expect(paintFootprintCell(start, A, false)).toBe(start);
  });

  test('a new cell is added to the footprint', () => {
    const next = toggleFootprintCell(start, C);
    expect(keys(next.footprint)).toEqual(['0_0', '0_2', '1_1']);
    expect(next.mounting).toEqual([B]);
  });

  test('removing a cell removes its peg too (mounting stays a subset of the footprint)', () => {
    const next = toggleFootprintCell(start, B);
    expect(keys(next.footprint)).toEqual(['0_0']);
    expect(next.mounting).toEqual([]);
  });

  test('painting is idempotent: setting a state that already holds changes nothing', () => {
    expect(paintFootprintCell(start, B, true)).toBe(start);
    expect(paintFootprintCell(start, C, false)).toBe(start);
    expect(keys(paintFootprintCell(start, C, true).footprint)).toContain('1_1');
  });
});

describe('peg editing', () => {
  test('only footprint cells can carry a peg', () => {
    expect(toggleMountingCell(start, C)).toBe(start);
    expect(paintMountingCell(start, C, true)).toBe(start);
  });

  test('toggles a peg on and off', () => {
    const on = toggleMountingCell(start, A);
    expect(keys(on.mounting)).toEqual(['0_2', '0_0']);
    expect(keys(toggleMountingCell(on, B).mounting)).toEqual(['0_0']);
  });

  test('painting a peg that is already in the wanted state is a no-op', () => {
    expect(paintMountingCell(start, B, true)).toBe(start);
    expect(paintMountingCell(start, A, false)).toBe(start);
  });

  test('clampMounting drops pegs that left the footprint', () => {
    expect(keys(clampMounting([A], [A, B]))).toEqual(['0_0']);
  });
});

describe('mounting validation', () => {
  test('a real kind needs a peg, none does not', () => {
    expect(mountingIssue('hex-plug', [])).toBe('no-pegs');
    expect(mountingIssue('m3-screw', [])).toBe('no-pegs');
    expect(mountingIssue('clip', [A])).toBeNull();
    expect(mountingIssue('none', [])).toBeNull();
  });

  test('panels default to no mounting, everything else to a hex plug', () => {
    expect(defaultMountingKind('panels')).toBe('none');
    expect(defaultMountingKind('panels/flat')).toBe('none');
    expect(defaultMountingKind('holders/pliers')).toBe('hex-plug');
    expect(defaultMountingKind('')).toBe('hex-plug');
  });
});
