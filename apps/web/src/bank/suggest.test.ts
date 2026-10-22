import { describe, expect, test } from 'bun:test';
import type { BankElement, FitsTool } from '@hsw-editor/bank';
import { dimScore, familyOf, fitScore, holdersForToolClass, NEUTRAL_SCORE } from './suggest.ts';

interface Spec {
  readonly id: string;
  readonly fits?: readonly FitsTool[];
  readonly cells?: number;
  readonly family?: string;
  readonly label?: string;
  readonly dims?: readonly [number, number, number];
}

function element(spec: Spec): BankElement {
  const [x, y, z] = spec.dims ?? [10, 10, 10];
  return {
    id: spec.id,
    fitsTool: spec.fits ?? [],
    footprint: { cells: Array.from({ length: spec.cells ?? 1 }, () => ({ dCol: 0, dRow2: 0 })) },
    dimsMm: { x, y, z },
    ...(spec.family === undefined ? {} : { family: spec.family }),
    ...(spec.label === undefined ? {} : { variantLabel: { ru: spec.label, en: spec.label } }),
  } as unknown as BankElement;
}

const screwdriver = (dims: FitsTool['dims'], capacity?: number): FitsTool => ({
  toolClass: 'screwdriver',
  ...(dims ? { dims } : {}),
  ...(capacity === undefined ? {} : { capacity }),
});

describe('dimScore', () => {
  const range = { min: 5, max: 8 };

  test('is 1 inside the range, edges included', () => {
    expect(dimScore(5, range)).toBe(1);
    expect(dimScore(6.5, range)).toBe(1);
    expect(dimScore(8, range)).toBe(1);
  });

  test('decays with distance outside the range and stays in (0, 1)', () => {
    const near = dimScore(8.4, range);
    const far = dimScore(12, range);
    expect(near).toBeLessThan(1);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    expect(dimScore(2, range)).toBeLessThan(dimScore(4.5, range));
  });
});

describe('fitScore', () => {
  const fit = screwdriver({ shaftDiameter: { min: 5, max: 8 }, width: { min: 20, max: 40 } });

  test('is neutral without measured dims or without constraints', () => {
    expect(fitScore(fit, undefined)).toBe(NEUTRAL_SCORE);
    expect(fitScore(fit, {})).toBe(NEUTRAL_SCORE);
    expect(fitScore(screwdriver(undefined), { shaftDiameter: 6 })).toBe(NEUTRAL_SCORE);
  });

  test('a missing dimension counts as neutral next to a matching one', () => {
    const score = fitScore(fit, { shaftDiameter: 6 });
    expect(score).toBeGreaterThan(NEUTRAL_SCORE);
    expect(score).toBeLessThan(1);
  });

  test('one bad dimension drags the score below an all-neutral holder', () => {
    expect(fitScore(fit, { shaftDiameter: 6, width: 400 })).toBeLessThan(NEUTRAL_SCORE);
    expect(fitScore(fit, { shaftDiameter: 6, width: 30 })).toBe(1);
  });
});

describe('holdersForToolClass', () => {
  const tight = element({
    id: 'tight',
    fits: [screwdriver({ shaftDiameter: { min: 3, max: 5 } })],
  });
  const roomy = element({
    id: 'roomy',
    fits: [screwdriver({ shaftDiameter: { min: 5, max: 9 } })],
  });
  const other = element({
    id: 'pliers-rack',
    fits: [{ toolClass: 'pliers', dims: { width: { min: 1, max: 99 } } }],
  });
  const index = { elements: [tight, other, roomy] };

  test('keeps only elements that list the class, best fit first', () => {
    const ranked = holdersForToolClass(index, 'screwdriver', { shaftDiameter: 7 });
    expect(ranked.map((entry) => entry.element.id)).toEqual(['roomy', 'tight']);
    expect(ranked[0]?.score).toBe(1);
    expect(ranked[1]?.score).toBeLessThan(1);
    for (const entry of ranked) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }
  });

  test('scores neutral and orders by capacity, footprint, id when dims are absent', () => {
    const big = element({ id: 'big', cells: 4, fits: [screwdriver(undefined, 6)] });
    const small = element({ id: 'small', cells: 1, fits: [screwdriver(undefined, 6)] });
    const few = element({ id: 'few', cells: 1, fits: [screwdriver(undefined, 2)] });
    const ranked = holdersForToolClass({ elements: [few, big, small] }, 'screwdriver');
    expect(ranked.map((entry) => entry.element.id)).toEqual(['small', 'big', 'few']);
    expect(ranked.every((entry) => entry.score === NEUTRAL_SCORE)).toBe(true);
  });

  test('returns nothing for an unknown class', () => {
    expect(holdersForToolClass(index, 'hammer', { shaftDiameter: 7 })).toEqual([]);
  });
});

describe('familyOf', () => {
  test('lists siblings ordered by numeric-aware label, then dims', () => {
    const twelve = element({ id: 'rack-12', family: 'rack', label: '12 slots' });
    const six = element({ id: 'rack-6', family: 'rack', label: '6 slots' });
    const unlabelledBig = element({ id: 'rack-x', family: 'rack', dims: [50, 10, 10] });
    const unlabelledSmall = element({ id: 'rack-y', family: 'rack', dims: [20, 10, 10] });
    const stranger = element({ id: 'other', family: 'other-family', label: '1 slot' });
    const family = familyOf(
      { elements: [unlabelledBig, twelve, stranger, six, unlabelledSmall] },
      twelve,
    );
    expect(family.map((member) => member.id)).toEqual(['rack-6', 'rack-12', 'rack-y', 'rack-x']);
  });

  test('an element without a family is alone, and a missing element is still included', () => {
    const solo = element({ id: 'solo' });
    expect(familyOf({ elements: [solo, element({ id: 'b' })] }, solo)).toEqual([solo]);
    const ghost = element({ id: 'ghost', family: 'f' });
    expect(familyOf({ elements: [element({ id: 'a', family: 'f' })] }, ghost)).toHaveLength(2);
  });
});
