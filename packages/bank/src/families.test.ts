import { describe, expect, test } from 'bun:test';
import { expandFamily, type FamilySpec } from './families.ts';

const spec: FamilySpec = {
  id: 'screwdriver-rail',
  generator: 'families.scad',
  part: 'screwdriver_rail',
  version: 1,
  category: 'holders/screwdrivers',
  toolClasses: ['screwdriver'],
  nameTemplate: {
    ru: 'Планка для отвёрток: {slots} шт., Ø{holeDiameter}',
    en: 'Screwdriver rail: {slots} slots, Ø{holeDiameter}',
  },
  variantTemplate: { ru: '{slots} × Ø{holeDiameter}', en: '{slots} × Ø{holeDiameter}' },
  tags: { ru: ['отвертка'], en: ['screwdriver'] },
  params: [
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
      label: { ru: 'Диаметр отверстия', en: 'Hole diameter' },
      unit: 'mm',
      min: 3,
      max: 14,
      default: 8,
      step: 0.5,
    },
  ],
  grid: { slots: [3, 6], holeDiameter: [5, 6.5, 8] },
  exclude: [{ slots: 6, holeDiameter: 5 }],
  fits: [
    {
      toolClass: 'screwdriver',
      capacity: { param: 'slots' },
      dims: { shaftDiameter: { param: 'holeDiameter', minDelta: -3, maxDelta: -0.5 } },
    },
  ],
  mounting: { kind: 'm3-screw' },
  anchor: 'origin',
};

describe('expandFamily', () => {
  test('expands the grid minus exclusions with unique stable ids', () => {
    const rungs = expandFamily(spec);
    expect(rungs).toHaveLength(5);
    expect(new Set(rungs.map((r) => r.id)).size).toBe(5);
    expect(rungs[0]?.id).toBe('screwdriver-rail-slots3-holediameter5');
    expect(rungs.map((r) => r.id)).not.toContain('screwdriver-rail-slots6-holediameter5');
  });

  test('derives names, capacity and fit ranges from the rung values', () => {
    const rung = expandFamily(spec).find((r) => r.id.endsWith('slots6-holediameter6p5'));
    expect(rung?.name.en).toBe('Screwdriver rail: 6 slots, Ø6.5');
    expect(rung?.fitsTool[0]?.capacity).toBe(6);
    expect(rung?.fitsTool[0]?.dims?.shaftDiameter).toEqual({ min: 3.5, max: 6 });
  });

  test('rejects grid values outside the declared param range and unknown params', () => {
    expect(() => expandFamily({ ...spec, grid: { slots: [20] } })).toThrow(/outside/);
    expect(() => expandFamily({ ...spec, grid: { nope: [1] } })).toThrow(/undeclared/);
  });

  test('rejects exclude rules that are empty or name a non-grid key', () => {
    expect(() => expandFamily({ ...spec, exclude: [{}] })).toThrow(/empty exclude rule/);
    expect(() =>
      expandFamily({
        ...spec,
        fixed: { holeDiameter: 8 },
        grid: { slots: [3] },
        exclude: [{ holeDiameter: 8 }],
      }),
    ).toThrow(/not a grid param/);
    expect(() => expandFamily({ ...spec, exclude: [{ wall: 2 }] })).toThrow(/not a grid param/);
  });
});
