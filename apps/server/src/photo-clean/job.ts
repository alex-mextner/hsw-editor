/**
 * `photo.clean`: makes the cleaned variant of a calibrated wall photo. The board footprint (calibration -> polygon,
 * plus a margin) is the mask. A basic local fill is produced first and stored at once; then, when an image backend of
 * `draw` is ready, the model's edit replaces it. The original photo is never touched: a variant is a second photo of
 * the wall (`cleanOf`, `view: 'clean'`), added and replaced with ordinary, undoable ops.
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type DrawBackendId, type DrawRequest, type DrawResult } from '@hsw-editor/draw';
import { type Actor, type Photo, type Wall, newId } from '@hsw-editor/core';
import {
  CLEAN_MARGIN_MM,
  boardExtent,
  boardFootprintPx,
  fillWall,
  matchGrain,
  reportPatch,
  transferDetail,
  footprintDrift,
  footprintSignature,
  materialDrift,
  photoMapFromCalibration,
  rasterisePolygon,
} from '@hsw-editor/overlay';
import { z } from 'zod';
import { type JobContext, type JobRegistry, defaultJobRegistry, registerJob } from '../jobs.ts';
import { compositeEdited, outsideDrift } from './composite.ts';
import {
  type Pixels,
  canvasPng,
  encodeJpeg,
  maskPixels,
  placeOnCanvas,
  readPixels,
  uncanvas,
} from './pixels.ts';

export const PHOTO_CLEAN_KIND = 'photo.clean';
export const CLEAN_ACTOR: Actor = { kind: 'agent', name: 'photo-clean' };

/**
 * The model's wall must be roughly the colour of the wall: more than this many levels (mean over the area) away from
 * the basic fill - which IS the wall around the area, continued - is a flat white or another wall, and is dropped. What
 * passes still only lends its detail: the colour and the slow light stay the wall's (`transferDetail`).
 */
export const MAX_COLOUR_OFF = 24;

/** The model must leave the unmasked part alone: a mean per-channel difference above this means it redrew the photo. */
export const MAX_OUTSIDE_DRIFT = 14;

export const PhotoCleanInputSchema = z.strictObject({
  wallId: z.string().min(1),
  photoId: z.string().min(1),
  /** `auto`: basic first, then the AI edit when a backend is ready. `basic`: the local fill only. */
  method: z.enum(['auto', 'basic']).default('auto'),
  /** Make the variant again even when the footprint has not moved. */
  refresh: z.boolean().default(false),
});
export type PhotoCleanInput = z.infer<typeof PhotoCleanInputSchema>;

/** What the AI step came to; the editor shows a quiet note for everything but `done`. */
export type AiState =
  | 'done'
  | 'not-asked'
  | 'login_required'
  | 'quota_exhausted'
  | 'unavailable'
  | 'rejected'
  | 'failed'
  | 'disabled';

export interface PhotoCleanResult {
  /** `stale`: the board moved (or the photo went) while the model worked; the result was dropped. */
  readonly status:
    | 'ok'
    | 'current'
    | 'needs_calibration'
    | 'no_footprint'
    | 'photo_not_found'
    | 'stale';
  /** The variant photo now shown for the original, when there is one. */
  readonly variantId: string | null;
  readonly method: 'basic' | 'ai' | null;
  readonly ai: AiState;
  readonly aiMessage?: string;
}

/** The slice of the draw runtime the clean needs; tests pass a fake. */
export interface CleanDraw {
  /** Backends to try, in order (empty: the user turned the AI off or pinned `manual`). */
  order(): Promise<readonly DrawBackendId[]>;
  run(req: DrawRequest, signal: AbortSignal, forced: DrawBackendId): Promise<DrawResult>;
}

export interface PhotoCleanDeps {
  readonly wallDir: (wallId: string) => string;
  readonly draw: CleanDraw | null;
}

const EDIT_PROMPT = [
  'Image 1 is a photo of a wall. Image 2 is a black-and-white mask with the same framing: the WHITE area marks the part of the wall to clean.',
  'Edit image 1: inside the white area remove everything that is there (old boards, perforated panels, hooks, tools, screws, holes, stains, cables, clutter) and replace it with a clean, empty wall surface that continues the wall around it: the same colour, paint texture, lighting gradient and perspective.',
  'Outside the white area change nothing: keep every pixel, object and edge exactly as in image 1. The grey bars at the edges are padding: keep them as they are.',
  'Add nothing new: no text, no borders, no objects. Output only the edited photo, with the same framing and aspect ratio as image 1.',
].join(' ');

function variantOf(wall: Wall, originalId: string): Photo | undefined {
  return wall.photos.find((photo) => photo.cleanOf === originalId);
}

/**
 * Stores `pixels` as the cleaned variant of `original` and swaps it in for whichever variant the wall has NOW. The wall
 * is read again here: the AI step takes seconds to minutes, and meanwhile the user may have undone the basic variant
 * or moved the board. A result for a footprint that is no longer the board's is dropped (null), its file removed.
 */
async function storeVariant(
  ctx: JobContext,
  wallId: string,
  originalId: string,
  pixels: Pixels,
  backend: string,
  footprint: string,
): Promise<Photo | null> {
  const bytes = await encodeJpeg(pixels);
  const file = await ctx.walls.addAsset(wallId, {
    dir: 'photos/derived',
    ext: 'jpg',
    bytes,
    prefix: 'clean',
  });
  try {
    const { wall } = await ctx.walls.get(wallId);
    const original = wall.photos.find((photo) => photo.id === originalId);
    if (original === undefined || movedSince(wall, original, footprint)) {
      await ctx.walls.removeAsset(wallId, file);
      return null;
    }
    const previous = variantOf(wall, originalId);
    const variant: Photo = {
      id: newId('p'),
      file,
      mime: 'image/jpeg',
      width: pixels.width,
      height: pixels.height,
      name: `${original.name ?? original.id} (clean)`,
      origin: 'generated',
      view: 'clean',
      backend,
      cleanOf: original.id,
      cleanFootprint: footprint,
    };
    await ctx.walls.apply(wallId, {
      ops: [
        ...(previous ? [{ type: 'removePhoto' as const, id: previous.id }] : []),
        { type: 'addPhoto' as const, photo: variant },
      ],
      actor: CLEAN_ACTOR,
      label: `clean background (${backend})`,
    });
    return variant;
  } catch (error) {
    await ctx.walls.removeAsset(wallId, file).catch(() => undefined);
    throw error;
  }
}

/** True when the board's footprint on `photo` is not (within the material drift) the one `footprint` describes. */
function movedSince(wall: Wall, photo: Photo, footprint: string): boolean {
  if (photo.calibration === undefined) return true;
  const image = { width: photo.width, height: photo.height };
  const extent = boardExtent(wall.board);
  const map = photoMapFromCalibration(photo.calibration, image, extent);
  const polygon = map === null ? null : boardFootprintPx(map, extent, CLEAN_MARGIN_MM);
  return polygon === null || footprintDrift(footprint, polygon, image) > materialDrift(image);
}

function failureState(code: string): AiState {
  if (code === 'login_required') return 'login_required';
  if (code === 'quota_exhausted') return 'quota_exhausted';
  if (code === 'backend_unavailable') return 'unavailable';
  return 'failed';
}

interface AiOutcome {
  readonly state: AiState;
  readonly message?: string;
  readonly pixels?: Pixels;
  readonly backend?: DrawBackendId;
}

/** Asks the first ready draw backend to edit the photo, and puts only the masked area of its answer back. */
async function aiClean(
  deps: PhotoCleanDeps,
  ctx: JobContext,
  original: Pixels,
  mask: Uint8Array,
  reference: Uint8Array,
  workDir: string,
): Promise<AiOutcome> {
  if (deps.draw === null) return { state: 'disabled', message: 'image backends are not set up' };
  const order = await deps.draw.order();
  if (order.length === 0)
    return { state: 'disabled', message: 'the AI clean is switched off in the draw settings' };
  const placement = placeOnCanvas(original.width, original.height);
  await mkdir(workDir, { recursive: true });
  const photoPath = join(workDir, 'photo.png');
  const maskPath = join(workDir, 'mask.png');
  await Bun.write(photoPath, await canvasPng(original, placement));
  await Bun.write(
    maskPath,
    await canvasPng(maskPixels(mask, original.width, original.height), placement, {
      r: 0,
      g: 0,
      b: 0,
    }),
  );
  const request: DrawRequest = {
    version: 1,
    prompt: EDIT_PROMPT,
    refs: [
      { path: photoPath, role: 'subject' },
      { path: maskPath, role: 'view' },
    ],
    n: 1,
    size: placement.size,
    outDir: join(workDir, 'out'),
    tag: ctx.id,
  };
  let last: AiOutcome = { state: 'unavailable', message: 'no image backend answered' };
  for (const backend of order) {
    if (ctx.signal.aborted) break;
    const result = await deps.draw.run(request, ctx.signal, backend);
    if (result.ok) {
      const image = result.images[0];
      if (!image) {
        last = { state: 'failed', message: 'the backend returned no image' };
        continue;
      }
      const edited = await uncanvas(image.path, placement, original.width, original.height);
      const drift = outsideDrift(original.data, edited.data, original.width, original.height, mask);
      if (drift > MAX_OUTSIDE_DRIFT) {
        return {
          state: 'rejected',
          message: `the model redrew the photo (off by ${drift.toFixed(0)} levels outside the area)`,
        };
      }
      // The patch has to BE the wall: its colour is checked against the basic fill (the surrounding wall continued),
      // and a patch smoother than the wall around it gets the wall's grain, so it never reads as a flat rectangle.
      const report = reportPatch(
        edited.data,
        reference,
        original.data,
        original.width,
        original.height,
        mask,
      );
      if (report.colourOff > MAX_COLOUR_OFF) {
        return {
          state: 'rejected',
          message: `the model's wall does not match the wall around it (off by ${report.colourOff.toFixed(0)} levels)`,
        };
      }
      // Colour and slow light come from the basic fill, the model contributes the detail; then the patch gets the
      // grain of the wall if it is smoother than it, so nothing reads as a flat pasted rectangle.
      const detailRadius = Math.max(8, 0.03 * Math.max(original.width, original.height));
      const blended = transferDetail(
        edited.data,
        reference,
        mask,
        original.width,
        original.height,
        detailRadius,
      );
      const patchGrain = reportPatch(
        blended,
        reference,
        original.data,
        original.width,
        original.height,
        mask,
      ).patchGrain;
      const grained = matchGrain(
        blended,
        original.width,
        original.height,
        mask,
        patchGrain,
        report.wallGrain,
        7,
      );
      const featherPx = Math.max(2, 0.004 * Math.max(original.width, original.height));
      const data = compositeEdited(
        original.data,
        grained,
        original.width,
        original.height,
        mask,
        featherPx,
      );
      return {
        state: 'done',
        pixels: { width: original.width, height: original.height, data },
        backend: result.backend,
      };
    }
    last = { state: failureState(result.error.code), message: result.error.message };
    // Only an unavailable or logged-out backend hands over to the next one; quota and challenge stop the chain.
    if (result.error.code !== 'login_required' && result.error.code !== 'backend_unavailable')
      break;
  }
  return last;
}

export async function runPhotoClean(
  deps: PhotoCleanDeps,
  input: PhotoCleanInput,
  ctx: JobContext,
): Promise<PhotoCleanResult> {
  const none = (status: PhotoCleanResult['status']): PhotoCleanResult => ({
    status,
    variantId: null,
    method: null,
    ai: 'not-asked',
  });
  const { wall } = await ctx.walls.get(input.wallId);
  const asked = wall.photos.find((photo) => photo.id === input.photoId);
  // A variant stands for its original: asking to clean the clean one cleans the photo it came from.
  const original =
    asked?.cleanOf === undefined ? asked : wall.photos.find((photo) => photo.id === asked.cleanOf);
  if (original === undefined) return none('photo_not_found');
  if (original.calibration === undefined) return none('needs_calibration');
  const image = { width: original.width, height: original.height };
  const extent = boardExtent(wall.board);
  const map = photoMapFromCalibration(original.calibration, image, extent);
  const polygon = map === null ? null : boardFootprintPx(map, extent, CLEAN_MARGIN_MM);
  if (polygon === null) return none('no_footprint');
  const signature = footprintSignature(polygon, image);

  const existing = variantOf(wall, original.id);
  // The variant belongs to this footprint (the board may have moved a little since: that does not count).
  const matches =
    existing !== undefined &&
    footprintDrift(existing.cleanFootprint ?? '', polygon, image) <= materialDrift(image);
  const wantsAi = input.method === 'auto';
  if (matches && !input.refresh && (!wantsAi || existing.backend !== 'basic')) {
    return {
      status: 'current',
      variantId: existing.id,
      method: existing.backend === 'basic' ? 'basic' : 'ai',
      ai: existing.backend === 'basic' ? 'not-asked' : 'done',
    };
  }

  ctx.progress({ fraction: 0.05, message: 'reading the photo…' });
  const wallDir = deps.wallDir(input.wallId);
  const source = await readPixels(join(wallDir, original.file));
  const mask = rasterisePolygon(polygon, source.width, source.height);

  // An AI variant for this footprint is never traded for the basic one by a refresh: it stays until the model's new
  // answer replaces it, so a logged-out or out-of-quota backend cannot make the picture worse.
  // The basic fill: the variant itself, and the yardstick the model's wall is held against.
  const filled = fillWall(source.data, source.width, source.height, 3, mask);
  const reference = new Uint8Array(filled.buffer, filled.byteOffset, filled.length);
  let variant: Photo | undefined =
    wantsAi && matches && existing?.backend !== 'basic' ? existing : undefined;
  if (variant === undefined) {
    ctx.progress({ fraction: 0.2, message: 'cleaning the wall (basic)…' });
    const stored = await storeVariant(
      ctx,
      input.wallId,
      original.id,
      { width: source.width, height: source.height, data: reference },
      'basic',
      signature,
    );
    if (stored === null) return none('stale');
    variant = stored;
  }
  if (!wantsAi) {
    return { status: 'ok', variantId: variant.id, method: 'basic', ai: 'not-asked' };
  }

  ctx.progress({ fraction: 0.5, message: 'asking the image model…' });
  const workDir = join(ctx.home, 'photo-clean', ctx.id);
  await pruneWorkDirs(join(ctx.home, 'photo-clean'));
  try {
    const outcome = await aiClean(deps, ctx, source, mask, reference, workDir);
    if (outcome.state === 'done' && outcome.pixels !== undefined && outcome.backend !== undefined) {
      const upgraded = await storeVariant(
        ctx,
        input.wallId,
        original.id,
        outcome.pixels,
        outcome.backend,
        signature,
      );
      if (upgraded === null) return none('stale');
      return { status: 'ok', variantId: upgraded.id, method: 'ai', ai: 'done' };
    }
    return {
      status: 'ok',
      variantId: variant.id,
      method: variant.backend === 'basic' ? 'basic' : 'ai',
      ai: outcome.state,
      ...(outcome.message === undefined ? {} : { aiMessage: outcome.message }),
    };
  } finally {
    // Whatever happens (a thrown error included) the full-size working copies go; only what a backend left to be
    // investigated (its failure screenshots) stays, and a directory with nothing in it does not.
    await tidyWorkDir(workDir);
  }
}

/** Failure files a backend writes next to its answer (`chatgpt-browser-failure-*.png`): worth keeping to investigate. */
const KEEP_PATTERN = /failure/i;
/** Kept failure directories older than this are pruned. */
const KEEP_FOR_MS = 7 * 24 * 3600 * 1000;

async function tidyWorkDir(workDir: string): Promise<void> {
  // Best effort, and never the reason a job fails: the variant is already stored (or the real error is on its way).
  const gone = (path: string): Promise<void> =>
    rm(path, { recursive: true, force: true }).catch(() => undefined);
  await Promise.all([gone(join(workDir, 'photo.png')), gone(join(workDir, 'mask.png'))]);
  const out = join(workDir, 'out');
  const names = await readdir(out).catch(() => [] as string[]);
  await Promise.all(
    names.filter((name) => !KEEP_PATTERN.test(name)).map((name) => gone(join(out, name))),
  );
  if (names.every((name) => !KEEP_PATTERN.test(name))) await gone(workDir);
}

/** Removes kept failure directories older than `KEEP_FOR_MS`; best effort. */
export async function pruneWorkDirs(root: string, now = Date.now()): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, name);
    const info = await stat(dir).catch(() => null);
    if (info !== null && now - info.mtimeMs > KEEP_FOR_MS) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function registerPhotoCleanJob(
  deps: PhotoCleanDeps,
  registry: JobRegistry = defaultJobRegistry,
): void {
  registerJob(
    {
      kind: PHOTO_CLEAN_KIND,
      inputSchema: PhotoCleanInputSchema,
      // The AI step waits on the human-paced draw queue; the basic step is quick. One run at a time per kind.
      async run(input, ctx) {
        const result = await runPhotoClean(deps, input, ctx);
        ctx.progress({ fraction: 1, message: result.method ?? result.status });
        return JSON.parse(JSON.stringify(result));
      },
    },
    registry,
  );
}
