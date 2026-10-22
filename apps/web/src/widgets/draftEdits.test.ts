import { describe, expect, test } from 'bun:test';
import type { ParamDef } from '@hsw-editor/bank';
import {
  diffParams,
  normalizeValue,
  stepValue,
  valueOf,
  withValue,
  withoutValue,
} from './draftEdits.ts';

function def(
  key: string,
  min: number,
  max: number,
  fallback: number,
  step: number,
  unit: ParamDef['unit'] = 'mm',
): ParamDef {
  return { key, label: { ru: key, en: key }, unit, min, max, default: fallback, step };
}

const width = def('width', 20, 100, 40, 0.5);
const height = def('height', 10, 50, 20, 0.5);
const slots = def('slots', 1, 12, 6, 1, 'count');
const defs = [width, height, slots];

describe('normalizeValue', () => {
  test('clamps into the range and rounds counts to whole numbers', () => {
    expect(normalizeValue(width, 5)).toBe(20);
    expect(normalizeValue(width, 500)).toBe(100);
    expect(normalizeValue(slots, 4.6)).toBe(5);
  });
});

describe('stepValue', () => {
  test('steps without float noise and stops at the range edges', () => {
    expect(stepValue(width, 40.1, 1)).toBe(40.6);
    expect(stepValue(width, 40, 1, 10)).toBe(45);
    expect(stepValue(width, 40, -1, 0.1)).toBe(39.95);
    expect(stepValue(width, 99.8, 1)).toBe(100);
    expect(stepValue(width, 20, -1)).toBe(20);
  });

  test('counts always move by at least one', () => {
    expect(stepValue(slots, 6, 1, 0.1)).toBe(7);
  });
});

describe('withValue', () => {
  test('changes only the edited param when aspect is free', () => {
    expect(withValue(defs, {}, width, 60, false)).toEqual({ width: 60 });
    expect(withValue(defs, { height: 30 }, width, 60, false)).toEqual({ height: 30, width: 60 });
  });

  test('scales the other mm params proportionally, ignoring counts', () => {
    const next = withValue(defs, { slots: 8 }, width, 80, true);
    expect(next).toEqual({ slots: 8, width: 80, height: 40 });
  });

  test('clamps scaled params into their own ranges', () => {
    const next = withValue(defs, {}, width, 100, true);
    expect(next.width).toBe(100);
    expect(next.height).toBe(50);
  });

  test('derives the ratio from the clamped value, not the requested one', () => {
    const next = withValue(defs, {}, width, 10, true);
    expect(next.width).toBe(20);
    expect(next.height).toBe(10);
  });
});

describe('diffParams and overrides', () => {
  test('reports changed, new and removed keys; null when equal', () => {
    expect(diffParams({ width: 40 }, { width: 40 })).toBeNull();
    expect(diffParams({}, {})).toBeNull();
    expect(diffParams({ width: 40, height: 20 }, { width: 45, slots: 3 })).toEqual({
      set: { width: 45, slots: 3 },
      unset: ['height'],
    });
  });

  test('withoutValue drops the override so the default shows again', () => {
    const rest = withoutValue({ width: 45, height: 12 }, 'width');
    expect(rest).toEqual({ height: 12 });
    expect(valueOf(width, rest)).toBe(40);
    expect(valueOf(height, rest)).toBe(12);
  });
});
