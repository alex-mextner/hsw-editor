import { describe, expect, test } from 'bun:test';
import '../classes/index.ts';
import { at, box, cylinder, place, sphere } from '../build/primitives.ts';
import { METALS, plastic } from '../materials.ts';
import type { Part } from '../model.ts';
import { classDefaults, generate, listToolClasses, presetValues } from '../registry.ts';
import {
  integrateMesh,
  massProperties,
  massPropertiesOfModel,
  materialDensityGcm3,
  partFill,
} from './mass.ts';

const solid = (name: string, mesh: Part['mesh'], material = plastic('#888')): Part => ({
  name,
  role: 'test',
  material,
  mesh,
});
/** A part whose fill is 1 for every material kind (role `test` is not in the fill tables). */
const ofParts = (...parts: Part[]) => massPropertiesOfModel({ classId: 'test', parts });

describe('integrateMesh', () => {
  test('box 10 x 20 x 30: exact volume, centroid, second moments', () => {
    const r = integrateMesh(place(box(10, 20, 30), at(5, 7, 9)));
    expect(r.volumeMm3).toBeCloseTo(6000, 6);
    expect(r.centroidMm[0]).toBeCloseTo(5, 9);
    expect(r.centroidMm[1]).toBeCloseTo(7, 9);
    expect(r.centroidMm[2]).toBeCloseTo(9, 9);
    // ∫x² over a box centred at c with half-width a: V (a²/3 + c²)
    expect(r.secondMoments[0]).toBeCloseTo(6000 * (25 / 3 + 25), 4);
    expect(r.secondMoments[1]).toBeCloseTo(6000 * (100 / 3 + 49), 4);
    expect(r.secondMoments[2]).toBeCloseTo(6000 * (225 / 3 + 81), 4);
    expect(r.secondMoments[3]).toBeCloseTo(6000 * 5 * 7, 4);
  });

  test('sphere: volume, centroid and inertia approach the analytic values', () => {
    const r = 10;
    const m = massPropertiesOfModel({
      classId: 'test',
      parts: [solid('s', sphere(r, 96), { ...plastic('#888'), name: 'x' })],
    });
    const vol = (4 / 3) * Math.PI * r ** 3;
    expect(m.volumeMm3 / vol).toBeGreaterThan(0.99);
    expect(m.volumeMm3 / vol).toBeLessThan(1.001);
    for (const c of m.comMm) expect(Math.abs(c)).toBeLessThan(1e-6);
    const expected = 0.4 * m.massG * r * r;
    for (const k of [0, 4, 8]) expect((m.inertiaGmm2[k] ?? 0) / expected).toBeCloseTo(1, 1);
  });
});

describe('massPropertiesOfModel', () => {
  test('cube 10 mm of density 1 g/cm3 weighs 1 g with inertia m(a²+b²)/12', () => {
    const water = { ...plastic('#888'), name: 'water-like' };
    // plastic is 1.05 g/cm3: compare against the table so the test pins the maths, not the table
    const rho = materialDensityGcm3(water);
    const m = ofParts(solid('cube', box(10, 10, 10), water));
    expect(m.massG).toBeCloseTo(rho, 9);
    const i = (m.massG * 200) / 12;
    expect(m.inertiaGmm2[0]).toBeCloseTo(i, 9);
    expect(m.inertiaGmm2[4]).toBeCloseTo(i, 9);
    expect(m.inertiaGmm2[8]).toBeCloseTo(i, 9);
    expect(m.inertiaGmm2[1]).toBeCloseTo(0, 9);
  });

  test('two boxes combine through the parallel-axis theorem', () => {
    const mat = METALS.steel;
    const a = box(10, 10, 10);
    const m = ofParts(
      solid('a', place(a, at(0, 0, 0)), mat),
      solid('b', place(a, at(0, 30, 0)), mat),
    );
    const single = (1000 * 7.85) / 1000;
    expect(m.massG).toBeCloseTo(2 * single, 9);
    expect(m.comMm[1]).toBeCloseTo(15, 9);
    // about the CoM: each cube's own Ixx + m d², d = 15 along Y
    const own = (single * 200) / 12;
    expect(m.inertiaGmm2[0]).toBeCloseTo(2 * (own + single * 225), 6);
    expect(m.inertiaGmm2[8]).toBeCloseTo(2 * (own + single * 225), 6);
    expect(m.inertiaGmm2[4]).toBeCloseTo(2 * own, 6); // about the line joining them: no shift
  });

  test('mass is proportional to density, geometry is not', () => {
    const mesh = place(cylinder(5, 40, 48), at(3, 20, 0));
    const steel = ofParts(solid('c', mesh, METALS.steel));
    const alu = ofParts(solid('c', mesh, METALS.aluminium));
    expect(alu.massG / steel.massG).toBeCloseTo(2.7 / 7.85, 9);
    expect(alu.comMm[1]).toBeCloseTo(steel.comMm[1], 9);
    expect(alu.inertiaGmm2[0] / steel.inertiaGmm2[0]).toBeCloseTo(2.7 / 7.85, 9);
    expect(alu.volumeMm3).toBeCloseTo(steel.volumeMm3, 9);
  });

  test('densities of the table', () => {
    expect(materialDensityGcm3(METALS.chromeVanadium)).toBe(7.85);
    expect(materialDensityGcm3(METALS.castIron)).toBe(7.2);
    expect(materialDensityGcm3(METALS.brass)).toBe(8.5);
    expect(materialDensityGcm3(METALS.copper)).toBe(8.96);
    expect(materialDensityGcm3(METALS.aluminium)).toBe(2.7);
    expect(partFill({ role: 'blade', name: 'blade', material: METALS.steel })).toBe(1);
    expect(partFill({ role: 'body', name: 'housing', material: plastic('#000') })).toBeLessThan(
      0.5,
    );
  });
});

/** Range checks from catalogue data. */
const check = (
  id: string,
  preset: string | undefined,
  range: [number, number],
): { mass: number; com: readonly number[]; length: number } => {
  const params = preset ? presetValues(id, preset) : classDefaults(id);
  const model = generate(id, params, 1);
  const m = massPropertiesOfModel(model);
  expect(m.massG).toBeGreaterThanOrEqual(range[0]);
  expect(m.massG).toBeLessThanOrEqual(range[1]);
  return { mass: m.massG, com: m.comMm, length: model.bounds.max[1] };
};

describe('real-world validation', () => {
  test('claw hammer 450 g head, hickory handle: 300-700 g, CoM in the head half, 15% from the head', () => {
    for (const preset of [undefined, 'claw-450g']) {
      const r = check('hammer', preset, [300, 700]);
      expect(r.com[1] ?? 0).toBeGreaterThan(0.6 * r.length);
      expect(r.com[1] ?? 0).toBeLessThan(r.length);
    }
  });

  test('screwdriver, 100-150 mm shaft: 60-200 g, CoM nearer the handle', () => {
    for (const preset of ['slotted-classic', 'phillips-ergonomic', 'torx-cushion']) {
      const r = check('screwdriver', preset, [60, 200]);
      expect(r.com[1] ?? 0).toBeLessThan(0.5 * r.length);
    }
  });

  test('tape measure 5 m: 150-450 g', () => {
    check('tape-measure', 'tape-5m-black-red', [150, 450]);
  });

  test('cordless drill with battery: 900-1800 g (12 V: 800-1300 g)', () => {
    check('cordless-drill', 'blue-18v', [900, 1800]);
    check('cordless-drill', 'yellow-20v', [900, 1800]);
    check('cordless-drill', 'orange-12v', [800, 1300]);
  });

  test('combination wrench 8-13 mm: 20-150 g', () => {
    check('wrench-combination', '8', [20, 150]);
    check('wrench-combination', '13', [20, 150]);
  });

  test('combination pliers 180 mm: 150-350 g', () => {
    check('pliers-combination', 'cp-180-red', [150, 350]);
  });
});

describe('every registered class at LOD1', () => {
  for (const cls of listToolClasses()) {
    test(cls.id, () => {
      const model = generate(cls.id, {}, 1);
      const m = massPropertiesOfModel(model);
      expect(Number.isFinite(m.massG)).toBe(true);
      expect(m.massG).toBeGreaterThan(0);
      expect(m.volumeMm3).toBeGreaterThan(0);
      const [lo, hi] = [model.bounds.min, model.bounds.max];
      for (let k = 0; k < 3; k++) {
        expect(m.comMm[k] ?? NaN).toBeGreaterThanOrEqual(lo[k] ?? 0);
        expect(m.comMm[k] ?? NaN).toBeLessThanOrEqual(hi[k] ?? 0);
      }
      const I = m.inertiaGmm2;
      for (const v of I) expect(Number.isFinite(v)).toBe(true);
      expect(I[1]).toBeCloseTo(I[3] ?? 0, 6);
      expect(I[2]).toBeCloseTo(I[6] ?? 0, 6);
      expect(I[5]).toBeCloseTo(I[7] ?? 0, 6);
      // positive definite: leading minors
      const [a, b, c, , d, e, , , f] = I;
      const minor2 = (a ?? 0) * (d ?? 0) - (b ?? 0) * (b ?? 0);
      const det3 =
        (a ?? 0) * ((d ?? 0) * (f ?? 0) - (e ?? 0) * (e ?? 0)) -
        (b ?? 0) * ((b ?? 0) * (f ?? 0) - (e ?? 0) * (c ?? 0)) +
        (c ?? 0) * ((b ?? 0) * (e ?? 0) - (d ?? 0) * (c ?? 0));
      expect(a ?? 0).toBeGreaterThan(0);
      expect(minor2).toBeGreaterThan(0);
      expect(det3).toBeGreaterThan(0);
      for (const p of m.parts) expect(p.massG).toBeGreaterThanOrEqual(0);
    });
  }

  test('massProperties() is generate + massPropertiesOfModel', () => {
    expect(massProperties('hammer').massG).toBeCloseTo(
      massPropertiesOfModel(generate('hammer', {}, 1)).massG,
      9,
    );
  });
});
