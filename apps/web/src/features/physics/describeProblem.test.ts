import { describe, expect, test } from 'bun:test';
import type { RemovalReport } from '@hsw-editor/physics';
import { translate, type Locale } from '@/i18n/index.ts';
import { describeProblem, describeRemovalPath, type ProblemLike } from './describeProblem.ts';

/** Every code the engine emits (`PhysicsProblem` + the bare removal reasons of the suggestions) with real-shaped params. */
const PROBLEMS: readonly ProblemLike[] = [
  { code: 'levitating', params: { gapMm: 14.2 } },
  { code: 'levitating', params: { gapMm: -1 } },
  { code: 'penetrates', params: { depthMm: 3.4 } },
  { code: 'falls', params: { residual: 0.4 } },
  { code: 'tips', params: { aboveMm: 3 } },
  { code: 'swings', params: { swingDeg: 17, swayMm: 42 } },
  { code: 'slides_off', params: { marginG: 0.1, neededG: 0.3 } },
  { code: 'needs_retention', params: { marginG: 0.02, neededG: 0.15 } },
  { code: 'overloaded', params: { massG: 900, maxLoadG: 500 } },
  { code: 'removal_blocked', params: { blockedBy: ['holder-2', 'tool-9'] } },
  { code: 'removal_blocked', params: { blockedBy: [] } },
  { code: 'removal_needs_tilt', params: { path: 'tilt x +15 deg, lift 15 mm, pull' } },
  { code: 'removal_two_hands', params: { reasons: ['heavy', 'cramped'], path: 'lift' } },
  { code: 'removal_two_hands', params: { reasons: [], path: 'lift' } },
  { code: 'blocked', params: { blockedBy: ['holder-2'] } },
  { code: 'needs_tilt', params: { axis: 'x', deg: 15 } },
  { code: 'heavy', params: { massG: 900, limitG: 500 } },
  { code: 'cramped', params: { gapMm: 3, neededMm: 15 } },
  { code: 'long_lift', params: { liftMm: 80, limitMm: 60 } },
  { code: 'tight_clearance', params: { clearanceMm: 2.5 } },
];

const LOCALES: readonly Locale[] = ['en', 'ru'];

describe('describeProblem', () => {
  for (const locale of LOCALES) {
    test(`every problem code reads as a finished sentence in ${locale}`, () => {
      const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
        translate(locale, key, params);
      for (const problem of PROBLEMS) {
        const sentence = describeProblem(problem, t);
        expect(sentence.length).toBeGreaterThan(10);
        // An unfilled {placeholder} means a param the sentence needs was not passed.
        expect(sentence).not.toMatch(/[{}]/);
        expect(sentence).not.toContain('NaN');
        expect(sentence).not.toContain('undefined');
      }
    });
  }

  test('Russian and English differ for every code', () => {
    const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate('en', key, params);
    const ru = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate('ru', key, params);
    for (const problem of PROBLEMS) {
      expect(describeProblem(problem, ru)).not.toBe(describeProblem(problem, en));
    }
  });

  test('parameters land in the sentence, obstacles go through nameOf', () => {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate('en', key, params);
    expect(describeProblem({ code: 'levitating', params: { gapMm: 14.2 } }, t)).toBe(
      'Floats 14.2 mm above its holder: nothing touches it',
    );
    expect(
      describeProblem(
        { code: 'removal_blocked', params: { blockedBy: ['h2'] } },
        t,
        (id) => `Holder ${id}`,
      ),
    ).toBe('Cannot be taken off: blocked by Holder h2');
    expect(
      describeProblem(
        { code: 'removal_needs_tilt', params: { path: 'tilt x +15 deg, lift 15 mm, pull' } },
        t,
      ),
    ).toBe('Needs a tilt to take off (tilt 15° about x, lift 15 mm, pull)');
    expect(
      describeProblem(
        { code: 'removal_two_hands', params: { reasons: ['heavy', 'long_lift'] } },
        t,
      ),
    ).toBe('Needs two hands to take off: it is heavy, it has to be lifted a long way');
  });

  test('an unknown code is named instead of hidden', () => {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate('en', key, params);
    expect(describeProblem({ code: 'zzz', params: {} }, t)).toBe('Physics problem: zzz');
  });
});

describe('describeRemovalPath', () => {
  const report = (patch: Partial<RemovalReport>): RemovalReport => ({
    verdict: 'free',
    convenience: 1,
    clearanceMm: 30,
    neighbourGapMm: 30,
    path: 'lift',
    liftMm: 0,
    pullMm: 0,
    blockedBy: [],
    reasons: [],
    ...patch,
  });
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate('en', key, params);

  test('lift, pull, lift then pull, and a tilt prefix', () => {
    expect(describeRemovalPath(report({ liftMm: 40 }), t)).toBe('lift');
    expect(describeRemovalPath(report({ pullMm: 40 }), t)).toBe('pull');
    expect(describeRemovalPath(report({ liftMm: 15, pullMm: 30 }), t)).toBe('lift 15 mm, pull');
    expect(
      describeRemovalPath(
        report({
          liftMm: 15,
          pullMm: 30,
          reasons: [{ code: 'needs_tilt', params: { axis: 'x', deg: 15 } }],
        }),
        t,
      ),
    ).toBe('tilt 15° about x, lift 15 mm, pull');
  });

  test('a blocked tool has no path', () => {
    expect(describeRemovalPath(report({ path: null }), t)).toBeNull();
  });
});
