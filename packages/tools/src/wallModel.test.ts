import { describe, expect, test } from 'bun:test';
import './classes/index.ts';
import { generate, listToolClasses } from './registry.ts';
import { DIM_TOLERANCE_MM, differsFromDims } from './dims.ts';
import { realismProblems } from './realism.ts';
import {
  boundsDims,
  buildWallToolModel,
  generatorForBankClass,
  holdingSummary,
  paramHash,
  solveToolDims,
} from './wallModel.ts';

describe('generatorForBankClass', () => {
  test('prefers the class that carries the bank id, then any class declaring it', () => {
    expect(generatorForBankClass('screwdriver')?.id).toBe('screwdriver');
    expect(generatorForBankClass('pliers')?.id).toBe('pliers-combination');
    expect(generatorForBankClass('snips')?.bankClass).toBe('snips');
  });

  test('falls back to the coarser classes in order and gives up on unknown ones', () => {
    expect(generatorForBankClass('no-such-class', ['screwdriver'])?.id).toBe('screwdriver');
    expect(generatorForBankClass('no-such-class', ['also-missing'])).toBeUndefined();
    expect(generatorForBankClass('usb-stick')).toBeUndefined();
  });

  test('every bank class a generator declares is found again', () => {
    for (const cls of listToolClasses()) {
      expect(generatorForBankClass(cls.bankClass)?.bankClass).toBe(cls.bankClass);
    }
  });
});

describe('paramHash', () => {
  test('is 16 hex characters, order independent and sensitive to values and class', () => {
    const a = paramHash('screwdriver', { shaftLength: 100, tip: 'phillips' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(paramHash('screwdriver', { tip: 'phillips', shaftLength: 100 })).toBe(a);
    expect(paramHash('screwdriver', { shaftLength: 100.0004, tip: 'phillips' })).toBe(a);
    expect(paramHash('screwdriver', { shaftLength: 101, tip: 'phillips' })).not.toBe(a);
    expect(paramHash('chisel', { shaftLength: 100, tip: 'phillips' })).not.toBe(a);
  });
});

describe('holdingSummary', () => {
  test('carries the length, hang point, widest section and measured dims of the model', () => {
    const model = generate('tape-roll', {}, 1);
    const summary = holdingSummary(model);
    expect(summary.lengthMm).toBe(model.holding.lengthMm);
    expect(summary.hang?.kind).toBe('hole');
    expect(summary.maxSection.r).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });
});

describe('solveToolDims', () => {
  test('leaves a class alone when the wanted box is already its own', () => {
    const base = boundsDims(generate('screwdriver', {}, 1).bounds);
    const solved = solveToolDims('screwdriver', {}, base);
    expect(solved.reached).toBe(true);
    expect(solved.dims.y).toBeCloseTo(base.y, 3);
    expect(differsFromDims(base, { y: base.y + 0.2 })).toBe(false);
    expect(differsFromDims(base, { y: base.y + 5 })).toBe(true);
  });

  test('a longer screwdriver is built with a longer shaft, the other axes stay put', () => {
    const base = boundsDims(generate('screwdriver', {}, 1).bounds);
    const solved = solveToolDims('screwdriver', {}, { y: base.y + 40 });
    expect(solved.reached).toBe(true);
    expect(Math.abs(solved.dims.y - (base.y + 40))).toBeLessThanOrEqual(DIM_TOLERANCE_MM);
    expect(solved.dims.x).toBeCloseTo(base.x, 0);
    const again = boundsDims(generate('screwdriver', solved.values, 1).bounds);
    expect(again.y).toBeCloseTo(solved.dims.y, 6);
  });

  test('an impossible size ends at the nearest buildable one and says so', () => {
    const solved = solveToolDims('screwdriver', {}, { y: 5000 });
    expect(solved.reached).toBe(false);
    expect(solved.dims.y).toBeGreaterThan(boundsDims(generate('screwdriver', {}, 1).bounds).y);
    expect(solved.dims.y).toBeLessThan(1500);
  });

  test('width and length can be asked for together', () => {
    const base = boundsDims(generate('pliers-combination', {}, 1).bounds);
    const solved = solveToolDims('pliers-combination', {}, { y: base.y * 1.1, x: base.x * 1.1 });
    expect(solved.dims.y).toBeGreaterThan(base.y * 1.05);
    expect(solved.dims.x).toBeGreaterThan(base.x * 1.03);
  });

  test('every class reaches a 10 % longer box or stops at its limit without throwing', () => {
    for (const cls of listToolClasses()) {
      const base = boundsDims(generate(cls.id, {}, 1).bounds);
      const solved = solveToolDims(cls.id, {}, { y: base.y * 1.1 });
      expect(Number.isFinite(solved.dims.y)).toBe(true);
      expect(solved.dims.y).toBeGreaterThanOrEqual(base.y - DIM_TOLERANCE_MM);
    }
  });
});

describe('solveToolDims keeps tools real', () => {
  test('a longer or shorter screwdriver grows or shrinks handle and blade together', () => {
    const base = generate('screwdriver', {}, 1).holding.dims;
    for (const length of [150, 170, 240, 290]) {
      const solved = solveToolDims('screwdriver', {}, { y: length });
      const model = generate('screwdriver', solved.values, 1);
      expect(Math.abs(solved.dims.y - length)).toBeLessThanOrEqual(DIM_TOLERANCE_MM);
      expect(realismProblems('screwdriver', model.bounds, model.holding)).toEqual([]);
      const blade = model.holding.dims['shaftLength'] ?? 0;
      expect(blade).toBeGreaterThanOrEqual(75 * (length < 190 ? 0.55 : 1));
    }
    expect(base['shaftLength']).toBe(100);
  });

  test('a size no real screwdriver has is refused: the nearest real one is built and it says so', () => {
    const tiny = solveToolDims('screwdriver', {}, { y: 60 });
    expect(tiny.reached).toBe(false);
    expect(tiny.dims.y).toBeGreaterThanOrEqual(95);
    const huge = solveToolDims('screwdriver', {}, { y: 900 });
    expect(huge.reached).toBe(false);
    expect(huge.dims.y).toBeLessThanOrEqual(320 + DIM_TOLERANCE_MM);
  });

  test('whatever length is asked of any class, the result is a real tool', () => {
    for (const cls of listToolClasses()) {
      const base = boundsDims(generate(cls.id, {}, 1).bounds);
      for (const factor of [0.5, 0.8, 1.3, 2]) {
        const solved = solveToolDims(cls.id, {}, { y: base.y * factor });
        const model = generate(cls.id, solved.values, 1);
        expect({
          what: `${cls.id} x${factor}`,
          problems: realismProblems(cls.id, model.bounds, model.holding),
        }).toEqual({ what: `${cls.id} x${factor}`, problems: [] });
      }
    }
  });
});

describe('buildWallToolModel', () => {
  test('names the model by the hash of its resolved values and builds both LODs', () => {
    const built = buildWallToolModel('hammer', {}, {});
    expect(built.hash).toBe(paramHash('hammer', built.values));
    expect(built.lod0.lod).toBe(0);
    expect(built.lod1.lod).toBe(1);
    expect(built.lod1.triangles).toBeLessThan(built.lod0.triangles);
  });
});
