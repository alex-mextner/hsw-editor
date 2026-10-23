import { describe, expect, test } from 'bun:test';
import {
  type Context,
  evaluateWhen,
  matchesWhen,
  parseWhen,
  whenKeys,
  whenMayOverlap,
} from './when.ts';

function holds(source: string, context: Context): boolean {
  const parsed = parseWhen(source);
  if (!parsed.ok) throw new Error(parsed.error);
  return evaluateWhen(parsed.expr, context);
}

describe('when-clause evaluation', () => {
  test('bare keys are truthy checks', () => {
    expect(holds('selection', { selection: true })).toBe(true);
    expect(holds('selection', { selection: false })).toBe(false);
    expect(holds('selection', {})).toBe(false);
    expect(holds('count', { count: 0 })).toBe(false);
    expect(holds('count', { count: 2 })).toBe(true);
    expect(holds('mode', { mode: '' })).toBe(false);
  });

  test('negation, and, or and parentheses', () => {
    const ctx = { selection: true, dialog: false, inputFocus: true };
    expect(holds('selection && !dialog', ctx)).toBe(true);
    expect(holds('selection && !inputFocus', ctx)).toBe(false);
    expect(holds('dialog || inputFocus', ctx)).toBe(true);
    expect(holds('!(dialog || inputFocus)', ctx)).toBe(false);
    expect(holds('selection && (dialog || inputFocus)', ctx)).toBe(true);
    expect(holds('!!selection', ctx)).toBe(true);
  });

  test('and binds tighter than or', () => {
    expect(holds('a || b && c', { a: true, b: false, c: false })).toBe(true);
    expect(holds('(a || b) && c', { a: true, b: false, c: false })).toBe(false);
  });

  test('equality compares the stringified value', () => {
    expect(holds("mode == 'photo'", { mode: 'photo' })).toBe(true);
    expect(holds('mode == photo', { mode: 'photo' })).toBe(true);
    expect(holds('mode != photo', { mode: 'wall' })).toBe(true);
    expect(holds('mode != photo', {})).toBe(true);
    expect(holds('mode == photo', {})).toBe(false);
    expect(holds('selectionCount == 2', { selectionCount: 2 })).toBe(true);
  });

  test('dotted context keys', () => {
    expect(holds('setting.appearance.grid', { 'setting.appearance.grid': true })).toBe(true);
  });

  test('syntax errors are reported, never thrown', () => {
    for (const bad of ['', '&&', 'a &&', '(a', 'a b', 'a == ', "a == 'x", '!', 'a $ b']) {
      expect(parseWhen(bad).ok).toBe(false);
    }
  });

  test('a clause that does not parse is never true; an absent clause always is', () => {
    expect(matchesWhen('a &&', { a: true })).toBe(false);
    expect(matchesWhen(undefined, {})).toBe(true);
  });

  test('keys collects every referenced key', () => {
    const parsed = parseWhen("a && !(b || c == 'x')");
    if (!parsed.ok) throw new Error(parsed.error);
    expect([...whenKeys(parsed.expr)].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('when-clause overlap', () => {
  test('contradictions never overlap', () => {
    expect(whenMayOverlap('dialog', '!dialog')).toBe(false);
    expect(whenMayOverlap("mode == 'a'", "mode == 'b'")).toBe(false);
    expect(whenMayOverlap("mode == 'a'", "mode != 'a'")).toBe(false);
    expect(whenMayOverlap('selection && dialog', '!dialog && selection')).toBe(false);
  });

  test('independent or compatible clauses overlap', () => {
    expect(whenMayOverlap('selection', 'dialog')).toBe(true);
    expect(whenMayOverlap(undefined, 'dialog')).toBe(true);
    expect(whenMayOverlap('selection', undefined)).toBe(true);
    expect(whenMayOverlap("mode == 'a'", "mode != 'b'")).toBe(true);
    expect(whenMayOverlap('a || b', '!a')).toBe(true);
  });

  test('negation pushes through and/or (De Morgan)', () => {
    expect(whenMayOverlap('!(a || b)', 'a')).toBe(false);
    expect(whenMayOverlap('!(a && b)', 'a && b')).toBe(false);
    expect(whenMayOverlap('!(a && b)', 'a')).toBe(true);
  });

  test('unparsable clauses count as overlapping so no conflict is hidden', () => {
    expect(whenMayOverlap('a &&', '!a')).toBe(true);
  });
});
