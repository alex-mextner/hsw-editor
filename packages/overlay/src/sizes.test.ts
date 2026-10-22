import { describe, expect, test } from 'bun:test';
import { HSW_COL_PITCH_MM } from '@hsw-editor/core';
import {
  explainSnap,
  nearestVariant,
  rangeFromParam,
  snapSize,
  snapSizes,
  type SizeConstraint,
  type VariantOption,
} from './sizes.ts';
import { mulberry32 } from './test-helpers.ts';

const range: SizeConstraint = { kind: 'range', min: 6, max: 20, step: 0.5 };
const ladder: SizeConstraint = { kind: 'ladder', values: [40, 60, 80, 120, 160] };
const span: SizeConstraint = {
  kind: 'grid-span',
  pitchMm: HSW_COL_PITCH_MM,
  minCells: 1,
  maxCells: 12,
};

describe('snapSize: range', () => {
  test('rounds to the step and says so', () => {
    const s = snapSize(8.3, range);
    expect(s).toMatchObject({ requested: 8.3, snapped: 8.5, changed: true, feasible: true });
    expect(s.reason).toEqual({ code: 'rounded-to-step', stepMm: 0.5 });
  });

  test('exact values are reported as exact', () => {
    expect(snapSize(8.5, range).reason).toEqual({ code: 'exact' });
  });

  test('clamps to the limits with the limit in the reason', () => {
    expect(snapSize(2, range)).toMatchObject({
      snapped: 6,
      reason: { code: 'min-limit', limitMm: 6 },
    });
    expect(snapSize(99, range)).toMatchObject({
      snapped: 20,
      reason: { code: 'max-limit', limitMm: 20 },
    });
  });

  test('a max that is not on the step grid snaps down to the last valid step', () => {
    const odd: SizeConstraint = { kind: 'range', min: 10, max: 12.2, step: 1 };
    expect(snapSize(50, odd).snapped).toBe(12);
    expect(snapSize(12.2, odd).snapped).toBe(12);
  });

  test('rounding up / down', () => {
    expect(snapSize(8.1, range, { rounding: 'up' }).snapped).toBe(8.5);
    expect(snapSize(8.4, range, { rounding: 'down' }).snapped).toBe(8);
  });

  test('printable limit caps the result on the step grid', () => {
    const s = snapSize(19, range, { printMaxMm: 12.3 });
    expect(s.snapped).toBe(12);
    expect(s.reason).toEqual({ code: 'printable-limit', limitMm: 12.3 });
  });

  test('derives a range from a bank ParamDef', () => {
    expect(rangeFromParam({ min: 1, max: 3, step: 0.2 })).toEqual({
      kind: 'range',
      min: 1,
      max: 3,
      step: 0.2,
    });
  });
});

describe('snapSize: ladder', () => {
  test('nearest rung, ties go to the larger one', () => {
    expect(snapSize(70, ladder).snapped).toBe(80);
    expect(snapSize(65, ladder).snapped).toBe(60);
    expect(snapSize(100, ladder)).toMatchObject({ snapped: 120, reason: { code: 'nearest-rung' } });
  });

  test('out of range goes to the end rungs with the limit', () => {
    expect(snapSize(10, ladder)).toMatchObject({
      snapped: 40,
      reason: { code: 'min-limit', limitMm: 40 },
    });
    expect(snapSize(500, ladder)).toMatchObject({
      snapped: 160,
      reason: { code: 'max-limit', limitMm: 160 },
    });
  });

  test('"up" picks the smallest rung that is large enough, "down" the largest that is small enough', () => {
    expect(snapSize(61, ladder, { rounding: 'up' }).snapped).toBe(80);
    expect(snapSize(79, ladder, { rounding: 'down' }).snapped).toBe(60);
  });

  test('printable limit picks the largest rung that fits', () => {
    const s = snapSize(160, ladder, { printMaxMm: 100 });
    expect(s.snapped).toBe(80);
    expect(s.reason).toEqual({ code: 'printable-limit', limitMm: 100 });
  });

  test('when even the smallest rung does not print the size is unbuildable', () => {
    const s = snapSize(60, ladder, { printMaxMm: 30 });
    expect(s.feasible).toBe(false);
    expect(s.snapped).toBe(40);
    expect(s.reason).toEqual({ code: 'unbuildable', limitMm: 30 });
  });

  test('a ladder without rungs is a programming error', () => {
    expect(() => snapSize(5, { kind: 'ladder', values: [] })).toThrow(RangeError);
  });
});

describe('snapSize: grid span', () => {
  test('100 mm becomes 5 whole cells = 102.19 mm', () => {
    const s = snapSize(100, span);
    expect(s.snapped).toBeCloseTo(5 * HSW_COL_PITCH_MM, 9);
    expect(s.reason).toEqual({ code: 'whole-cells', cells: 5, pitchMm: HSW_COL_PITCH_MM });
  });

  test('at least one cell, at most maxCells', () => {
    expect(snapSize(1, span)).toMatchObject({
      snapped: HSW_COL_PITCH_MM,
      reason: { code: 'min-limit' },
    });
    expect(snapSize(1000, span)).toMatchObject({
      snapped: 12 * HSW_COL_PITCH_MM,
      reason: { code: 'max-limit' },
    });
  });

  test('printable limit floors to whole cells', () => {
    const s = snapSize(200, span, { printMaxMm: 100 });
    expect(s.snapped).toBeCloseTo(4 * HSW_COL_PITCH_MM, 9);
    expect(s.reason).toEqual({ code: 'printable-limit', limitMm: 100 });
  });
});

describe('snapSize invariants', () => {
  const constraints: SizeConstraint[] = [range, ladder, span];

  test('idempotent: snapping a snapped value changes nothing and reports exact', () => {
    const random = mulberry32(42);
    for (const constraint of constraints) {
      for (let i = 0; i < 300; i++) {
        const requested = random() * 400 - 20;
        const options = i % 3 === 0 ? { printMaxMm: 30 + random() * 200 } : {};
        const once = snapSize(requested, constraint, options);
        const twice = snapSize(once.snapped, constraint, options);
        expect(twice.snapped).toBeCloseTo(once.snapped, 9);
        if (once.feasible) expect(twice.reason.code).toBe('exact');
      }
    }
  });

  test('never returns a value above the printable limit unless unbuildable', () => {
    const random = mulberry32(7);
    for (const constraint of constraints) {
      for (let i = 0; i < 300; i++) {
        const limit = 20 + random() * 200;
        const s = snapSize(random() * 500, constraint, { printMaxMm: limit });
        if (s.feasible) expect(s.snapped).toBeLessThanOrEqual(limit + 1e-6);
      }
    }
  });

  test('snaps to the nearest feasible value: no other rung is strictly closer', () => {
    const random = mulberry32(3);
    for (let i = 0; i < 300; i++) {
      const requested = random() * 200;
      const s = snapSize(requested, ladder);
      for (const rung of [40, 60, 80, 120, 160]) {
        expect(Math.abs(s.snapped - requested)).toBeLessThanOrEqual(
          Math.abs(rung - requested) + 1e-9,
        );
      }
    }
  });

  test('rejects non-finite input', () => {
    expect(() => snapSize(Number.NaN, range)).toThrow(RangeError);
  });
});

describe('snapSizes and explanations', () => {
  test('snaps several named dimensions and ignores unknown keys', () => {
    const out = snapSizes(
      { length: 130, diameter: 8.3, colour: 3 },
      {
        length: { constraint: ladder },
        diameter: { constraint: range },
      },
    );
    expect(out['length']?.snapped).toBe(120);
    expect(out['diameter']?.snapped).toBe(8.5);
    expect(out['colour']).toBeUndefined();
  });

  test('English explanations carry the numbers', () => {
    expect(explainSnap(snapSize(100, span))).toContain('5 whole honeycomb cells');
    expect(explainSnap(snapSize(19, range, { printMaxMm: 12.3 }))).toContain(
      'printer limit 12.3 mm',
    );
    expect(explainSnap(snapSize(60, ladder, { printMaxMm: 30 }))).toContain('cannot be built');
    expect(explainSnap(snapSize(60, ladder))).toContain('buildable as typed');
  });
});

describe('nearestVariant', () => {
  const variants: VariantOption[] = [
    { id: 'rail-3x6', dimsMm: { length: 60, diameter: 6 } },
    { id: 'rail-3x8', dimsMm: { length: 60, diameter: 8 } },
    { id: 'rail-6x8', dimsMm: { length: 120, diameter: 8 } },
    { id: 'rail-6x10', dimsMm: { length: 120, diameter: 10 } },
  ];

  test('exact match', () => {
    const s = nearestVariant({ length: 120, diameter: 8 }, variants);
    expect(s.variant?.id).toBe('rail-6x8');
    expect(s.reason).toEqual({ code: 'exact' });
    expect(s.perDimension.every((d) => !d.changed)).toBe(true);
  });

  test('nearest in normalised units and per-dimension change report', () => {
    const s = nearestVariant({ length: 100, diameter: 9.2 }, variants);
    expect(s.variant?.id).toBe('rail-6x10');
    expect(s.reason).toEqual({ code: 'nearest-variant' });
    expect(s.snapped).toEqual({ length: 120, diameter: 10 });
    expect(s.perDimension).toEqual([
      { key: 'length', requested: 100, snapped: 120, changed: true },
      { key: 'diameter', requested: 9.2, snapped: 10, changed: true },
    ]);
  });

  test('a requested subset of the dimensions only compares those', () => {
    expect(nearestVariant({ diameter: 6.2 }, variants).variant?.id).toBe('rail-3x6');
  });

  test('prefer "fit" picks the smallest variant that is large enough in every dimension', () => {
    const s = nearestVariant({ length: 70, diameter: 7 }, variants, { prefer: 'fit' });
    expect(s.variant?.id).toBe('rail-6x8');
    expect(s.variant!.dimsMm['length']).toBeGreaterThanOrEqual(70);
    expect(s.variant!.dimsMm['diameter']).toBeGreaterThanOrEqual(7);
    expect(s.reason).toEqual({ code: 'smallest-fitting-variant' });
  });

  test('ties go to the larger variant', () => {
    const tie = nearestVariant({ diameter: 7 }, variants);
    expect(tie.variant?.dimsMm['diameter']).toBe(8);
  });

  test('printable limits exclude variants and are reported', () => {
    const s = nearestVariant({ length: 120, diameter: 10 }, variants, {
      printMaxMm: { length: 100 },
    });
    expect(s.variant?.dimsMm['length']).toBe(60);
    expect(s.reason).toEqual({ code: 'printable-limit', excluded: 2 });
    const none = nearestVariant({ length: 120 }, variants, { printMaxMm: { length: 10 } });
    expect(none.variant).toBeNull();
    expect(none.reason).toEqual({ code: 'unbuildable' });
  });

  test('idempotent: the snapped dimensions of a variant select that variant again', () => {
    const random = mulberry32(11);
    for (let i = 0; i < 200; i++) {
      const first = nearestVariant({ length: random() * 200, diameter: random() * 14 }, variants);
      const second = nearestVariant(first.snapped, variants);
      expect(second.variant?.id).toBe(first.variant?.id);
      expect(second.reason).toEqual({ code: 'exact' });
    }
  });
});

describe('malformed input is a loud error', () => {
  test('constraints that cannot describe a size throw instead of returning NaN', () => {
    expect(() => snapSize(8, { kind: 'range', min: 6, max: 20, step: 0 })).toThrow(RangeError);
    expect(() => snapSize(8, { kind: 'range', min: 20, max: 6, step: 1 })).toThrow(RangeError);
    expect(() => snapSize(8, { kind: 'ladder', values: [10, Number.NaN] })).toThrow(RangeError);
    expect(() => snapSize(8, { kind: 'grid-span', pitchMm: 20, minCells: 0, maxCells: 3 })).toThrow(
      RangeError,
    );
    expect(() => snapSize(8, { kind: 'grid-span', pitchMm: 20, minCells: 4, maxCells: 3 })).toThrow(
      RangeError,
    );
  });

  test('a NaN requested dimension is rejected by nearestVariant too', () => {
    expect(() =>
      nearestVariant({ length: Number.NaN }, [{ id: 'a', dimsMm: { length: 1 } }]),
    ).toThrow(RangeError);
  });
});

describe('nearestVariant edge cases', () => {
  test('variants that lack a requested dimension are not comparable', () => {
    const variants: VariantOption[] = [
      { id: 'a', dimsMm: { length: 50 } },
      { id: 'b', dimsMm: { length: 100, width: 10 } },
      { id: 'c', dimsMm: { length: 100, width: 30 } },
    ];
    const s = nearestVariant({ length: 100, width: 12 }, variants);
    expect(s.variant?.id).toBe('b');
    expect(s.reason).toEqual({ code: 'nearest-variant' });
    const none = nearestVariant({ length: 100, height: 5 }, variants);
    expect(none.variant).toBeNull();
    expect(none.reason).toEqual({ code: 'no-comparable-variant' });
  });

  test('excluding a variant never changes the winner among the rest, and printable-limit is only blamed when it mattered', () => {
    const variants: VariantOption[] = [
      { id: 'A', dimsMm: { length: 50, diameter: 6 } },
      { id: 'B', dimsMm: { length: 100, diameter: 10 } },
      { id: 'C', dimsMm: { length: 1000, diameter: 8 } },
    ];
    // C is excluded by the printer, but it was never the unconstrained winner: B was, and B is still available.
    const s = nearestVariant({ length: 60, diameter: 8.5 }, variants, {
      printMaxMm: { length: 200 },
    });
    expect(s.variant?.id).toBe('B');
    expect(s.reason).toEqual({ code: 'nearest-variant' });
  });

  test('a prototype-named dimension is not mistaken for a weight', () => {
    const variants: VariantOption[] = [
      { id: 'a', dimsMm: { valueOf: 100 } },
      { id: 'b', dimsMm: { valueOf: 5 } },
    ];
    expect(nearestVariant({ valueOf: 5 }, variants, { weights: {} }).variant?.id).toBe('b');
  });

  test('weights shift the choice towards the dimension that matters', () => {
    const variants: VariantOption[] = [
      { id: 'long-thin', dimsMm: { length: 160, diameter: 6 } },
      { id: 'short-fat', dimsMm: { length: 60, diameter: 10 } },
    ];
    const request = { length: 100, diameter: 7 };
    expect(nearestVariant(request, variants, { weights: { diameter: 10 } }).variant?.id).toBe(
      'long-thin',
    );
    expect(nearestVariant(request, variants, { weights: { length: 10 } }).variant?.id).toBe(
      'short-fat',
    );
  });
});

describe('prototype-named dimensions', () => {
  test('a dimension called "constructor" or "toString" is not looked up on Object.prototype', () => {
    expect(snapSizes({ constructor: 5, toString: 6 }, {})).toEqual({});
    const variants: VariantOption[] = [{ id: 'a', dimsMm: { length: 50 } }];
    expect(nearestVariant({ toString: 5 }, variants).reason).toEqual({
      code: 'no-comparable-variant',
    });
  });
});
