import { describe, expect, test } from 'bun:test';
import { analyzeMesh } from './mesh.ts';
import { exportGlb } from './glb.ts';
import { type Lod } from './model.ts';
import { TOOL_CLASSES } from '@hsw-editor/bank';
import { generate, getToolClass, hasToolClass, listToolClasses, presetValues } from './registry.ts';
import './classes/index.ts';
import { type AnyValues } from './params.ts';

function assertWatertight(classId: string, values: AnyValues, lod: Lod): void {
  const model = generate(classId, values, lod);
  expect(model.parts.length).toBeGreaterThan(0);
  for (const part of model.parts) {
    const r = analyzeMesh(part.mesh);
    if (!r.watertight) {
      throw new Error(
        `${classId}/${part.name} (lod ${lod}) not watertight: open=${r.openEdges} bad=${r.badEdges} degenerate=${r.degenerateTriangles} volume=${r.volumeMm3.toFixed(1)} values=${JSON.stringify(values)}`,
      );
    }
  }
  const size = model.bounds.max.map((v, i) => v - (model.bounds.min[i] ?? 0));
  for (const s of size) expect(Number.isFinite(s)).toBe(true);
  expect(Math.max(...size)).toBeGreaterThan(5);
  expect(Math.max(...size)).toBeLessThan(Math.max(900, 1.3 * (model.holding.dims.length ?? 0)));
}

describe('tool registry', () => {
  test('every class has unique id, valid defaults and named presets', () => {
    const ids = new Set<string>();
    for (const cls of listToolClasses()) {
      expect(ids.has(cls.id)).toBe(false);
      ids.add(cls.id);
      expect(cls.presets.length).toBeGreaterThan(0);
      expect(cls.keywords.en.length).toBeGreaterThan(0);
      for (const preset of cls.presets) expect(() => presetValues(cls.id, preset.id)).not.toThrow();
    }
    expect(hasToolClass('screwdriver')).toBe(true);
  });

  for (const cls of listToolClasses()) {
    describe(cls.id, () => {
      test('defaults and presets are watertight at both LODs, LOD1 is lighter', () => {
        for (const lod of [0, 1] as const) {
          assertWatertight(cls.id, {}, lod);
          for (const p of cls.presets) assertWatertight(cls.id, presetValues(cls.id, p.id), lod);
        }
        expect(generate(cls.id, {}, 1).triangles).toBeLessThan(generate(cls.id, {}, 0).triangles);
      });

      test('range extremes of every numeric parameter stay watertight', () => {
        for (const [key, spec] of Object.entries(cls.schema)) {
          if (spec.kind !== 'num') continue;
          for (const v of [spec.min, spec.max]) assertWatertight(cls.id, { [key]: v }, 1);
        }
      });

      test('every choice option builds', () => {
        for (const [key, spec] of Object.entries(cls.schema)) {
          if (spec.kind !== 'choice') continue;
          for (const o of spec.options) assertWatertight(cls.id, { [key]: o }, 1);
        }
      });

      test('holding interface is consistent and the GLB is well formed', () => {
        const model = generate(cls.id, {}, 0);
        const h = model.holding;
        expect(h.lengthMm).toBeGreaterThan(5);
        expect(h.profile.samples.length).toBeGreaterThan(3);
        expect(h.maxSection.r).toBeGreaterThan(0.5);
        expect(h.zones.length).toBeGreaterThan(0);
        for (const z of h.zones) expect(z.y1).toBeGreaterThan(z.y0);
        for (const v of Object.values(h.dims)) expect(Number.isFinite(v)).toBe(true);
        const glb = exportGlb(model);
        const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
        expect(dv.getUint32(0, true)).toBe(0x46546c67);
        expect(dv.getUint32(8, true)).toBe(glb.byteLength);
        const jsonLen = dv.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen))) as {
          meshes: { name: string }[];
          materials: unknown[];
        };
        expect(json.meshes.map((m) => m.name)).toEqual(model.parts.map((p) => p.name));
        expect(json.materials.length).toBeGreaterThan(0);
      });
    });
  }
});

describe('bank vocabulary', () => {
  const vocabulary = new Map(TOOL_CLASSES.map((entry) => [entry.id, entry]));

  test('every generator class maps to a class of the bank vocabulary', () => {
    const unknown = listToolClasses()
      .filter((cls) => !vocabulary.has(cls.bankClass))
      .map((cls) => `${cls.id} -> ${cls.bankClass}`);
    expect(unknown).toEqual([]);
  });

  test('every `broader` target exists and is not itself refined (no chains)', () => {
    const problems: string[] = [];
    for (const entry of TOOL_CLASSES) {
      if (entry.broader === undefined) continue;
      const target = vocabulary.get(entry.broader);
      if (target === undefined) problems.push(`${entry.id}: unknown target ${entry.broader}`);
      else if (target.broader !== undefined) problems.push(`${entry.id}: chain via ${target.id}`);
    }
    expect(problems).toEqual([]);
  });

  test('the finer generator classes use their own bank class', () => {
    const bankClassOf = (id: string): string => getToolClass(id).bankClass;
    expect(bankClassOf('chisel')).toBe('chisel');
    expect(bankClassOf('punch')).toBe('punch');
    expect(bankClassOf('hacksaw')).toBe('hacksaw');
    expect(bankClassOf('spirit-level')).toBe('level');
    expect(bankClassOf('square-try')).toBe('square');
    expect(bankClassOf('pliers-long-nose')).toBe('long-nose-pliers');
    expect(bankClassOf('locking-pliers')).toBe('locking-pliers');
    expect(bankClassOf('water-pump-pliers')).toBe('water-pump-pliers');
    expect(bankClassOf('crimper-stripper')).toBe('crimper');
    expect(bankClassOf('hex-key-set')).toBe('hex-key-set');
  });
});
