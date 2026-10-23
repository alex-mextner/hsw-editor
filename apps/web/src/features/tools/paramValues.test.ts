import { describe, expect, test } from 'bun:test';
import type { ToolClassInfo } from './api.ts';
import { clampToSpec, formatValue, isCustomized, matchingPreset, valuesFor, withParam } from './paramValues.ts';

const LABEL = { en: 'x', ru: 'x' };
const INFO: ToolClassInfo = {
  id: 'screwdriver',
  family: 'drivers',
  familyLabel: LABEL,
  name: LABEL,
  bankClass: 'screwdriver',
  keywords: { en: [], ru: [] },
  schema: {
    shaftLength: { kind: 'num', min: 20, max: 300, def: 100, step: 1, unit: 'mm', label: LABEL, dimension: true },
    tip: { kind: 'choice', options: ['flat', 'phillips'], def: 'flat', label: LABEL },
    handleColor: { kind: 'color', def: '#ff0000', label: LABEL },
  },
  presets: [
    { id: 'ph2', label: LABEL, values: { tip: 'phillips', shaftLength: 150 } },
  ],
  dimsMm: { x: 30, y: 200, z: 30 },
  holdingDims: {},
};

describe('valuesFor', () => {
  test('starts from the defaults and overlays the preset', () => {
    expect(valuesFor(INFO, null)).toEqual({ shaftLength: 100, tip: 'flat', handleColor: '#ff0000' });
    expect(valuesFor(INFO, 'ph2')).toEqual({ shaftLength: 150, tip: 'phillips', handleColor: '#ff0000' });
  });
  test('an unknown preset is the defaults', () => {
    expect(valuesFor(INFO, 'nope')).toEqual(valuesFor(INFO, null));
  });
});

describe('clampToSpec', () => {
  test('clamps numbers, rejects unknown choices and bad colours', () => {
    expect(clampToSpec(INFO.schema.shaftLength!, 9999)).toBe(300);
    expect(clampToSpec(INFO.schema.shaftLength!, 'abc')).toBe(100);
    expect(clampToSpec(INFO.schema.tip!, 'torx')).toBe('flat');
    expect(clampToSpec(INFO.schema.handleColor!, 'red')).toBe('#ff0000');
    expect(clampToSpec(INFO.schema.handleColor!, '#ABCDEF')).toBe('#abcdef');
  });
});

describe('presets', () => {
  test('withParam ignores unknown keys', () => {
    const values = valuesFor(INFO, null);
    expect(withParam(INFO, values, 'bogus', 1)).toBe(values);
    expect(withParam(INFO, values, 'shaftLength', 1).shaftLength).toBe(20);
  });
  test('matchingPreset finds the preset the values equal', () => {
    expect(matchingPreset(INFO, valuesFor(INFO, 'ph2'))).toBe('ph2');
    expect(matchingPreset(INFO, valuesFor(INFO, null))).toBeNull();
  });
  test('isCustomized compares with the starting preset', () => {
    const values = valuesFor(INFO, 'ph2');
    expect(isCustomized(INFO, values, 'ph2')).toBe(false);
    expect(isCustomized(INFO, { ...values, shaftLength: 151 }, 'ph2')).toBe(true);
  });
});

describe('formatValue', () => {
  test('drops float noise', () => {
    expect(formatValue(0.30000000000000004)).toBe('0.3');
    expect(formatValue(12)).toBe('12');
  });
});
