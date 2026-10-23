/**
 * Import drafts on disk and the analyse / review / commit pipeline.
 *
 *   <root>/<draft id>/draft.json
 *                     photos/<n>.<ext>            uploaded originals
 *                     vision/<n>/                 sidecar result directory of photo n (objects.json, masks, crops, ...)
 *                     preview/<key>.glb|.webp     fitted preview of every object
 *
 * analyze:  photo -> sidecar `photo_to_objects` -> per object: class suggestions (prototype fusion), fit, preview
 * review:   patch (rename, discard, class override, real dimensions), group (same tool in several photos),
 *           merge / split (sidecar edit ops)
 * commit:   accepted objects -> `ToolStore` (tool.json + GLBs + thumbnail + source crops)
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, link, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  type CalibrationInput,
  type Draft,
  type DraftObject,
  type DraftObjectPatch,
  DraftIdSchema,
  DraftSchema,
} from '../custom/draft.ts';
import { type FittedObject, fitObject, typicalLengthMm } from '../custom/create.ts';
import { type ColorSegment, type CustomTool, ObservedProfileSchema } from '../custom/schema.ts';
import { MAX_TAGS, unionTags } from '../custom/tags.ts';
import { exportGlb } from '../glb.ts';
import { getToolClass, hasToolClass } from '../registry.ts';
import { type PrototypeIndex, suggestClasses } from '../recognize/fuse.ts';
import { KeyedQueue, writeAtomic } from './fsutil.ts';
import { type NpyMatrix, readNpyFloat32 } from './prototypes.ts';
import { ToolStore, type ToolSummary, summarize } from './store.ts';
import { renderThumbWebp } from './thumb.ts';
import type { SidecarObject, VisionPort } from './vision-port.ts';

export class DraftError extends Error {
  readonly code: 'not_found' | 'invalid' | 'conflict' | 'unsupported_media' | 'corrupt';
  constructor(code: DraftError['code'], message: string) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
  }
}

/** JPEG / PNG / WebP / HEIC by magic bytes; returns the file extension to store. */
export function sniffPhotoExtension(bytes: Uint8Array): string | null {
  if (bytes.length > 12) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return '.png';
    const tag = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4));
    if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return '.webp';
    if (
      tag(4) === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'heim', 'heis'].includes(tag(8))
    )
      return '.heic';
  }
  return null;
}

export interface DraftDeps {
  drafts: DraftStore;
  tools: ToolStore;
  vision: VisionPort;
  /** Null until `scripts/prototypes.ts` + `embed.py` built it: suggestions then use the sidecar's text scores. */
  index: PrototypeIndex | null;
  categoriesPath: string;
}

/** Fits are CPU heavy (hundreds of generator builds): the exact fit of an object is reused until its inputs change. */
const FIT_CACHE_SIZE = 64;

export class DraftStore {
  readonly root: string;
  /** One mutation at a time per draft: every read-modify-write of `draft.json` goes through `exclusive`. */
  private readonly queue = new KeyedQueue();
  private readonly fits = new Map<string, FittedObject>();

  constructor(root: string) {
    this.root = root;
  }

  exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.queue.run(id, work);
  }

  cachedFit(key: string): FittedObject | undefined {
    const hit = this.fits.get(key);
    if (hit) {
      this.fits.delete(key);
      this.fits.set(key, hit);
    }
    return hit;
  }

  rememberFit(key: string, fit: FittedObject): void {
    this.fits.set(key, fit);
    while (this.fits.size > FIT_CACHE_SIZE) {
      const oldest = this.fits.keys().next().value;
      if (oldest === undefined) break;
      this.fits.delete(oldest);
    }
  }

  dir(id: string): string {
    if (!DraftIdSchema.safeParse(id).success)
      throw new DraftError('invalid', `bad draft id: ${id}`);
    return join(this.root, id);
  }

  async create(input: {
    mode: Draft['mode'];
    calibration: CalibrationInput | null;
    photos: readonly { name: string; bytes: Uint8Array }[];
  }): Promise<Draft> {
    if (input.photos.length === 0)
      throw new DraftError('invalid', 'at least one photo is required');
    // every photo is checked before the first byte is written: a rejected upload leaves no directory behind
    const extensions = input.photos.map((p) => {
      const ext = sniffPhotoExtension(p.bytes);
      if (!ext)
        throw new DraftError('unsupported_media', `${p.name}: not a JPEG, PNG, WebP or HEIC photo`);
      return ext;
    });
    const id = `d-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const dir = this.dir(id);
    const photos: Draft['photos'] = [];
    try {
      await mkdir(join(dir, 'photos'), { recursive: true });
      for (const [index, p] of input.photos.entries()) {
        const ext = extensions[index] ?? '';
        const file = `photos/${index}${ext}`;
        await writeAtomic(join(dir, file), p.bytes);
        photos.push({
          index,
          file,
          name: basename(p.name).slice(0, 120) || `photo-${index}${ext}`,
          sha256: createHash('sha256').update(p.bytes).digest('hex'),
          mmPerPx: null,
          calibrationMethod: null,
        });
      }
      const now = new Date().toISOString();
      const draft: Draft = {
        version: 1,
        id,
        createdAt: now,
        updatedAt: now,
        state: 'created',
        mode: input.mode,
        photos,
        calibration: input.calibration,
        objects: [],
      };
      await this.save(draft);
      return draft;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async get(id: string): Promise<Draft> {
    const raw = await readFile(join(this.dir(id), 'draft.json'), 'utf8').catch(() => null);
    if (raw === null) throw new DraftError('not_found', `no draft ${id}`);
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new DraftError('corrupt', `draft ${id} has an unreadable draft.json`);
    }
    const parsed = DraftSchema.safeParse(doc);
    if (!parsed.success) throw new DraftError('corrupt', `draft ${id} has an invalid draft.json`);
    return parsed.data;
  }

  /** Validates before writing: a draft that `get` would refuse must never reach the disk. */
  async save(draft: Draft): Promise<void> {
    const parsed = DraftSchema.safeParse({ ...draft, updatedAt: new Date().toISOString() });
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new DraftError('corrupt', `draft ${draft.id} does not fit the draft schema: ${why}`);
    }
    draft.updatedAt = parsed.data.updatedAt;
    await writeAtomic(
      join(this.dir(draft.id), 'draft.json'),
      `${JSON.stringify(parsed.data, null, 1)}\n`,
    );
  }
  /** Read, change and save one draft under the per-draft lock. */
  update<T>(id: string, change: (draft: Draft) => Promise<T>): Promise<{ draft: Draft; value: T }> {
    return this.exclusive(id, async () => {
      const draft = await this.get(id);
      const value = await change(draft);
      await this.save(draft);
      return { draft, value };
    });
  }

  /** Serialised with every other mutation of the draft; a draft being analysed cannot be deleted (the run would recreate it). */
  remove(id: string): Promise<void> {
    return this.exclusive(id, async () => {
      // an unreadable draft.json must not make the draft undeletable
      const draft = await this.get(id).catch((error: unknown) => {
        if (error instanceof DraftError && error.code === 'corrupt') return null;
        throw error;
      });
      if (draft?.state === 'analyzing') {
        throw new DraftError('conflict', 'cannot delete a draft while it is being analysed');
      }
      await rm(this.dir(id), { recursive: true, force: true });
    });
  }

  /** Absolute path of a file inside a draft (traversal-safe: only known relative names). */
  async file(id: string, relative: string): Promise<string> {
    const draft = await this.get(id);
    const allowed = new Set<string>();
    for (const p of draft.photos) {
      allowed.add(p.file);
      if (p.overlay) allowed.add(p.overlay);
    }
    for (const o of draft.objects) {
      for (const v of [
        o.images.crop,
        o.images.cutout,
        o.images.mask,
        o.preview?.glb,
        o.preview?.thumb,
      ]) {
        if (v) allowed.add(v);
      }
    }
    if (!allowed.has(relative))
      throw new DraftError('not_found', `no file ${relative} in draft ${id}`);
    return join(this.dir(id), relative);
  }
}

// --- analysis -------------------------------------------------------------------------------------------------

/** `CustomToolSchema` accepts at most this many colour segments; the heaviest ones are kept. */
const MAX_COLOR_SEGMENTS = 24;

/** Observation from the sidecar profile; null when the sidecar profile is missing or not usable. */
function toObservation(o: SidecarObject): DraftObject['observation'] {
  // a photo without a scale still gives a silhouette profile (in pixels): it is scaled when the object is fitted
  const profile = o.profile ?? o.profilePx;
  if (!profile) return null;
  const parsed = ObservedProfileSchema.safeParse({
    lengthMm: profile.length_mm,
    stations: profile.stations.map((s) => ({
      t: Math.min(1, Math.max(0, s.t)),
      lo: s.lo_mm,
      hi: s.hi_mm,
    })),
  });
  if (!parsed.success) return null;
  const colors: ColorSegment[] = (o.colours?.parts ?? [])
    .map((p) => ({
      t0: Math.min(1, Math.max(0, p.t0)),
      t1: Math.min(1, Math.max(0, p.t1)),
      hex: /^#[0-9a-f]{6}$/i.test(p.hex) ? p.hex.toLowerCase() : '#6c7077',
      weight: Math.min(1, Math.max(0, p.area_frac ?? 0)),
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_COLOR_SEGMENTS)
    .sort((a, b) => a.t0 - b.t0);
  return {
    profile: parsed.data,
    colors,
    ...(profile.kind ? { profileKind: profile.kind } : {}),
    ...(o.profile ? {} : { profileInPixels: true as const }),
  };
}

/** `DraftObjectSchema` accepts at most this many class suggestions per object. */
const MAX_SUGGESTIONS = 10;

/** The object's DINOv2 embedding, when the sidecar wrote one and the index has DINOv2 prototypes of the same size. */
async function dinoRow(
  outDir: string,
  o: SidecarObject,
  index: PrototypeIndex,
  cache: Map<string, NpyMatrix>,
): Promise<Float32Array | undefined> {
  const ref = o.embedding?.dino;
  if (!ref || !index.dinoProtos) return undefined;
  try {
    const file = join(outDir, ref.file);
    let m = cache.get(file);
    if (!m) {
      m = await readNpyFloat32(file);
      cache.set(file, m);
    }
    const end = (ref.row + 1) * m.dim;
    if (ref.row < 0 || m.dim !== index.dinoDim || end > m.data.length) return undefined;
    return m.data.subarray(ref.row * m.dim, end);
  } catch {
    return undefined; // unreadable: CLIP evidence alone
  }
}

async function suggestionsFor(
  deps: DraftDeps,
  outDir: string,
  o: SidecarObject,
  cache: Map<string, NpyMatrix>,
): Promise<DraftObject['suggestions']> {
  if (deps.index && o.embedding) {
    const file = join(outDir, o.embedding.file);
    try {
      let m = cache.get(file);
      if (!m) {
        m = await readNpyFloat32(file);
        cache.set(file, m);
      }
      const end = (o.embedding.row + 1) * m.dim;
      // a truncated file claims rows it does not hold: that is no embedding at all
      if (o.embedding.row >= 0 && m.dim === deps.index.dim && end <= m.data.length) {
        const e = m.data.subarray(o.embedding.row * m.dim, end);
        const dino = await dinoRow(outDir, o, deps.index, cache);
        return suggestClasses(deps.index, e, {}, dino)
          .filter((s) => Number.isFinite(s.score))
          .slice(0, 5)
          .map((s) => ({ classId: s.classId, score: Math.min(1, Math.max(0, s.score)) }));
      }
    } catch {
      // unreadable embeddings: the sidecar's text scores below still give suggestions
    }
  }
  const topk = (o.class?.topk ?? []).filter((t) => t.toolClass && Number.isFinite(t.score));
  const max = Math.max(...topk.map((t) => t.score), 0);
  const exps = topk.map((t) => Math.exp((t.score - max) / 2));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return topk
    .map((t, i) => ({ classId: t.toolClass as string, score: (exps[i] ?? 0) / sum }))
    .slice(0, MAX_SUGGESTIONS);
}

/** A sidecar-supplied relative path stays inside the draft: `..` segments and absolute paths are dropped. */
function visionPath(rel: string | null | undefined, photoIndex: number): string | undefined {
  if (!rel || rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) return undefined;
  return `vision/${photoIndex}/${rel}`;
}

/** Sidecar ids restart per run; a key already used by a kept (added) object gets a `.<n>` suffix. */
function freeKey(draft: Draft, base: string): string {
  if (!draft.objects.some((o) => o.key === base)) return base;
  for (let n = 2; ; n++) {
    const key = `${base}.${n}`;
    if (!draft.objects.some((o) => o.key === key)) return key;
  }
}

function newObject(photoIndex: number, o: SidecarObject, key: string): DraftObject {
  const crop = visionPath(o.cropOriented ?? o.crop?.path, photoIndex);
  const cutout = visionPath(o.cutoutOriented ?? o.cutout, photoIndex);
  const mask = visionPath(o.mask, photoIndex);
  const observation = toObservation(o);
  return {
    key,
    photo: photoIndex,
    objectId: o.id,
    alsoSeenIn: [],
    status: 'pending',
    name: {},
    tags: [],
    suggestions: [],
    classId: null,
    classOverridden: false,
    observation,
    fit: null,
    dimensionsMm: null,
    needsScale: !o.profile && !o.profilePx,
    dimensionsEstimated: false,
    ...((o.profile ?? o.profilePx) && !observation
      ? {
          error:
            'the sidecar profile of this object is not usable (degenerate length or too many stations)',
        }
      : {}),
    images: { ...(crop ? { crop } : {}), ...(cutout ? { cutout } : {}), ...(mask ? { mask } : {}) },
    preview: null,
  };
}

interface Sizing {
  /** What the fit scales the profile to; `null` = no honest size exists (nothing is fitted). */
  dimensionsMm: {
    length?: number | undefined;
    width?: number | undefined;
    thickness?: number | undefined;
  } | null;
  source: 'photo' | 'user' | 'estimated';
  estimated: boolean;
}

/**
 * The sizes an object is fitted at. A scaled photo: the measured profile, plus what the user typed. A photo without a
 * scale (the profile is in pixels): the typed length if there is one, otherwise the class-typical length of the chosen
 * (or best suggested) class, flagged as an estimate; with neither there is nothing to scale by.
 */
function sizingOf(obj: DraftObject, estimateClass: string | null | undefined): Sizing {
  const typed = obj.userDimensions;
  if (!obj.observation?.profileInPixels) {
    return { dimensionsMm: typed ?? {}, source: typed ? 'user' : 'photo', estimated: false };
  }
  if (typed?.length !== undefined) return { dimensionsMm: typed, source: 'user', estimated: false };
  const classId = obj.classOverridden ? obj.classId : (estimateClass ?? null);
  if (classId === null || !hasToolClass(classId)) {
    return { dimensionsMm: null, source: 'user', estimated: false };
  }
  return {
    dimensionsMm: { ...typed, length: typicalLengthMm(classId) },
    source: 'estimated',
    estimated: true,
  };
}

/** Fit an object from its stored observation and write the preview files. */
export async function refitObject(
  deps: DraftDeps,
  draft: Draft,
  obj: DraftObject,
): Promise<FittedObject | null> {
  if (!obj.observation) {
    obj.fit = null;
    obj.dimensionsMm = null;
    obj.preview = null;
    return null;
  }
  const pool = obj.suggestions.filter((s) => hasToolClass(s.classId));
  const decision = obj.classOverridden ? { classId: obj.classId } : {};
  let sizing = sizingOf(obj, pool[0]?.classId);
  obj.dimensionsEstimated = sizing.estimated;
  obj.needsScale = sizing.dimensionsMm === null;
  if (sizing.dimensionsMm === null) {
    // no scale, no typed size and no class to take a typical size from: nothing honest to fit
    obj.fit = null;
    obj.dimensionsMm = null;
    obj.preview = null;
    return null;
  }
  const observation = obj.observation;
  const fitAt = async (
    dims: NonNullable<Sizing['dimensionsMm']>,
    source: Sizing['source'],
    choice: { classId?: string | null },
  ): Promise<FittedObject> => {
    const cacheKey = JSON.stringify([observation, pool, dims, choice]);
    const known = deps.drafts.cachedFit(cacheKey);
    if (known) return known;
    // fitting is synchronous CPU work: let queued requests (SSE heartbeats, other API calls) run first
    await new Promise<void>((resolve) => setImmediate(resolve));
    const made = fitObject(
      {
        profile: observation.profile,
        colors: observation.colors,
        candidates: pool,
        dimensionsMm: dims,
        dimensionSource: source,
        ...(observation.profileKind ? { profileKind: observation.profileKind } : {}),
      },
      choice,
    );
    deps.drafts.rememberFit(cacheKey, made);
    return made;
  };
  let fitted = await fitAt(sizing.dimensionsMm, sizing.source, decision);
  if (sizing.estimated && fitted.classId !== null && fitted.classId !== pool[0]?.classId && !obj.classOverridden) {
    // the silhouette preferred another candidate than the top suggestion: that class, at its own typical length, is the
    // estimate (the class is pinned so the second fit cannot flip back to the first one)
    const chosen = fitted.classId;
    sizing = sizingOf(obj, chosen);
    if (sizing.dimensionsMm !== null) {
      // a pinned class has no alternatives of its own: the comparison shown is the one that chose it
      const alternatives = fitted.alternatives;
      fitted = { ...(await fitAt(sizing.dimensionsMm, sizing.source, { classId: chosen })), alternatives };
    }
  }
  if (sizing.estimated && fitted.classId === null) {
    // every candidate was rejected by the silhouette: a generic shape sized from a rejected class would be a made-up size
    obj.dimensionsEstimated = false;
    obj.needsScale = true;
    obj.fit = null;
    obj.dimensionsMm = null;
    obj.preview = null;
    return null;
  }
  obj.classId = fitted.classId;
  obj.fit = {
    method: fitted.fit.method,
    iou: fitted.fit.iou,
    confidence: fitted.fit.confidence,
    alternatives: fitted.alternatives,
  };
  obj.dimensionsMm = {
    length: fitted.dimensionsMm.length,
    width: fitted.dimensionsMm.width,
    thickness: fitted.dimensionsMm.thickness,
  };
  const dir = join(deps.drafts.dir(draft.id), 'preview');
  await mkdir(dir, { recursive: true });
  const stem = obj.key.replace(/[^A-Za-z0-9_.-]/g, '_');
  await writeAtomic(
    join(dir, `${stem}.glb`),
    exportGlb(fitted.modelLod1, { draft: draft.id, key: obj.key }),
  );
  await writeAtomic(join(dir, `${stem}.webp`), await renderThumbWebp(fitted.modelLod1));
  obj.preview = { glb: `preview/${stem}.glb`, thumb: `preview/${stem}.webp` };
  return fitted;
}

export interface AnalyzeOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, message: string) => void;
}

export async function analyzeDraft(
  deps: DraftDeps,
  draftId: string,
  options: AnalyzeOptions = {},
): Promise<Draft> {
  const { draft } = await deps.drafts.update(draftId, async (d) => {
    if (d.state === 'analyzing')
      throw new DraftError('conflict', 'this draft is already being analysed');
    d.state = 'analyzing';
    delete d.error;
    // tools already in the library stay marked; everything else is analysed again
    d.objects = d.objects.filter((o) => o.status === 'added');
  });
  const dir = deps.drafts.dir(draftId);
  try {
    const embeddings = new Map<string, NpyMatrix>();
    for (const photo of draft.photos) {
      options.onProgress?.(photo.index, draft.photos.length, `analysing ${photo.name}`);
      const outDir = join(dir, 'vision', String(photo.index));
      await mkdir(outDir, { recursive: true });
      const result = await deps.vision.photoToObjects({
        imagePath: join(dir, photo.file),
        outDir,
        // two points belong to the photo they were measured on (the first one); a scale applies to all photos
        calibration:
          photo.index === 0 || draft.calibration?.mmPerPx !== undefined ? draft.calibration : null,
        categoriesPath: deps.categoriesPath,
        mode: draft.mode,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      photo.mmPerPx = result.calibration?.mm_per_px ?? null;
      photo.calibrationMethod = result.calibration?.method ?? null;
      const overlay = visionPath(result.overlay?.segmentation, photo.index);
      if (overlay) photo.overlay = overlay;
      const sorted = [...result.objects].sort((a, b) => (b.areaPx ?? 0) - (a.areaPx ?? 0));
      const objects = draft.mode === 'single' ? sorted.slice(0, 1) : result.objects;
      for (const o of objects) {
        const obj = newObject(photo.index, o, freeKey(draft, `${photo.index}:${o.id}`));
        obj.suggestions = await suggestionsFor(deps, outDir, o, embeddings);
        obj.classId = obj.suggestions[0]?.classId ?? null;
        draft.objects.push(obj);
      }
    }
    const fresh = draft.objects.filter((o) => o.status === 'pending').map((o) => o.key);
    if (draft.mode === 'single' && fresh.length > 1) groupInPlace(draft, fresh);
    for (const obj of draft.objects) {
      if (obj.status === 'discarded') continue;
      await refitObject(deps, draft, obj);
    }
    draft.state = 'ready';
    await deps.drafts.exclusive(draftId, () => deps.drafts.save(draft));
  } catch (error) {
    await markAnalysisFailed(deps, draft, error);
    throw error;
  }
  return draft;
}

/** Never leaves a draft `analyzing`: if the draft as analysed cannot be saved, only the kept objects are written. */
async function markAnalysisFailed(deps: DraftDeps, draft: Draft, error: unknown): Promise<void> {
  draft.state = 'failed';
  draft.error = error instanceof Error ? error.message : String(error);
  const save = (): Promise<void> => deps.drafts.exclusive(draft.id, () => deps.drafts.save(draft));
  try {
    await save();
  } catch {
    draft.objects = draft.objects.filter((o) => o.status === 'added');
    await save();
  }
}

/** Set a new scale / reference for the photos; the next `analyzeDraft` run uses it (objects in the library stay). */
export async function recalibrateDraft(
  deps: DraftDeps,
  draftId: string,
  calibration: CalibrationInput,
): Promise<Draft> {
  const { draft } = await deps.drafts.update(draftId, async (d) => {
    assertReviewable(d, 'recalibrate');
    d.calibration = calibration;
    d.state = 'created';
  });
  return draft;
}

/** Edits are refused while the sidecar is still working on the draft (its result would overwrite them). */
function assertReviewable(draft: Draft, what: string): void {
  if (draft.state === 'analyzing')
    throw new DraftError('conflict', `cannot ${what} while the draft is being analysed`);
}

// --- review ---------------------------------------------------------------------------------------------------

function find(draft: Draft, key: string): DraftObject {
  const o = draft.objects.find((x) => x.key === key);
  if (!o) throw new DraftError('not_found', `no object ${key} in draft ${draft.id}`);
  return o;
}

/** Objects that group / merge / split may rearrange: not the ones already in the library, not the discarded. */
function findOpen(draft: Draft, key: string): DraftObject {
  const o = find(draft, key);
  if (o.status === 'added') throw new DraftError('conflict', `${key} is already in the library`);
  if (o.status === 'discarded') throw new DraftError('conflict', `${key} was discarded`);
  return o;
}

export async function patchDraftObject(
  deps: DraftDeps,
  draftId: string,
  key: string,
  patch: DraftObjectPatch,
): Promise<Draft> {
  if (patch.classId !== undefined && patch.classId !== null && !hasToolClass(patch.classId)) {
    throw new DraftError('invalid', `unknown class ${patch.classId}`);
  }
  const { draft } = await deps.drafts.update(draftId, async (d) => {
    assertReviewable(d, 'edit objects');
    const obj = find(d, key);
    if (obj.status === 'added') {
      throw new DraftError('conflict', `${key} is already in the library`);
    }
    if (patch.name) obj.name = { ...obj.name, ...patch.name };
    if (patch.tags) obj.tags = patch.tags;
    if (patch.status) obj.status = patch.status;
    let refit = false;
    if (patch.classId !== undefined) {
      obj.classId = patch.classId;
      obj.classOverridden = true;
      refit = true;
    }
    if (patch.dimensionsMm) {
      obj.userDimensions = { ...obj.userDimensions, ...patch.dimensionsMm };
      refit = true;
    }
    if (refit) await refitObject(deps, d, obj);
  });
  return draft;
}

/** Same tool in several photos: the most confident observation is the primary, the rest are kept as extra sources. */
function groupInPlace(draft: Draft, keys: readonly string[]): DraftObject {
  const members = keys.map((k) => findOpen(draft, k));
  const score = (o: DraftObject): number =>
    // a measured profile (mm) always beats one in pixels (the bonus exceeds any suggestion score, <= 1); a pixel one still
    // beats an object with no usable profile at all
    (o.observation ? 1 : 0) +
    (o.observation && !o.observation.profileInPixels ? 1.01 + o.observation.profile.lengthMm / 1e6 : 0) +
    (o.suggestions[0]?.score ?? 0);
  const primary = members.reduce((a, b) => (score(b) > score(a) ? b : a));
  for (const m of members) {
    if (m === primary) continue;
    primary.alsoSeenIn.push(m.key, ...m.alsoSeenIn);
    primary.suggestions = mergeSuggestions(primary.suggestions, m.suggestions);
    primary.tags = unionTags(primary.tags, m.tags).slice(0, MAX_TAGS);
    m.status = 'discarded';
    m.preview = null;
  }
  primary.classId = primary.classOverridden
    ? primary.classId
    : (primary.suggestions[0]?.classId ?? null);
  return primary;
}

function mergeSuggestions(
  a: DraftObject['suggestions'],
  b: DraftObject['suggestions'],
): DraftObject['suggestions'] {
  const sum = new Map<string, number>();
  for (const s of [...a, ...b]) sum.set(s.classId, (sum.get(s.classId) ?? 0) + s.score);
  const total = [...sum.values()].reduce((x, y) => x + y, 0) || 1;
  return [...sum.entries()]
    .map(([classId, score]) => ({ classId, score: score / total }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 5);
}

export async function groupDraftObjects(
  deps: DraftDeps,
  draftId: string,
  keys: readonly string[],
): Promise<Draft> {
  if (keys.length < 2) throw new DraftError('invalid', 'group needs at least two objects');
  const { draft } = await deps.drafts.update(draftId, async (d) => {
    assertReviewable(d, 'group objects');
    const primary = groupInPlace(d, keys);
    await refitObject(deps, d, primary);
  });
  return draft;
}

async function adoptEdited(
  deps: DraftDeps,
  draft: Draft,
  photoIndex: number,
  edited: SidecarObject,
  tags: readonly string[],
): Promise<DraftObject> {
  const outDir = join(deps.drafts.dir(draft.id), 'vision', String(photoIndex));
  const obj = newObject(photoIndex, edited, freeKey(draft, `${photoIndex}:${edited.id}`));
  obj.tags = unionTags(tags).slice(0, MAX_TAGS);
  obj.suggestions = await suggestionsFor(deps, outDir, edited, new Map());
  obj.classId = obj.suggestions[0]?.classId ?? null;
  await refitObject(deps, draft, obj);
  return obj;
}

/** Parts of one tool segmented apart (hammer head and handle): the sidecar re-profiles the union mask. */
export async function mergeDraftObjects(
  deps: DraftDeps,
  draftId: string,
  keys: readonly string[],
  signal?: AbortSignal,
): Promise<Draft> {
  const { draft } = await deps.drafts.update(draftId, async (d) => {
    assertReviewable(d, 'merge objects');
    const members = keys.map((k) => findOpen(d, k));
    const photo = members[0]?.photo;
    if (photo === undefined || members.length < 2 || members.some((m) => m.photo !== photo)) {
      throw new DraftError('invalid', 'merge needs two or more objects of the same photo');
    }
    const outDir = join(deps.drafts.dir(draftId), 'vision', String(photo));
    const merged = await deps.vision.mergeObjects(
      outDir,
      members.map((m) => m.objectId),
      signal,
    );
    for (const m of members) {
      m.status = 'discarded';
      m.preview = null;
    }
    const tags = members.flatMap((m) => m.tags);
    d.objects.push(await adoptEdited(deps, d, photo, merged, tags));
  });
  return draft;
}

export async function splitDraftObject(
  deps: DraftDeps,
  draftId: string,
  key: string,
  how: { linePx: [[number, number], [number, number]] } | { n: number },
  signal?: AbortSignal,
): Promise<Draft> {
  const { draft } = await deps.drafts.update(draftId, async (d) => {
    assertReviewable(d, 'split objects');
    const obj = findOpen(d, key);
    const outDir = join(deps.drafts.dir(draftId), 'vision', String(obj.photo));
    const parts = await deps.vision.splitObject(outDir, obj.objectId, how, signal);
    obj.status = 'discarded';
    obj.preview = null;
    for (const p of parts) d.objects.push(await adoptEdited(deps, d, obj.photo, p, obj.tags));
  });
  return draft;
}

/** An object the segmentation missed (a thin or low-contrast tool): SAM2 cuts it out of a click or a box on the photo. */
export async function addDraftObject(
  deps: DraftDeps,
  draftId: string,
  photo: number,
  prompt: { pointPx: [number, number] } | { boxXywh: [number, number, number, number] },
  signal?: AbortSignal,
): Promise<Draft> {
  const { draft } = await deps.drafts.update(draftId, async (d) => {
    assertReviewable(d, 'add objects');
    if (!d.photos.some((p) => p.index === photo)) {
      throw new DraftError('not_found', `no photo ${photo} in draft ${draftId}`);
    }
    const outDir = join(deps.drafts.dir(draftId), 'vision', String(photo));
    const added = await deps.vision.addObject(outDir, prompt, signal);
    d.objects.push(await adoptEdited(deps, d, photo, added, []));
  });
  return draft;
}

// --- commit ---------------------------------------------------------------------------------------------------

export interface CommitResult {
  tools: ToolSummary[];
  skipped: { key: string; reason: string }[];
}

/** Files of one object that stay with the tool: crop, cut-out and mask next to the photos it was cut from. */
async function collectSources(
  dir: string,
  obj: DraftObject,
): Promise<{ files: { name: string; bytes: Uint8Array }[]; docs: CustomTool['sources'] }> {
  const files: { name: string; bytes: Uint8Array }[] = [];
  const docs: CustomTool['sources'] = [];
  for (const [label, rel] of [
    ['crop', obj.images.crop],
    ['cutout', obj.images.cutout],
    ['mask', obj.images.mask],
  ] as const) {
    if (!rel) continue;
    const bytes = await readFile(join(dir, rel)).catch(() => null);
    if (!bytes) continue;
    // content-addressed: ids get reused after a delete and sources are served as immutable
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
    const name = `${label}-${obj.key.replace(/[^A-Za-z0-9]/g, '-')}-${digest}${extname(rel) || '.png'}`;
    files.push({ name, bytes: new Uint8Array(bytes) });
    docs.push({ file: name, objectId: obj.key });
  }
  return { files, docs };
}

const photoFileName = (photo: Draft['photos'][number]): string =>
  `photo-${photo.sha256.slice(0, 12)}${extname(photo.file)}`;

async function commitObject(
  deps: DraftDeps,
  draft: Draft,
  obj: DraftObject & { observation: NonNullable<DraftObject['observation']> },
  fitted: FittedObject,
  now: string,
  extraTags: readonly string[],
): Promise<CustomTool> {
  const dir = deps.drafts.dir(draft.id);
  const clsName = fitted.classId
    ? getToolClass(fitted.classId).name
    : { en: 'Custom tool', ru: 'Свой инструмент' };
  const sources = await collectSources(dir, obj);
  const photoIndexes = new Set([obj.photo, ...obj.alsoSeenIn.map((k) => Number(k.split(':')[0]))]);
  const photos = draft.photos.filter((p) => photoIndexes.has(p.index));
  return deps.tools.exclusive(async () => {
    const id = await deps.tools.freeId(obj.name.en ?? obj.name.ru ?? fitted.classId ?? 'tool');
    const saved = await deps.tools.save(
      {
        version: 1,
        id,
        name: { en: obj.name.en ?? clsName.en, ru: obj.name.ru ?? clsName.ru },
        createdAt: now,
        updatedAt: now,
        tags: unionTags(obj.tags, extraTags),
        classId: fitted.classId,
        classCandidates: obj.suggestions.slice(0, 5),
        params: fitted.params,
        profile: fitted.profile,
        colors: obj.observation.colors,
        partColors: fitted.partColors,
        dimensionsMm: fitted.dimensionsMm,
        // what the user typed, exactly: later refits (a class change in the tool detail) keep aiming at it
        ...(obj.userDimensions ? { userDimensionsMm: obj.userDimensions } : {}),
        fit: fitted.fit,
        ...(obj.observation.profileKind ? { profileKind: obj.observation.profileKind } : {}),
        sources: [
          ...sources.docs,
          ...photos.map((p) => ({ file: photoFileName(p), sha256: p.sha256 })),
        ],
      },
      fitted,
      sources.files,
    );
    for (const photo of photos) {
      const target = join(deps.tools.root, id, 'source', photoFileName(photo));
      // hard link keeps one copy of a large photo shared by every tool cut from it; fall back to a copy
      await link(join(dir, photo.file), target).catch(() =>
        copyFile(join(dir, photo.file), target),
      );
    }
    return saved;
  });
}

/** Add the accepted (or the named) objects to the library; every tool is recorded in the draft as soon as it is saved. */
export async function commitDraft(
  deps: DraftDeps,
  draftId: string,
  keys?: readonly string[],
  now = new Date(),
  extraTags: readonly string[] = [],
): Promise<CommitResult> {
  const { value } = await deps.drafts.update(draftId, async (draft) => {
    assertReviewable(draft, 'add tools');
    if (draft.state !== 'ready') {
      throw new DraftError('conflict', 'analyse the draft (again) before adding its tools');
    }
    const result: CommitResult = { tools: [], skipped: [] };
    for (const key of keys ?? []) {
      if (!draft.objects.some((o) => o.key === key)) {
        result.skipped.push({ key, reason: 'no such object in this draft' });
      }
    }
    const chosen = draft.objects.filter((o) =>
      keys ? keys.includes(o.key) : o.status === 'accepted',
    );
    // refuse before anything is saved: a merged list over the limit would fail halfway through the commit
    const tooMany = chosen.find(
      (o) =>
        o.status !== 'added' &&
        o.status !== 'discarded' &&
        o.observation !== null &&
        unionTags(o.tags, extraTags).length > MAX_TAGS,
    );
    if (tooMany) {
      throw new DraftError('invalid', `${tooMany.key}: a tool takes at most ${MAX_TAGS} tags`);
    }
    for (const obj of chosen) {
      if (obj.status === 'added') {
        result.skipped.push({ key: obj.key, reason: 'already added' });
        continue;
      }
      if (obj.status === 'discarded') {
        result.skipped.push({ key: obj.key, reason: 'discarded' });
        continue;
      }
      if (!obj.observation) {
        result.skipped.push({
          key: obj.key,
          reason: obj.needsScale
            ? 'no scale: recalibrate the draft (POST /api/tools/drafts/:id/calibration) and analyse again'
            : (obj.error ?? 'the sidecar returned no usable profile for this object'),
        });
        continue;
      }
      const fitted = await refitObject(deps, draft, obj);
      if (!fitted) {
        result.skipped.push({
          key: obj.key,
          reason: 'no size: the photo has no scale and nothing is known about this object; pick a class or type a real length',
        });
        continue;
      }
      const saved = await commitObject(
        deps,
        draft,
        { ...obj, observation: obj.observation },
        fitted,
        now.toISOString(),
        extraTags,
      );
      obj.status = 'added';
      obj.toolId = saved.id;
      result.tools.push(summarize(saved));
      await deps.drafts.save(draft);
    }
    return result;
  });
  return value;
}

/** After a daemon restart a draft left `analyzing` by the old process can never finish: mark it failed so it can be re-run. */
export async function recoverInterruptedDrafts(drafts: DraftStore): Promise<number> {
  const entries = await readdir(drafts.root, { withFileTypes: true }).catch(() => []);
  let fixed = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    await drafts
      .update(e.name, async (d) => {
        if (d.state !== 'analyzing') return;
        d.state = 'failed';
        d.error = 'interrupted by a daemon restart; analyse again';
        fixed++;
      })
      .catch(() => undefined);
  }
  return fixed;
}
