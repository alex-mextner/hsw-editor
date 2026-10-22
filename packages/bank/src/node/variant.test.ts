import { describe, expect, test } from 'bun:test';
import { makeElement } from '../testing.ts';
import { normalizeParams, VariantError } from './variant.ts';

function parametric() {
  const element = makeElement({
    id: 'rail-4-d8',
    ru: 'Планка',
    en: 'Rail',
    category: 'holders/screwdrivers',
    generated: true,
  });
  element.params = [
    {
      key: 'slots',
      label: { ru: 'Слотов', en: 'Slots' },
      unit: 'count',
      min: 2,
      max: 10,
      default: 4,
      step: 1,
    },
    {
      key: 'holeDiameter',
      label: { ru: 'Диаметр', en: 'Hole' },
      unit: 'mm',
      min: 3,
      max: 14,
      default: 8,
      step: 0.5,
    },
  ];
  if (element.provenance.generator)
    element.provenance.generator.values = { slots: 4, holeDiameter: 8 };
  return element;
}

describe('normalizeParams', () => {
  test('clamps to the range, snaps to the step and keeps untouched values', () => {
    expect(normalizeParams(parametric(), { slots: 99, holeDiameter: 6.74 })).toEqual({
      slots: 10,
      holeDiameter: 6.5,
    });
    expect(normalizeParams(parametric(), { slots: 1 })).toEqual({ slots: 2, holeDiameter: 8 });
  });

  test('rejects unknown keys (they would reach the OpenSCAD command line) and non-finite numbers', () => {
    expect(() => normalizeParams(parametric(), { 'x=1;y': 1 })).toThrow(VariantError);
    expect(() => normalizeParams(parametric(), { slots: Number.NaN })).toThrow(VariantError);
  });

  test('a source element without generator is a 409', () => {
    const source = makeElement({ id: 's', ru: 'С', en: 'S', category: 'hooks' });
    try {
      normalizeParams(source, { a: 1 });
      throw new Error('expected VariantError');
    } catch (error) {
      expect(error instanceof VariantError && error.status).toBe(409);
    }
  });
});
