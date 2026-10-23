import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeModel } from '../custom/create.ts';
import { typicalLengthMm } from '../custom/create.ts';
import { buildPrototypeIndex } from '../recognize/fuse.ts';
import { generate, presetValues } from '../registry.ts';
import '../classes/index.ts';
import {
  type DraftDeps,
  DraftStore,
  addDraftObject,
  analyzeDraft,
  commitDraft,
  groupDraftObjects,
  mergeDraftObjects,
  patchDraftObject,
  recalibrateDraft,
  sniffPhotoExtension,
  splitDraftObject,
} from './drafts.ts';
import { ToolStore } from './store.ts';
import type {
  PhotoObjectsRequest,
  SidecarObject,
  SidecarResult,
  VisionPort,
} from './vision-port.ts';

const PNG_1PX = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

function sidecarObject(id: number, preset: string, withScale = true): SidecarObject {
  const truth = generate('screwdriver', presetValues('screwdriver', preset), 0);
  const obs = observeModel(truth);
  return {
    id,
    areaPx: 1000 + id,
    cropOriented: `crops_oriented/${id}.png`,
    cutoutOriented: `cutouts_oriented/${id}.png`,
    mask: `masks/${id}.png`,
    profile: withScale
      ? {
          kind: 'lathe_profile',
          length_mm: obs.lengthMm,
          stations: obs.stations.map((s) => ({ t: s.t, lo_mm: s.lo, hi_mm: s.hi })),
        }
      : null,
    class: {
      toolClass: 'screwdriver',
      topk: [
        { toolClass: 'screwdriver', score: 20 },
        { toolClass: 'hammer', score: 14 },
      ],
    },
    colours: {
      parts: [
        { t0: 0, t1: 0.5, hex: '#d9b21c', area_frac: 0.5, role_guess: 'handle' },
        { t0: 0.5, t1: 1, hex: '#b9bcc1', area_frac: 0.5, role_guess: 'metal' },
      ],
    },
    mmPerPx: withScale ? 1.2 : null,
  };
}

class FakeVision implements VisionPort {
  calls = 0;
  /** Ids returned as a profile in PIXELS (a photo without a scale), 0.8 px per mm. */
  pixelIds = new Set<number>();
  /** Ids returned without any class suggestion. */
  unclassifiedIds = new Set<number>();
  async photoToObjects(req: PhotoObjectsRequest): Promise<SidecarResult> {
    this.calls++;
    for (const d of ['crops_oriented', 'cutouts_oriented', 'masks'])
      await mkdir(join(req.outDir, d), { recursive: true });
    const objects = [
      sidecarObject(1, 'torx-cushion'),
      sidecarObject(2, 'precision-slotted'),
      sidecarObject(3, 'hex-octagonal', false),
    ];
    for (const o of objects) {
      for (const rel of [o.cropOriented, o.cutoutOriented, o.mask])
        if (rel) await writeFile(join(req.outDir, rel), PNG_1PX);
      if (this.pixelIds.has(o.id) && o.profile) {
        const px = {
          ...o.profile,
          length_mm: o.profile.length_mm * 0.8,
          stations: o.profile.stations.map((st) => ({
            ...st,
            lo_mm: st.lo_mm * 0.8,
            hi_mm: st.hi_mm * 0.8,
          })),
        };
        delete o.profile;
        o.profilePx = px;
        o.mmPerPx = null;
      }
      if (this.unclassifiedIds.has(o.id)) o.class = { toolClass: null, topk: [] };
    }
    return { status: 'ok', calibration: { method: 'manual', mm_per_px: 1.2 }, objects };
  }
  /** Edit ops: each answers with new objects (ids 10+) and writes their files like the sidecar does. */
  edits: string[] = [];
  private nextId = 10;
  private async fresh(outDir: string, preset: string): Promise<SidecarObject> {
    const o = sidecarObject(this.nextId++, preset);
    for (const rel of [o.cropOriented, o.cutoutOriented, o.mask])
      if (rel) await writeFile(join(outDir, rel), PNG_1PX);
    return o;
  }
  async mergeObjects(outDir: string, ids: readonly number[]): Promise<SidecarObject> {
    this.edits.push(`merge ${ids.join(',')}`);
    return this.fresh(outDir, 'torx-cushion');
  }
  async splitObject(
    outDir: string,
    id: number,
    how: { linePx: [[number, number], [number, number]] } | { n: number },
  ): Promise<SidecarObject[]> {
    this.edits.push(`split ${id} ${'n' in how ? how.n : 'line'}`);
    const n = 'n' in how ? how.n : 2;
    return Promise.all(
      Array.from({ length: n }, (_, i) =>
        this.fresh(outDir, i % 2 ? 'precision-slotted' : 'torx-cushion'),
      ),
    );
  }
  async addObject(outDir: string): Promise<SidecarObject> {
    this.edits.push('add');
    return this.fresh(outDir, 'hex-octagonal');
  }
  async status(): Promise<{ available: boolean }> {
    return { available: true };
  }
}

let root = '';
let deps: DraftDeps;
const vision = new FakeVision();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hsw-drafts-'));
  deps = {
    drafts: new DraftStore(join(root, 'tools', '.drafts')),
    tools: new ToolStore(join(root, 'tools')),
    vision,
    index: null,
    categoriesPath: join(root, 'classes.json'),
  };
  await mkdir(deps.drafts.root, { recursive: true });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('photo sniffing', () => {
  test('recognises the supported formats and rejects others', () => {
    expect(sniffPhotoExtension(PNG_1PX)).toBe('.png');
    expect(
      sniffPhotoExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBe('.jpg');
    expect(sniffPhotoExtension(new TextEncoder().encode('%PDF-1.4 not a photo'))).toBeNull();
  });
});

describe('import draft', () => {
  test('analyse, review and commit several objects of one photo', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: { mmPerPx: 1.2 },
      photos: [{ name: 'tools.png', bytes: PNG_1PX }],
    });
    const analysed = await analyzeDraft(deps, draft.id);
    expect(analysed.state).toBe('ready');
    expect(analysed.objects.map((o) => o.key)).toEqual(['0:1', '0:2', '0:3']);
    const [first, , noScale] = analysed.objects;
    expect(first?.classId).toBe('screwdriver');
    expect(first?.fit?.method).toBe('class-profile');
    expect(first?.preview).not.toBeNull();
    expect(noScale?.needsScale).toBe(true);
    expect(noScale?.fit).toBeNull();

    // user: accept the first, rename, set a real length; discard the second; accept the one without scale
    await patchDraftObject(deps, draft.id, '0:1', {
      status: 'accepted',
      name: { en: 'Yellow Torx', ru: 'Жёлтая Torx' },
      dimensionsMm: { length: 220 },
    });
    await patchDraftObject(deps, draft.id, '0:2', { status: 'discarded' });
    await patchDraftObject(deps, draft.id, '0:3', { status: 'accepted' });
    const reviewed = await deps.drafts.get(draft.id);
    expect(reviewed.objects[0]?.dimensionsMm?.length).toBeGreaterThan(200);

    const committed = await commitDraft(deps, draft.id);
    expect(committed.tools.length).toBe(1);
    expect(committed.skipped.map((s) => s.key)).toEqual(['0:3']);
    const tool = await deps.tools.get(committed.tools[0]?.id ?? '');
    expect(tool.name).toEqual({ en: 'Yellow Torx', ru: 'Жёлтая Torx' });
    expect(tool.dimensionsMm.source).toBe('user');
    expect(tool.classId).toBe('screwdriver');
    const files = await readdir(join(deps.tools.root, tool.id));
    expect(files).toContain('model.glb');
    expect((await stat(join(deps.tools.root, tool.id, 'thumb.webp'))).size).toBeGreaterThan(100);
    const sources = await readdir(join(deps.tools.root, tool.id, 'source'));
    expect(sources.some((f) => f.startsWith('photo-'))).toBe(true);
    expect(sources.some((f) => f.startsWith('crop-'))).toBe(true);
    expect(
      JSON.parse(await readFile(join(deps.tools.root, tool.id, 'tool.json'), 'utf8')).version,
    ).toBe(1);
    // committing again adds nothing
    expect((await commitDraft(deps, draft.id, ['0:1'])).tools).toEqual([]);
  });

  test('merge replaces the parts by one fitted object, split by one per part, add appends one', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: { mmPerPx: 1.2 },
      photos: [{ name: 'tools.png', bytes: PNG_1PX }],
    });
    await analyzeDraft(deps, draft.id);
    await patchDraftObject(deps, draft.id, '0:1', { tags: ['hammer-parts'] });

    const merged = await mergeDraftObjects(deps, draft.id, ['0:1', '0:2']);
    expect(vision.edits.at(-1)).toBe('merge 1,2');
    const byKey = (d: typeof merged, key: string) => d.objects.find((o) => o.key === key);
    expect(byKey(merged, '0:1')?.status).toBe('discarded');
    expect(byKey(merged, '0:2')?.status).toBe('discarded');
    const union = merged.objects.at(-1);
    expect(union?.status).toBe('pending');
    expect(union?.fit).not.toBeNull();
    expect(union?.tags).toEqual(['hammer-parts']); // the parts' tags carry over
    expect(union?.preview).not.toBeNull();

    const split = await splitDraftObject(deps, draft.id, union?.key ?? '', { n: 3 });
    expect(vision.edits.at(-1)).toBe(`split ${union?.objectId} 3`);
    expect(byKey(split, union?.key ?? '')?.status).toBe('discarded');
    const parts = split.objects.slice(-3);
    expect(new Set(parts.map((p) => p.key)).size).toBe(3);
    expect(parts.every((p) => p.status === 'pending' && p.fit !== null)).toBe(true);

    const added = await addDraftObject(deps, draft.id, 0, { pointPx: [120, 80] });
    expect(vision.edits.at(-1)).toBe('add');
    expect(added.objects.length).toBe(split.objects.length + 1);
    expect(added.objects.at(-1)?.status).toBe('pending');
    await expect(addDraftObject(deps, draft.id, 7, { pointPx: [1, 1] })).rejects.toThrow(
      'no photo 7',
    );
    // edits never touch an object that is already in the library
    const kept = parts[2]?.key ?? '';
    await patchDraftObject(deps, draft.id, kept, { status: 'accepted' });
    expect((await commitDraft(deps, draft.id, [kept])).tools.length).toBe(1);
    await expect(mergeDraftObjects(deps, draft.id, [kept, parts[0]?.key ?? ''])).rejects.toThrow(
      'already in the library',
    );
  });

  test('a photo without a scale estimates sizes from the class and flags them; a typed length corrects one', async () => {
    vision.pixelIds = new Set([1, 2, 3]);
    vision.unclassifiedIds = new Set([3]);
    try {
      const draft = await deps.drafts.create({
        mode: 'multi',
        calibration: null,
        photos: [{ name: 'oblique.png', bytes: PNG_1PX }],
      });
      const analysed = await analyzeDraft(deps, draft.id);
      const [first, second, unknown] = analysed.objects;
      expect(first?.dimensionsEstimated).toBe(true);
      expect(first?.needsScale).toBe(false);
      expect(first?.fit).not.toBeNull();
      expect(first?.observation?.profileInPixels).toBe(true);
      const typical = typicalLengthMm(first?.classId ?? '');
      expect(first?.dimensionsMm?.length).toBeGreaterThan(typical * 0.9);
      expect(first?.dimensionsMm?.length).toBeLessThan(typical * 1.1);
      // an object nothing is known about has no honest size
      expect(unknown?.needsScale).toBe(true);
      expect(unknown?.dimensionsEstimated).toBe(false);
      expect(unknown?.fit).toBeNull();

      // the user types one real length: it replaces the estimate
      const typed = await patchDraftObject(deps, draft.id, '0:1', {
        status: 'accepted',
        dimensionsMm: { length: 300 },
      });
      const corrected = typed.objects.find((o) => o.key === '0:1');
      expect(corrected?.dimensionsEstimated).toBe(false);
      expect(corrected?.dimensionsMm?.length).toBeGreaterThan(285);
      expect(corrected?.dimensionsMm?.length).toBeLessThan(315);

      // choosing another class re-estimates from that class
      const reclassed = await patchDraftObject(deps, draft.id, '0:2', {
        status: 'accepted',
        classId: 'hammer',
      });
      const hammer = reclassed.objects.find((o) => o.key === '0:2');
      expect(hammer?.dimensionsEstimated).toBe(true);
      expect(hammer?.dimensionsMm?.length).toBeGreaterThan(typicalLengthMm('hammer') * 0.9);
      expect(second?.dimensionsMm?.length).not.toBeCloseTo(hammer?.dimensionsMm?.length ?? 0, 0);

      // estimated and typed sizes reach the collection with their source
      const committed = await commitDraft(deps, draft.id);
      expect(committed.tools.length).toBe(2);
      const sources = await Promise.all(
        committed.tools.map(async (tool) => (await deps.tools.get(tool.id)).dimensionsMm.source),
      );
      expect(sources.sort()).toEqual(['estimated', 'user']);
    } finally {
      vision.pixelIds = new Set();
      vision.unclassifiedIds = new Set();
    }
  });

  test('typed sizes are kept exactly through the refit; ones the class cannot hold are reported with the reason (issue 214)', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: { mmPerPx: 1.2 },
      photos: [{ name: 'tools.png', bytes: PNG_1PX }],
    });
    await analyzeDraft(deps, draft.id);
    const typed = await patchDraftObject(deps, draft.id, '0:1', {
      dimensionsMm: { length: 100, width: 20 },
    });
    const kept = typed.objects.find((o) => o.key === '0:1');
    expect(kept?.dimensionsMm?.length).toBeCloseTo(100, 1);
    expect(kept?.dimensionsMm?.width).toBeCloseTo(20, 1);
    expect(kept?.dimensionAdjustments).toEqual([]);

    // a later edit of one size does not move the others
    const widened = await patchDraftObject(deps, draft.id, '0:1', { dimensionsMm: { width: 25 } });
    const second = widened.objects.find((o) => o.key === '0:1');
    expect(second?.dimensionsMm?.length).toBeCloseTo(100, 1);
    expect(second?.dimensionsMm?.width).toBeCloseTo(25, 1);

    const tooWide = await patchDraftObject(deps, draft.id, '0:1', { dimensionsMm: { width: 80 } });
    const snapped = tooWide.objects.find((o) => o.key === '0:1');
    expect(snapped?.userDimensions?.width).toBe(80);
    expect(snapped?.dimensionsMm?.width).toBeLessThan(80);
    expect(snapped?.dimensionAdjustments).toEqual([
      {
        key: 'width',
        requestedMm: 80,
        actualMm: snapped?.dimensionsMm?.width ?? 0,
        reason: 'class-range',
      },
    ]);
    expect(snapped?.dimensionsMm?.length).toBeCloseTo(100, 1);
  });

  test('absurd sizes are refused before anything is stored', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: { mmPerPx: 1.2 },
      photos: [{ name: 'tools.png', bytes: PNG_1PX }],
    });
    await analyzeDraft(deps, draft.id);
    for (const dimensionsMm of [
      { length: 12086 },
      { width: 0.4 },
      { thickness: 0.05 },
      { thickness: 3001 },
      { length: 0 },
    ]) {
      await expect(patchDraftObject(deps, draft.id, '0:1', { dimensionsMm })).rejects.toThrow(
        /must be between [\d.]+ and 3000 mm/,
      );
    }
    expect((await deps.drafts.get(draft.id)).objects[0]?.userDimensions).toBeUndefined();
    // a real thin tool (steel rule, 0.4 mm) is a sane thickness
    const thin = await patchDraftObject(deps, draft.id, '0:1', { dimensionsMm: { thickness: 0.4 } });
    expect(thin.objects[0]?.userDimensions).toEqual({ thickness: 0.4 });
  });

  test('a recorded real photo shot at an angle, with no scale reference, gives fitted tools with flagged estimated sizes', async () => {
    // fixtures/oblique-carpet.json: the real sidecar's answer (no scale) for a perspective-warped carpet photo
    const recorded = JSON.parse(
      await readFile(join(import.meta.dir, 'fixtures/oblique-carpet.json'), 'utf8'),
    ) as {
      objects: {
        id: number;
        areaPx: number;
        class: { toolClass: string; prob: number; topk: { toolClass: string; score: number }[] };
        profilePx: SidecarObject['profilePx'];
      }[];
    };
    const replay: VisionPort = {
      status: async () => ({ available: true }),
      photoToObjects: async (req: PhotoObjectsRequest): Promise<SidecarResult> => {
        for (const d of ['crops_oriented', 'cutouts_oriented', 'masks'])
          await mkdir(join(req.outDir, d), { recursive: true });
        const objects: SidecarObject[] = [];
        for (const r of recorded.objects) {
          const o: SidecarObject = {
            id: r.id,
            areaPx: r.areaPx,
            cropOriented: `crops_oriented/${r.id}.png`,
            cutoutOriented: `cutouts_oriented/${r.id}.png`,
            mask: `masks/${r.id}.png`,
            profile: null,
            profilePx: r.profilePx,
            class: r.class,
          };
          for (const rel of [o.cropOriented, o.cutoutOriented, o.mask])
            if (rel) await writeFile(join(req.outDir, rel), PNG_1PX);
          objects.push(o);
        }
        return { status: 'no_scale', calibration: { ok: false }, objects };
      },
      mergeObjects: async () => {
        throw new Error('unused');
      },
      splitObject: async () => {
        throw new Error('unused');
      },
      addObject: async () => {
        throw new Error('unused');
      },
    };
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: null,
      photos: [{ name: 'oblique.jpg', bytes: PNG_1PX }],
    });
    const analysed = await analyzeDraft({ ...deps, vision: replay }, draft.id);
    expect(analysed.objects.length).toBe(recorded.objects.length);
    for (const o of analysed.objects) {
      expect(o.needsScale).toBe(false);
      expect(o.fit).not.toBeNull();
      expect(o.dimensionsEstimated).toBe(true);
      const length = o.dimensionsMm?.length ?? 0;
      const typical = typicalLengthMm(o.classId ?? '');
      expect(length).toBeGreaterThan(typical * 0.85);
      expect(length).toBeLessThan(typical * 1.15);
    }
    // one real size typed for one tool replaces its estimate and leaves the others flagged
    const hammer = analysed.objects.find((o) => o.classId === 'hammer');
    const typed = await patchDraftObject({ ...deps, vision: replay }, draft.id, hammer?.key ?? '', {
      dimensionsMm: { length: 260 },
    });
    const flags = typed.objects.map((o) => [o.classId, o.dimensionsEstimated]);
    expect(flags.filter(([, estimated]) => estimated).length).toBe(recorded.objects.length - 1);
    expect(typed.objects.find((o) => o.key === hammer?.key)?.dimensionsEstimated).toBe(false);
  });

  test('an estimated object never outranks a measured one when photos are grouped, and an unsizeable one is reported when committing', async () => {
    vision.pixelIds = new Set([2]);
    vision.unclassifiedIds = new Set([3]);
    try {
      const draft = await deps.drafts.create({
        mode: 'multi',
        calibration: { mmPerPx: 1.2 },
        photos: [{ name: 'a.png', bytes: PNG_1PX }],
      });
      const analysed = await analyzeDraft(deps, draft.id);
      const measured = analysed.objects.find((o) => o.key === '0:1');
      const estimated = analysed.objects.find((o) => o.key === '0:2');
      expect(measured?.dimensionsEstimated).toBe(false);
      expect(estimated?.dimensionsEstimated).toBe(true);
      // the estimated one has the better suggestion score (stored, as the grouping reads the draft from disk), yet the measured one stays primary
      await deps.drafts.update(draft.id, async (d) => {
        const o = d.objects.find((x) => x.key === '0:2');
        if (o) o.suggestions = [{ classId: 'screwdriver', score: 0.99 }];
        const m = d.objects.find((x) => x.key === '0:1');
        if (m) m.suggestions = [{ classId: 'screwdriver', score: 0.2 }];
      });
      const grouped = await groupDraftObjects(deps, draft.id, ['0:1', '0:2']);
      expect(grouped.objects.find((o) => o.key === '0:1')?.status).not.toBe('discarded');
      expect(grouped.objects.find((o) => o.key === '0:2')?.status).toBe('discarded');
      // an accepted object nothing is known about is skipped with a reason, not dropped silently
      await patchDraftObject(deps, draft.id, '0:3', { status: 'accepted' });
      const committed = await commitDraft(deps, draft.id, ['0:3']);
      expect(committed.tools).toEqual([]);
      expect(committed.skipped.map((s) => s.key)).toEqual(['0:3']);
    } finally {
      vision.pixelIds = new Set();
      vision.unclassifiedIds = new Set();
    }
  });

  test('class suggestions fuse the DINOv2 embedding of the object; a broken or missing DINOv2 row leaves the CLIP suggestions', async () => {
    /** A 2-D little-endian float32 .npy (version 1.0). */
    const npy = (rows: number[][]): Uint8Array => {
      const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows.length}, ${rows[0]?.length ?? 0}), }`;
      const pad = 64 - ((10 + header.length + 1) % 64);
      const text = new TextEncoder().encode(`${header}${' '.repeat(pad)}\n`);
      const out = new Uint8Array(10 + text.length + rows.flat().length * 4);
      out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, text.length & 255, text.length >> 8]);
      out.set(text, 10);
      new Float32Array(out.buffer, 10 + text.length, rows.flat().length).set(rows.flat());
      return out;
    };
    const unit = (...v: number[]): number[] => v.map((x) => x / Math.hypot(...v));
    // CLIP space (dim 3) cannot tell screwdriver from hammer; DINOv2 space (dim 2) can
    const index = buildPrototypeIndex({
      dim: 3,
      classIds: ['screwdriver', 'hammer'],
      text: new Float32Array([...unit(1, 0, 0), ...unit(1, 0, 0)]),
      protos: new Float32Array([...unit(1, 0.05, 0), ...unit(1, 0, 0.05)]),
      protoClassIds: ['screwdriver', 'hammer'],
      dinoDim: 2,
      dinoProtos: new Float32Array([...unit(1, 0), ...unit(0, 1)]),
    });
    const withDino = (row: number, file = 'embeddings-dino.npy') => ({
      file: 'embeddings.npy',
      row: 0,
      dim: 3,
      dino: { file, row, dim: 2 },
    });
    const suggest = async (embedding: SidecarObject['embedding'], dinoRows: number[][] | null) => {
      const draft = await deps.drafts.create({
        mode: 'multi',
        calibration: { mmPerPx: 1.2 },
        photos: [{ name: 'dino.png', bytes: PNG_1PX }],
      });
      const port: VisionPort = {
        status: async () => ({ available: true }),
        mergeObjects: (outDir, ids) => vision.mergeObjects(outDir, ids),
        splitObject: (outDir, id, how) => vision.splitObject(outDir, id, how),
        addObject: (outDir) => vision.addObject(outDir),
        photoToObjects: async (req: PhotoObjectsRequest): Promise<SidecarResult> => {
          const result = await vision.photoToObjects(req);
          await writeFile(join(req.outDir, 'embeddings.npy'), npy([unit(1, 0.02, 0.02)]));
          if (dinoRows) await writeFile(join(req.outDir, 'embeddings-dino.npy'), npy(dinoRows));
          const [first] = result.objects;
          return { ...result, objects: first ? [{ ...first, class: null, embedding }] : [] };
        },
      };
      const analysed = await analyzeDraft({ ...deps, vision: port, index }, draft.id);
      return analysed.objects[0]?.suggestions.map((x) => x.classId) ?? [];
    };
    expect((await suggest(withDino(0), [unit(0, 1)]))[0]).toBe('hammer');
    expect((await suggest(withDino(0), [unit(1, 0)]))[0]).toBe('screwdriver');
    // CLIP-only suggestions (no DINOv2 evidence): the same class order as without the dino reference
    const clipOnly = await suggest({ file: 'embeddings.npy', row: 0, dim: 3 }, null);
    expect(clipOnly.length).toBe(2);
    for (const broken of [withDino(-1), withDino(5), withDino(0, 'missing.npy')]) {
      expect(await suggest(broken, [unit(0, 1)])).toEqual(clipOnly);
    }
  });

  test('class override refits with the chosen class and generic loft is possible', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: null,
      photos: [{ name: 'tools.png', bytes: PNG_1PX }],
    });
    await analyzeDraft(deps, draft.id);
    const generic = await patchDraftObject(deps, draft.id, '0:1', { classId: null });
    const g = generic.objects.find((o) => o.key === '0:1');
    expect(g?.fit?.method).toBe('generic-loft');
    expect(g?.classOverridden).toBe(true);
    await expect(patchDraftObject(deps, draft.id, '0:1', { classId: 'nope' })).rejects.toThrow(
      'unknown class',
    );
  });

  test('photos of the same tool are grouped under one primary observation', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: null,
      photos: [
        { name: 'a.png', bytes: PNG_1PX },
        { name: 'b.png', bytes: PNG_1PX },
      ],
    });
    await analyzeDraft(deps, draft.id);
    const grouped = await groupDraftObjects(deps, draft.id, ['0:1', '1:1']);
    const kept = grouped.objects.filter((o) => o.status !== 'discarded' && o.key.endsWith(':1'));
    expect(kept.length).toBe(1);
    expect(kept[0]?.alsoSeenIn.length).toBe(1);
  });

  test('tags: grouping unions and caps them, commit adds body tags and refuses more than 20', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: { mmPerPx: 1.2 },
      photos: [
        { name: 'a.png', bytes: PNG_1PX },
        { name: 'b.png', bytes: PNG_1PX },
      ],
    });
    await analyzeDraft(deps, draft.id);
    const tags = (from: number): string[] => Array.from({ length: 12 }, (_, i) => `t${from + i}`);
    await patchDraftObject(deps, draft.id, '0:1', { tags: tags(0) });
    await patchDraftObject(deps, draft.id, '1:1', { tags: tags(6) });
    const grouped = await groupDraftObjects(deps, draft.id, ['0:1', '1:1']);
    const primary = grouped.objects.find(
      (o) => o.status !== 'discarded' && o.alsoSeenIn.length > 0,
    );
    expect(primary?.tags.length).toBe(18);
    await patchDraftObject(deps, draft.id, primary?.key ?? '', { status: 'accepted' });
    const before = (await deps.tools.list()).length;
    await expect(
      commitDraft(deps, draft.id, undefined, new Date(), ['x', 'y', 'z']),
    ).rejects.toThrow('at most 20');
    expect((await deps.tools.list()).length).toBe(before);
    const ok = await commitDraft(deps, draft.id, undefined, new Date(), ['T0', 'extra']);
    expect(ok.tools[0]?.tags.length).toBe(19);
    expect(ok.tools[0]?.tags).toContain('extra');
  });

  test('two simultaneous commits add each tool once', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: null,
      photos: [{ name: 'a.png', bytes: PNG_1PX }],
    });
    await analyzeDraft(deps, draft.id);
    await patchDraftObject(deps, draft.id, '0:1', { status: 'accepted' });
    const [a, b] = await Promise.all([commitDraft(deps, draft.id), commitDraft(deps, draft.id)]);
    expect(a.tools.length + b.tools.length).toBe(1);
    const ids = (await deps.tools.list()).filter((t) => t.createdAt >= draft.createdAt);
    expect(ids.length).toBe(1);
  });

  test('a commit whose source photo cannot be copied leaves no tool, and the retry adds it once', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: null,
      photos: [{ name: 'gone.png', bytes: PNG_1PX }],
    });
    const analysed = await analyzeDraft(deps, draft.id);
    await patchDraftObject(deps, draft.id, '0:1', { status: 'accepted' });
    const photo = analysed.photos[0];
    if (!photo) throw new Error('no photo');
    const photoPath = join(deps.drafts.dir(draft.id), photo.file);
    const aside = `${photoPath}.aside`;
    const before = (await deps.tools.list()).length;
    await rename(photoPath, aside);
    await expect(commitDraft(deps, draft.id)).rejects.toThrow();
    // nothing half-written in the library, and the object is still open
    expect((await deps.tools.list()).length).toBe(before);
    expect((await deps.drafts.get(draft.id)).objects.find((o) => o.key === '0:1')?.status).toBe(
      'accepted',
    );
    expect((await readdir(deps.tools.root)).filter((n) => !n.startsWith('.')).length).toBe(before);
    await rename(aside, photoPath);
    const retried = await commitDraft(deps, draft.id);
    expect(retried.tools.length).toBe(1);
    expect((await deps.tools.list()).length).toBe(before + 1);
    expect((await commitDraft(deps, draft.id)).tools).toEqual([]);
    expect((await deps.tools.list()).length).toBe(before + 1);
  });

  test('a draft that cannot be saved after the tool was written takes the tool back out', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: null,
      photos: [{ name: 'a.png', bytes: PNG_1PX }],
    });
    await analyzeDraft(deps, draft.id);
    await patchDraftObject(deps, draft.id, '0:1', { status: 'accepted' });
    const before = (await deps.tools.list()).length;
    const realSave = deps.drafts.save.bind(deps.drafts);
    deps.drafts.save = async () => {
      throw new Error('disk full');
    };
    try {
      await expect(commitDraft(deps, draft.id)).rejects.toThrow('disk full');
    } finally {
      deps.drafts.save = realSave;
    }
    expect((await deps.tools.list()).length).toBe(before);
    expect((await commitDraft(deps, draft.id)).tools.length).toBe(1);
    expect((await deps.tools.list()).length).toBe(before + 1);
  });

  test('a busy draft refuses a second analysis and edits; an invalid draft is never written', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: null,
      photos: [{ name: 'a.png', bytes: PNG_1PX }],
    });
    draft.state = 'analyzing';
    await deps.drafts.save(draft);
    await expect(analyzeDraft(deps, draft.id)).rejects.toThrow('already being analysed');
    await expect(patchDraftObject(deps, draft.id, '0:1', { status: 'accepted' })).rejects.toThrow(
      'while the draft is being analysed',
    );
    const broken = { ...draft, photos: 'nope' } as never;
    await expect(deps.drafts.save(broken)).rejects.toThrow();
    expect((await deps.drafts.get(draft.id)).state).toBe('analyzing');
  });

  test('recalibrating re-runs the analysis with the new scale and keeps tools already added', async () => {
    const draft = await deps.drafts.create({
      mode: 'multi',
      calibration: null,
      photos: [{ name: 'a.png', bytes: PNG_1PX }],
    });
    await analyzeDraft(deps, draft.id);
    const recal = await recalibrateDraft(deps, draft.id, { mmPerPx: 0.9 });
    expect(recal.state).toBe('created');
    expect(recal.calibration).toEqual({ mmPerPx: 0.9 });
    expect((await analyzeDraft(deps, draft.id)).state).toBe('ready');
  });
});

describe('draft lifecycle guards', () => {
  const photo = { name: 'p.png', bytes: PNG_1PX };

  test('a sidecar that returns more class scores than the draft can hold still finishes', async () => {
    class ChattyVision extends FakeVision {
      override async photoToObjects(req: PhotoObjectsRequest): Promise<SidecarResult> {
        const base = await super.photoToObjects(req);
        const objects = base.objects.map((o) => ({
          ...o,
          class: {
            toolClass: 'screwdriver',
            topk: Array.from({ length: 30 }, (_, i) => ({
              toolClass: i === 0 ? 'screwdriver' : `class-${i}`,
              score: 30 - i,
            })),
          },
        }));
        return { ...base, objects };
      }
    }
    const chatty: DraftDeps = { ...deps, vision: new ChattyVision() };
    const draft = await deps.drafts.create({ mode: 'multi', calibration: null, photos: [photo] });
    const analysed = await analyzeDraft(chatty, draft.id);
    expect(analysed.state).toBe('ready');
    expect(analysed.objects.every((o) => o.suggestions.length <= 10)).toBe(true);
  });

  test('committing keys that are not in the draft says so instead of returning nothing', async () => {
    const draft = await deps.drafts.create({ mode: 'multi', calibration: null, photos: [photo] });
    await analyzeDraft(deps, draft.id);
    const result = await commitDraft(deps, draft.id, ['9:99']);
    expect(result.tools).toEqual([]);
    expect(result.skipped).toEqual([{ key: '9:99', reason: 'no such object in this draft' }]);
  });

  test('a draft being analysed cannot be deleted, and a finished one can', async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    class SlowVision extends FakeVision {
      override async photoToObjects(req: PhotoObjectsRequest): Promise<SidecarResult> {
        entered.resolve();
        await gate.promise;
        return super.photoToObjects(req);
      }
    }
    const slow: DraftDeps = { ...deps, vision: new SlowVision() };
    const draft = await deps.drafts.create({ mode: 'multi', calibration: null, photos: [photo] });
    const running = analyzeDraft(slow, draft.id);
    await entered.promise;
    await expect(deps.drafts.remove(draft.id)).rejects.toMatchObject({ code: 'conflict' });
    gate.resolve();
    await running;
    await deps.drafts.remove(draft.id);
    await expect(deps.drafts.get(draft.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await readdir(deps.drafts.root)).includes(draft.id)).toBe(false);
  });

  test('a corrupt draft.json is a corrupt error, not a schema exception', async () => {
    const draft = await deps.drafts.create({ mode: 'multi', calibration: null, photos: [photo] });
    await writeFile(join(deps.drafts.dir(draft.id), 'draft.json'), '{ "cut off');
    await expect(deps.drafts.get(draft.id)).rejects.toMatchObject({ code: 'corrupt' });
    await deps.drafts.remove(draft.id);
    expect((await readdir(deps.drafts.root)).includes(draft.id)).toBe(false);
  });

  test('an unusable sidecar profile is reported as such, not as a missing scale', async () => {
    class BrokenProfile extends FakeVision {
      override async photoToObjects(req: PhotoObjectsRequest): Promise<SidecarResult> {
        const base = await super.photoToObjects(req);
        const [first] = base.objects;
        if (first?.profile) first.profile = { ...first.profile, length_mm: 0 };
        return { ...base, objects: first ? [first] : [] };
      }
    }
    const broken: DraftDeps = { ...deps, vision: new BrokenProfile() };
    const draft = await deps.drafts.create({ mode: 'multi', calibration: null, photos: [photo] });
    const analysed = await analyzeDraft(broken, draft.id);
    const [obj] = analysed.objects;
    expect(obj?.needsScale).toBe(false);
    expect(obj?.error).toContain('not usable');
    await patchDraftObject(broken, draft.id, obj?.key ?? '', { status: 'accepted' });
    const result = await commitDraft(broken, draft.id);
    expect(result.tools.length).toBe(0);
    expect(result.skipped[0]?.reason).toContain('not usable');
  });
});
