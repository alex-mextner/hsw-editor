import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMesh } from '../mesh.ts';
import { generate, presetValues } from '../registry.ts';
import '../classes/index.ts';
import { ToolStore } from '../node/store.ts';
import { fitClassToProfile } from './fit.ts';
import { fitObject, observeModel, typicalLengthMm } from './create.ts';
import { ToolInputError } from './errors.ts';
import { createManualTool } from './manual.ts';
import { applyPatch } from './rebuild.ts';
import { CustomToolPatchSchema, CustomToolSchema, type CustomTool } from './schema.ts';
import { normalizeTags, unionTags } from './tags.ts';

describe('profile fit', () => {
  test('recovers a screwdriver of a different size from its silhouette profile', () => {
    const truth = generate('screwdriver', presetValues('screwdriver', 'phillips-ergonomic'), 0);
    const obs = observeModel(truth);
    const fit = fitClassToProfile('screwdriver', obs);
    expect(fit.iou).toBeGreaterThan(0.85);
    expect(Math.abs(fit.lengthMm - obs.lengthMm) / obs.lengthMm).toBeLessThan(0.04);
    expect(fit.evals).toBeLessThan(300);
  });

  test('finds the flipped orientation when the wide end is the far end', () => {
    const truth = generate('screwdriver', {}, 0);
    const obs = observeModel(truth);
    const reversed = {
      ...obs,
      stations: [...obs.stations]
        .reverse()
        .map((s, i) => ({ ...s, t: (i + 0.5) / obs.stations.length })),
    };
    const fit = fitClassToProfile('screwdriver', reversed);
    expect(fit.flipped).toBe(true);
    expect(fit.iou).toBeGreaterThan(0.85);
  });
});

describe('fitObject', () => {
  test('takes the suggested class, maps photo colours onto parts and builds both LODs watertight', () => {
    const truth = generate('screwdriver', presetValues('screwdriver', 'torx-cushion'), 0);
    const fitted = fitObject({
      profile: observeModel(truth),
      colors: [
        { t0: 0, t1: 0.5, hex: '#2455a8', weight: 0.6 },
        { t0: 0.5, t1: 1, hex: '#b9bcc1', weight: 0.4 },
      ],
      candidates: [
        { classId: 'screwdriver', score: 0.7 },
        { classId: 'screwdriver', score: 0.1 },
      ],
      dimensionSource: 'photo',
    });
    expect(fitted.classId).toBe('screwdriver');
    expect(fitted.fit.method).toBe('class-profile');
    const handle = fitted.model.parts.find((p) => p.name === 'handle');
    expect(handle?.material.color).toBe('#2455a8');
    for (const m of [fitted.model, fitted.modelLod1]) {
      for (const p of m.parts) expect(analyzeMesh(p.mesh).watertight).toBe(true);
    }
    expect(fitted.modelLod1.triangles).toBeLessThan(fitted.model.triangles);
  });

  test('falls back to a generic loft when no class fits, one part per colour segment', () => {
    const profile = {
      lengthMm: 120,
      stations: Array.from({ length: 12 }, (_, i) => {
        const t = (i + 0.5) / 12;
        const w = 18 + 10 * Math.sin(t * Math.PI);
        return { t, lo: -w / 2, hi: w / 2 };
      }),
    };
    const fitted = fitObject(
      {
        profile,
        colors: [
          { t0: 0, t1: 0.4, hex: '#c8262b', weight: 0.5 },
          { t0: 0.4, t1: 1, hex: '#1b1c1e', weight: 0.5 },
        ],
        candidates: [],
        dimensionSource: 'photo',
        profileKind: 'lathe_profile',
      },
      {},
    );
    expect(fitted.classId).toBeNull();
    expect(fitted.model.parts.length).toBe(2);
    for (const p of fitted.model.parts) expect(analyzeMesh(p.mesh).watertight).toBe(true);
    expect(fitted.dimensionsMm.length).toBeCloseTo(120, 0);
  });

  test('user dimensions rescale the fit', () => {
    const truth = generate('screwdriver', {}, 0);
    const fitted = fitObject({
      profile: observeModel(truth),
      colors: [],
      candidates: [{ classId: 'screwdriver', score: 0.9 }],
      dimensionsMm: { length: 150 },
      dimensionSource: 'user',
    });
    expect(fitted.dimensionsMm.length).toBeGreaterThan(140);
    expect(fitted.dimensionsMm.length).toBeLessThan(160);
  });
});

describe('tool store', () => {
  test('saves, lists, patches and trashes a tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hsw-tools-'));
    try {
      const store = new ToolStore(root);
      const truth = generate('screwdriver', {}, 0);
      const fitted = fitObject({
        profile: observeModel(truth),
        colors: [{ t0: 0, t1: 1, hex: '#c8262b', weight: 1 }],
        candidates: [{ classId: 'screwdriver', score: 0.8 }],
        dimensionSource: 'photo',
      });
      const now = new Date().toISOString();
      const id = await store.freeId('My screwdriver');
      const saved = await store.save(
        {
          version: 1,
          id,
          tags: ['kept'],
          name: { en: 'My screwdriver' },
          createdAt: now,
          updatedAt: now,
          classId: fitted.classId,
          classCandidates: [{ classId: 'screwdriver', score: 0.8 }],
          params: fitted.params,
          profile: fitted.profile,
          colors: [{ t0: 0, t1: 1, hex: '#c8262b', weight: 1 }],
          partColors: fitted.partColors,
          dimensionsMm: fitted.dimensionsMm,
          fit: fitted.fit,
          sources: [{ file: 'photo.jpg' }],
        },
        fitted,
        [{ name: 'photo.jpg', bytes: new Uint8Array([1, 2, 3]) }],
      );
      expect(CustomToolSchema.safeParse(saved).success).toBe(true);
      expect((await readdir(join(root, id))).sort()).toEqual([
        'model-lod1.glb',
        'model.glb',
        'source',
        'thumb.webp',
        'tool.json',
      ]);
      expect((await store.list()).map((t) => t.id)).toEqual([id]);
      expect((await store.list())[0]?.tags).toEqual(['kept']);
      const patched = applyPatch(
        saved as CustomTool,
        CustomToolPatchSchema.parse({
          name: { ru: 'Моя отвёртка' },
          partColors: { handle: '#2455a8' },
          tags: ['Blue ', 'blue', 'Driver'],
        }),
      );
      expect(patched.tool.tags).toEqual(['blue', 'driver']);
      expect(patched.tool.name).toEqual({ en: 'My screwdriver', ru: 'Моя отвёртка' });
      expect(patched.model.parts.find((p) => p.name === 'handle')?.material.color).toBe('#2455a8');
      await store.remove(id);
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('tool store hardening', () => {
  const fitted = fitObject({
    profile: observeModel(generate('screwdriver', {}, 0)),
    colors: [{ t0: 0, t1: 1, hex: '#c8262b', weight: 1 }],
    candidates: [{ classId: 'screwdriver', score: 0.8 }],
    dimensionSource: 'photo',
  });
  const docFor = (id: string, nameEn = 'Driver'): Omit<CustomTool, 'model'> => {
    const now = new Date().toISOString();
    return {
      version: 1,
      id,
      tags: [],
      name: { en: nameEn },
      createdAt: now,
      updatedAt: now,
      classId: fitted.classId,
      classCandidates: [],
      params: fitted.params,
      profile: fitted.profile,
      colors: [],
      partColors: fitted.partColors,
      dimensionsMm: fitted.dimensionsMm,
      fit: fitted.fit,
      sources: [],
    };
  };
  const withStore = async (
    work: (store: ToolStore, root: string) => Promise<void>,
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'hsw-tools-'));
    try {
      await work(new ToolStore(root), root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  const brokenSource = {
    name: 'photo.jpg',
    get bytes(): Uint8Array {
      throw new Error('disk full');
    },
  };

  test('exists() sees a directory that has no tool.json, so freeId never hands out its name', async () => {
    await withStore(async (store, root) => {
      await mkdir(join(root, 'driver', 'source'), { recursive: true });
      expect(await store.exists('driver')).toBe(true);
      expect(await store.freeId('Driver')).toBe('driver-2');
      expect(await store.exists('other')).toBe(false);
    });
  });

  test('a tool that does not fit the schema is refused before anything is written', async () => {
    await withStore(async (store, root) => {
      await expect(
        store.save(docFor('driver', 'x'.repeat(200)), fitted, [
          { name: 'photo.jpg', bytes: new Uint8Array([1]) },
        ]),
      ).rejects.toMatchObject({ code: 'corrupt' });
      expect(await readdir(root)).toEqual([]);
      await expect(
        store.save(docFor('driver'), fitted, [{ name: '../evil', bytes: new Uint8Array([1]) }]),
      ).rejects.toMatchObject({ code: 'invalid_id' });
      expect(await readdir(root)).toEqual([]);
    });
  });

  test('a save that fails half way removes the directory it created, so a reused id inherits nothing', async () => {
    await withStore(async (store, root) => {
      await expect(store.save(docFor('driver'), fitted, [brokenSource])).rejects.toThrow(
        'disk full',
      );
      expect(await readdir(root)).toEqual([]);
      await store.save(docFor('driver'), fitted, []);
      expect(await readdir(join(root, 'driver', 'source'))).toEqual([]);
    });
  });

  test('a failed re-save of an existing tool keeps that tool', async () => {
    await withStore(async (store, root) => {
      await store.save(docFor('driver'), fitted, []);
      await expect(store.save(docFor('driver'), fitted, [brokenSource])).rejects.toThrow(
        'disk full',
      );
      expect((await store.get('driver')).id).toBe('driver');
      expect(await readdir(root)).toEqual(['driver']);
    });
  });
});

describe('tool patches', () => {
  const profile = {
    lengthMm: 120,
    stations: Array.from({ length: 12 }, (_, i) => {
      const t = (i + 0.5) / 12;
      const w = 18 + 10 * Math.sin(t * Math.PI);
      return { t, lo: -w / 2, hi: w / 2 };
    }),
  };
  const colors = [{ t0: 0, t1: 1, hex: '#c8262b', weight: 1 }];
  const docOf = (fitted: ReturnType<typeof fitObject>, profileKind?: string): CustomTool => {
    const now = new Date().toISOString();
    return {
      version: 1,
      id: 'x',
      tags: [],
      name: {},
      createdAt: now,
      updatedAt: now,
      classId: fitted.classId,
      classCandidates: [],
      params: fitted.params,
      profile: fitted.profile,
      colors,
      partColors: fitted.partColors,
      ...(profileKind ? { profileKind } : {}),
      dimensionsMm: fitted.dimensionsMm,
      fit: fitted.fit,
      sources: [],
      model: {
        glb: 'model.glb',
        glbLod1: 'model-lod1.glb',
        thumb: 'thumb.webp',
        triangles: fitted.model.triangles,
        bboxMm: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    };
  };

  test('renaming a generic loft keeps its geometry (thickness of a round object included)', () => {
    const fitted = fitObject({
      profile,
      colors,
      candidates: [],
      dimensionSource: 'photo',
      profileKind: 'lathe_profile',
    });
    const before = fitted.dimensionsMm.thickness;
    expect(before).toBeGreaterThan(20);
    const patched = applyPatch(docOf(fitted, 'lathe_profile'), { name: { en: 'Bottle' } });
    expect(patched.tool.name.en).toBe('Bottle');
    expect(patched.tool.dimensionsMm.thickness).toBeCloseTo(before, 3);
  });

  test('an estimated size follows the class when a saved tool changes class; a typed length replaces it', () => {
    const fitted = fitObject({
      profile: observeModel(generate('screwdriver', {}, 0)),
      colors: [],
      candidates: [{ classId: 'screwdriver', score: 0.9 }],
      dimensionsMm: { length: typicalLengthMm('screwdriver') },
      dimensionSource: 'estimated',
    });
    const doc = docOf(fitted);
    expect(doc.dimensionsMm.source).toBe('estimated');
    const asHammer = applyPatch(doc, { classId: 'hammer' });
    expect(asHammer.tool.classId).toBe('hammer');
    expect(asHammer.tool.dimensionsMm.source).toBe('estimated');
    const hammer = typicalLengthMm('hammer');
    expect(asHammer.tool.dimensionsMm.length).toBeGreaterThan(hammer * 0.9);
    expect(asHammer.tool.dimensionsMm.length).toBeLessThan(hammer * 1.1);
    const typed = applyPatch(doc, { dimensionsMm: { length: 300 } });
    expect(typed.tool.dimensionsMm.source).toBe('user');
    // the estimate belongs to a class: a generic shape needs a typed length instead
    expect(() => applyPatch(doc, { classId: null })).toThrow(ToolInputError);
    expect(
      applyPatch(doc, { classId: null, dimensionsMm: { length: 120 } }).tool.classId,
    ).toBeNull();
    // a new class plus a typed width: the length still follows the class, and stays an estimate
    const both = applyPatch(doc, { classId: 'hammer', dimensionsMm: { width: 20 } });
    expect(both.tool.dimensionsMm.source).toBe('estimated');
    expect(both.tool.dimensionsMm.length).toBeGreaterThan(hammer * 0.9);
    expect(both.tool.dimensionsMm.length).toBeLessThan(hammer * 1.1);
  });

  test('a later length edit keeps the earlier thickness edit of a class tool', () => {
    const truth = generate('screwdriver', {}, 0);
    const fitted = fitObject({
      profile: observeModel(truth),
      colors: [],
      candidates: [{ classId: 'screwdriver', score: 0.9 }],
      dimensionsMm: { thickness: 40 },
      dimensionSource: 'user',
    });
    const doc = docOf(fitted);
    const after = applyPatch(doc, { dimensionsMm: { length: 200 } });
    expect(after.tool.dimensionsMm.thickness).toBeGreaterThan(35);
    expect(after.tool.dimensionsMm.length).toBeGreaterThan(185);
    expect(after.tool.dimensionsMm.length).toBeLessThan(215);
  });

  test('user part colours are kept apart from the sampled ones, and a class change re-samples', () => {
    const twoColors = [
      { t0: 0, t1: 0.5, hex: '#2455a8', weight: 0.6 },
      { t0: 0.5, t1: 1, hex: '#b9bcc1', weight: 0.4 },
    ];
    const input = {
      profile: observeModel(generate('screwdriver', {}, 0)),
      colors: twoColors,
      candidates: [{ classId: 'screwdriver', score: 0.9 }],
      dimensionSource: 'photo' as const,
    };
    const fitted = fitObject(input);
    const doc: CustomTool = { ...docOf(fitted), colors: twoColors };
    expect(doc.userPartColors).toBeUndefined();

    // a user colour goes to userPartColors; the sampled mapping is untouched
    const edited = applyPatch(doc, { partColors: { handle: '#00ff00' } });
    expect(edited.tool.partColors).toEqual(fitted.partColors);
    expect(edited.tool.userPartColors).toEqual({ handle: '#00ff00' });
    expect(edited.model.parts.find((p) => p.name === 'handle')?.material.color).toBe('#00ff00');

    // a later class change re-samples from the photo colours: nothing of the old fit's sampling survives
    const asHammer = applyPatch(
      { ...doc, ...edited.tool, model: doc.model },
      { classId: 'hammer' },
    );
    const freshHammer = fitObject(input, { classId: 'hammer' });
    expect(asHammer.tool.partColors).toEqual(freshHammer.partColors);
    expect(asHammer.tool.userPartColors).toEqual({ handle: '#00ff00' });
  });

  test('colours a tool saved before userPartColors kept in partColors survive refits as user colours', () => {
    const generic = fitObject({ profile, colors, candidates: [], dimensionSource: 'photo', profileKind: 'lathe_profile' });
    const legacyGeneric: CustomTool = { ...docOf(generic, 'lathe_profile'), partColors: { body: '#00ff00' } };
    const renamed = applyPatch(legacyGeneric, { name: { en: 'Bottle' } });
    expect(renamed.tool.userPartColors).toEqual({ body: '#00ff00' });

    const twoColors = [
      { t0: 0, t1: 0.5, hex: '#2455a8', weight: 0.6 },
      { t0: 0.5, t1: 1, hex: '#b9bcc1', weight: 0.4 },
    ];
    const fitted = fitObject({
      profile: observeModel(generate('screwdriver', {}, 0)),
      colors: twoColors,
      candidates: [{ classId: 'screwdriver', score: 0.9 }],
      dimensionSource: 'photo',
    });
    const legacyClass: CustomTool = {
      ...docOf(fitted),
      colors: twoColors,
      partColors: { ...fitted.partColors, handle: '#00ff00' },
    };
    const resized = applyPatch(legacyClass, { dimensionsMm: { length: 200 } });
    expect(resized.tool.userPartColors).toEqual({ handle: '#00ff00' });
    expect(resized.model.parts.find((p) => p.name === 'handle')?.material.color).toBe('#00ff00');

    // a legacy tool with nothing to split is marked migrated, so a params edit cannot change what a later split sees
    const untouched: CustomTool = { ...docOf(fitted), colors: twoColors, partColors: fitted.partColors };
    const migrated = applyPatch(untouched, { params: { ...untouched.params } });
    expect(migrated.tool.userPartColors).toEqual({});
    const toHammer = applyPatch({ ...untouched, ...migrated.tool, model: untouched.model }, { classId: 'hammer' });
    expect(toHammer.tool.userPartColors).toEqual({});
    expect(toHammer.tool.partColors).toEqual(fitObject({ profile: observeModel(generate('screwdriver', {}, 0)), colors: twoColors, candidates: [], dimensionSource: 'photo' }, { classId: 'hammer' }).partColors);

    // a tool saved by the current code is never split: photo colours of a gapped segmentation stay sampled
    const gapped = [
      { t0: 0.1, t1: 0.6, hex: '#2455a8', weight: 0.6 },
      { t0: 0.6, t1: 0.9, hex: '#b9bcc1', weight: 0.4 },
    ];
    const current = fitObject({
      profile: observeModel(generate('screwdriver', {}, 0)),
      colors: gapped,
      candidates: [{ classId: 'screwdriver', score: 0.9 }],
      dimensionSource: 'photo',
    });
    const stored: CustomTool = {
      ...docOf(current),
      colors: gapped,
      partColors: current.sampledPartColors,
      userPartColors: {},
    };
    const kept = applyPatch(stored, { name: { en: 'Renamed' } });
    expect(kept.tool.userPartColors).toEqual({});
    expect(kept.tool.partColors).toEqual(current.sampledPartColors);
  });

  test('manual tools can change class and dimensions, and unknown classes are input errors', () => {
    const manual = createManualTool({ id: 'm', classId: 'screwdriver' });
    const doc = {
      ...manual.tool,
      model: docOf(
        fitObject({
          profile: manual.tool.profile as never,
          colors: [],
          candidates: [],
          dimensionSource: 'user',
        }),
      ).model,
    } as CustomTool;
    const longer = applyPatch(doc, { dimensionsMm: { length: 260 } });
    expect(longer.tool.dimensionsMm.length).toBeGreaterThan(240);
    expect(() => applyPatch(doc, { classId: 'nope' })).toThrow(ToolInputError);
    const params = applyPatch(doc, { params: { shaftLength: 200 } });
    expect(params.tool.dimensionsMm.length).toBeGreaterThan(manual.tool.dimensionsMm.length);
  });

  test('a typed length is remembered as typed and survives later edits; parameter edits are not undone', () => {
    const manual = createManualTool({ id: 'm', classId: 'screwdriver' });
    const doc = {
      ...manual.tool,
      model: docOf(
        fitObject({
          profile: manual.tool.profile as never,
          colors: [],
          candidates: [],
          dimensionSource: 'user',
        }),
      ).model,
    } as CustomTool;
    const typed = applyPatch(doc, { dimensionsMm: { length: 210 } });
    expect(typed.tool.userDimensionsMm).toEqual({ length: 210 });
    const again = applyPatch({ ...doc, ...typed.tool }, { dimensionsMm: { thickness: 30 } });
    expect(again.tool.userDimensionsMm).toEqual({ length: 210, thickness: 30 });
    expect(Math.abs(again.tool.dimensionsMm.length - typed.tool.dimensionsMm.length)).toBeLessThan(
      6,
    );

    const edited = applyPatch(doc, { params: { shaftLength: 200 } });
    const thicker = applyPatch({ ...doc, ...edited.tool }, { dimensionsMm: { thickness: 30 } });
    expect(thicker.tool.dimensionsMm.length).toBeGreaterThan(edited.tool.dimensionsMm.length - 12);
  });
});

describe('tags', () => {
  test('are trimmed, lower-cased, deduplicated and bounded', () => {
    expect(normalizeTags([' Hand tool', 'hand tool', '', 'ЭЛЕКТРО'])).toEqual([
      'hand tool',
      'электро',
    ]);
    expect(unionTags(['a', 'B'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
    const patch = (tags: string[]) => CustomToolPatchSchema.safeParse({ tags });
    expect(patch(['x'.repeat(40)]).success).toBe(true);
    expect(patch(['x'.repeat(41)]).success).toBe(false);
    expect(patch(Array.from({ length: 20 }, (_, i) => `t${i}`)).success).toBe(true);
    expect(patch(Array.from({ length: 21 }, (_, i) => `t${i}`)).success).toBe(false);
  });

  test('a tool.json written before tags existed reads as untagged', () => {
    const manual = createManualTool({ id: 'old', classId: 'screwdriver' });
    const stored = { ...manual.tool } as Record<string, unknown>;
    delete stored['tags'];
    const full = {
      ...stored,
      model: {
        glb: 'model.glb',
        glbLod1: 'model-lod1.glb',
        thumb: 'thumb.webp',
        triangles: 1,
        bboxMm: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    };
    const parsed = CustomToolSchema.parse(full);
    expect(parsed.tags).toEqual([]);
  });
});

describe('listing', () => {
  test('a tool whose class no longer exists stays listed without holding data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hsw-tools-'));
    try {
      const store = new ToolStore(root);
      const manual = createManualTool({ id: 'gone', classId: 'screwdriver', tags: ['x'] });
      await store.save(manual.tool, manual);
      const file = join(root, 'gone', 'tool.json');
      const doc = JSON.parse(await Bun.file(file).text()) as { classId: string };
      doc.classId = 'removed-class';
      await Bun.write(file, JSON.stringify(doc));
      const listed = await store.list();
      expect(listed.map((t) => t.id)).toEqual(['gone']);
      expect(listed[0]).toMatchObject({ holdingDims: {}, bankClass: null, tags: ['x'] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
