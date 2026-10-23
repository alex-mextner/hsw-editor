import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeModel } from '../custom/create.ts';
import { generate, presetValues } from '../registry.ts';
import '../classes/index.ts';
import {
  type DraftDeps,
  DraftStore,
  analyzeDraft,
  commitDraft,
  groupDraftObjects,
  patchDraftObject,
  recalibrateDraft,
  sniffPhotoExtension,
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
    }
    return { status: 'ok', calibration: { method: 'manual', mm_per_px: 1.2 }, objects };
  }
  async mergeObjects(): Promise<SidecarObject> {
    throw new Error('unused');
  }
  async splitObject(): Promise<SidecarObject[]> {
    throw new Error('unused');
  }
}

let root = '';
let deps: DraftDeps;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hsw-drafts-'));
  deps = {
    drafts: new DraftStore(join(root, 'tools', '.drafts')),
    tools: new ToolStore(join(root, 'tools')),
    vision: new FakeVision(),
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
