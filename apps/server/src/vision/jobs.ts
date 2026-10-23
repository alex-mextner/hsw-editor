/**
 * Vision jobs on Core's job runner (`registerJob`): `vision.photo_to_wall` and the stage jobs `vision.calibrate`,
 * `vision.segment`, `vision.fit`. The heavy work happens in the sidecar; here we map a wall photo to a file, stream
 * progress, store model files as wall assets and turn the sidecar's proposal into ops.
 *
 * Nothing the pipeline detects is applied to the wall unless the caller sets `autoApplyConfidence` (then only the
 * items the service flagged `autoApply` are applied, as one undoable batch). The photo calibration IS applied
 * (`setCalibration`, a measurement the user asked for) unless `applyCalibration: false`.
 *
 * Re-running a job with the same photo bytes and parameters returns the stored result (`cached: true`) without
 * calling the sidecar and without storing the model files twice.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type Actor,
  type Calibration,
  CalibrationSchema,
  IdSchema,
  type JsonValue,
  type LeafOp,
  type Photo,
  type Wall,
} from '@hsw-editor/core';
import { z } from 'zod';
import { type JobContext, type JobRegistry, defaultJobRegistry, registerJob } from '../jobs.ts';
import type { VisionClient, ServiceRequest } from './client.ts';
import {
  type CalibrateParams,
  CalibrateParamsSchema,
  FixedDimsSchema,
  type PhotoToObjectsResult,
  type PhotoToWallResult,
  type ProposalItem,
  SegmentParamsSchema,
  type SegmentParams,
  type StreamEvent,
  VisionError,
  calibrateToService,
  segmentToService,
} from './types.ts';

export const VISION_ACTOR: Actor = { kind: 'agent', name: 'vision' };
export const JOB_KINDS = {
  photoToWall: 'vision.photo_to_wall',
  calibrate: 'vision.calibrate',
  segment: 'vision.segment',
  fit: 'vision.fit',
  photoToObjects: 'vision.photo_to_objects',
} as const;

export interface VisionJobDeps {
  readonly client: VisionClient;
  /** Absolute directory of a wall (`<home>/walls/<id>`). */
  wallDir(wallId: string): string;
  /** The bank index (`/api/bank/index`) for tool classes and holder hints; null when unavailable. */
  bankIndex(): Promise<JsonValue | null>;
  /** The editor's data home (`HSW_EDITOR_HOME`): the stage cache of photos that belong to no wall lives under it. */
  homeDir(): string;
}

const absolutePath = z.string().refine((value) => isAbsolute(value), 'must be an absolute path');
const JsonSchema = z.json();
function asJson(value: unknown): JsonValue {
  return JsonSchema.parse(value);
}

// ---- inputs ----------------------------------------------------------------------------------------

const PhotoInput = {
  wallId: IdSchema,
  photoId: IdSchema,
  /** Ask the user (a `calibration` input request) when no scale could be established. */
  askUser: z.boolean().default(true),
} as const;

export const PhotoToWallInputSchema = z.strictObject({
  ...PhotoInput,
  calibrate: CalibrateParamsSchema.optional(),
  segment: SegmentParamsSchema.optional(),
  /** Per segmentation instance id (as string): dimension overrides in mm, hard constraints of that fit. */
  fixedDims: z.record(z.string(), FixedDimsSchema).optional(),
  instances: z.array(z.number().int()).max(500).optional(),
  /** Items at or above this confidence are applied right away; null/absent = everything stays a proposal. */
  autoApplyConfidence: z.number().min(0).max(1).nullable().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  /** Confidence below this asks for another view (`request_view`). */
  viewFlagIou: z.number().min(0).max(1).optional(),
  maxObjects: z.number().int().min(1).max(500).optional(),
  /** Other photos of the wall (different viewpoint) used as held-out views. */
  extraPhotoIds: z.array(IdSchema).max(6).optional(),
  /** Shift every proposed pose by this many mm (anchors a grid photo's arbitrary origin to the board). */
  anchorMm: z.tuple([z.number(), z.number()]).optional(),
  aiAssist: z.boolean().optional(),
  applyCalibration: z.boolean().default(true),
  device: z.enum(['auto', 'cpu', 'cuda']).optional(),
  refresh: z.boolean().default(false),
});
export type PhotoToWallInput = z.infer<typeof PhotoToWallInputSchema>;

export const CalibrateInputSchema = z.strictObject({
  ...PhotoInput,
  calibrate: CalibrateParamsSchema.optional(),
  segment: SegmentParamsSchema.optional(),
  applyCalibration: z.boolean().default(true),
  refresh: z.boolean().default(false),
});

export const SegmentInputSchema = z.strictObject({
  wallId: IdSchema,
  photoId: IdSchema,
  segment: SegmentParamsSchema.optional(),
  refresh: z.boolean().default(false),
});

export const FitInputSchema = z.strictObject({
  ...PhotoInput,
  instance: z.number().int(),
  calibrate: CalibrateParamsSchema.optional(),
  segment: SegmentParamsSchema.optional(),
  fixedDims: FixedDimsSchema.optional(),
  template: z.enum(['lathe', 'flat', 'box']).optional(),
  planar: z.boolean().optional(),
  maxTries: z.number().int().min(1).max(8).optional(),
  device: z.enum(['auto', 'cpu', 'cuda']).optional(),
  refresh: z.boolean().default(false),
});

export const PhotoToObjectsInputSchema = z
  .strictObject({
    /** A photo anywhere on this machine ... */
    imagePath: absolutePath.optional(),
    /** ... or a photo of a wall (then `wallId` + `photoId`). */
    wallId: IdSchema.optional(),
    photoId: IdSchema.optional(),
    /** Where masks, crops, models, `embeddings.npy` and `objects.json` are written (default: under the stage cache). */
    outDir: absolutePath.optional(),
    calibrate: CalibrateParamsSchema.optional(),
    segment: SegmentParamsSchema.optional(),
    /** Categories file / comma list instead of the bank index (anything `threed_vision.recognise.load_categories` reads). */
    categories: z.string().min(1).optional(),
    fixedDims: z.record(z.string(), FixedDimsSchema).optional(),
    instances: z.array(z.number().int()).max(500).optional(),
    maxObjects: z.number().int().min(1).max(500).optional(),
    minAreaPx: z.number().int().min(1).optional(),
    topk: z.number().int().min(1).max(20).optional(),
    cropPad: z.number().min(0).max(1).optional(),
    colours: z.boolean().optional(),
    inlineEmbeddings: z.boolean().optional(),
    /** Other viewpoints of the same objects (absolute paths): held-out views of every fit. */
    extraImagePaths: z.array(absolutePath).max(6).optional(),
    /** Recognise against the bank's tool classes (default: the built-in vocabulary, or `categories`). */
    useBank: z.boolean().default(false),
    device: z.enum(['auto', 'cpu', 'cuda']).optional(),
    refresh: z.boolean().default(false),
  })
  .refine(
    (input) =>
      (input.imagePath !== undefined) !==
        (input.wallId !== undefined && input.photoId !== undefined) &&
      (input.wallId === undefined) === (input.photoId === undefined),
    { message: 'give either imagePath, or wallId and photoId' },
  );
export type PhotoToObjectsInput = z.infer<typeof PhotoToObjectsInputSchema>;

/** What the UI's calibration widget answers a `calibration` input request with. */
export const CalibrationAnswerSchema = z.union([
  z.strictObject({
    pointsPx: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]),
    distanceMm: z.number().positive(),
  }),
  z.strictObject({ mmPerPx: z.number().positive() }),
]);

// ---- shared helpers -------------------------------------------------------------------------------

interface LoadedPhoto {
  readonly wall: Wall;
  readonly photo: Photo;
  readonly path: string;
}

async function loadPhoto(
  deps: VisionJobDeps,
  ctx: JobContext,
  wallId: string,
  photoId: string,
): Promise<LoadedPhoto> {
  const { wall } = await ctx.walls.get(wallId);
  const photo = wall.photos.find((candidate) => candidate.id === photoId);
  if (photo === undefined) throw new Error(`photo ${photoId} is not on wall ${wallId}`);
  const path = join(deps.wallDir(wallId), photo.file);
  if (!existsSync(path))
    throw new Error(`photo file ${photo.file} of wall ${wallId} is missing on disk`);
  return { wall, photo, path };
}

function workDir(deps: VisionJobDeps, wallId: string): string {
  return join(deps.wallDir(wallId), 'vision');
}

function imageRef(
  deps: VisionJobDeps,
  wallId: string,
  photo: LoadedPhoto,
  refresh: boolean,
): ServiceRequest {
  return {
    image_path: photo.path,
    work_dir: workDir(deps, wallId),
    ...(refresh ? { refresh: true } : {}),
  };
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest('hex');
}

/** JSON with sorted keys: the same parameters always hash to the same cache key. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashOf(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(stableStringify(value)).digest('hex');
}

interface StoredJobResult {
  readonly result: JsonValue;
  /** Asset paths (relative to the wall dir) the result refers to; the entry is stale when one is gone. */
  readonly assets: readonly string[];
}

async function readStored(
  deps: VisionJobDeps,
  wallId: string,
  key: string,
): Promise<JsonValue | null> {
  try {
    const stored = z
      .object({ result: z.json(), assets: z.array(z.string()) })
      .parse(
        JSON.parse(await readFile(join(workDir(deps, wallId), 'jobs', `${key}.json`), 'utf8')),
      );
    return stored.assets.every((asset) => existsSync(join(deps.wallDir(wallId), asset)))
      ? stored.result
      : null;
  } catch {
    return null;
  }
}

async function writeStored(
  deps: VisionJobDeps,
  wallId: string,
  key: string,
  stored: StoredJobResult,
): Promise<void> {
  const path = join(workDir(deps, wallId), 'jobs', `${key}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(stored));
}

function describeError(error: unknown): Error {
  return error instanceof VisionError
    ? new Error(error.describe(), { cause: error })
    : error instanceof Error
      ? error
      : new Error(String(error));
}

function sameCalibration(a: Calibration | undefined, b: Calibration): boolean {
  return a !== undefined && stableStringify(a) === stableStringify(b);
}

/** Opens a `calibration` input request and returns the calibration parameters the user answered with, or null. */
async function askForScale(
  ctx: JobContext,
  wallId: string,
  photoId: string,
  message: string,
): Promise<CalibrateParams | null> {
  ctx.progress({
    message: 'waiting for a scale (two-point calibration)',
    data: { type: 'needs_calibration', photoId, message },
  });
  const answered = await ctx.walls.askUser(
    wallId,
    {
      kind: 'calibration',
      photoId,
      title: 'Set the scale of this photo',
      prompt: `${message} Pick two points and enter their real distance.`,
      payload: { photoId, mode: 'two-point' },
    },
    VISION_ACTOR,
    ctx.signal,
  );
  if (answered.status !== 'answered') return null;
  const parsed = CalibrationAnswerSchema.safeParse(answered.answer);
  if (!parsed.success) return null;
  return 'mmPerPx' in parsed.data
    ? { mode: 'manual', mmPerPx: parsed.data.mmPerPx }
    : { mode: 'two-point', pointsPx: parsed.data.pointsPx, distanceMm: parsed.data.distanceMm };
}

/** Applies `setCalibration` when the photo does not already carry the same calibration. Returns the new rev. */
async function applyCalibration(
  ctx: JobContext,
  wallId: string,
  photo: Photo,
  core: Record<string, JsonValue> | undefined,
): Promise<number | null> {
  if (core === undefined) return null;
  const calibration = CalibrationSchema.parse(core);
  if (sameCalibration(photo.calibration, calibration)) return null;
  const outcome = await ctx.walls.apply(wallId, {
    ops: [{ type: 'setCalibration', photoId: photo.id, calibration }],
    actor: VISION_ACTOR,
    label: 'vision: calibrate photo',
  });
  return outcome.changed ? outcome.wall.rev : null;
}

/** Stores a model file next to the wall and returns its path relative to the wall dir. */
async function storeGlb(
  deps: VisionJobDeps,
  ctx: JobContext,
  wallId: string,
  imageDir: string,
  relative: string,
): Promise<string> {
  const bytes = new Uint8Array(await readFile(join(imageDir, relative)));
  return ctx.walls.addAsset(wallId, { dir: 'models', ext: 'glb', bytes, prefix: 'm' });
}

// ---- progress mapping -----------------------------------------------------------------------------

const STAGE_END: Record<string, number> = {
  open: 0.02,
  calibrate: 0.1,
  segment: 0.45,
  recognise: 0.5,
  fit: 0.95,
  register: 0.5,
  proposal: 1,
  export: 1,
};

function progressOf(ctx: JobContext): (event: StreamEvent) => void {
  return (event) => {
    if (event.type === 'request_view') {
      ctx.progress({ message: 'another view of the objects is needed', data: asJson(event) });
    } else if (event.event === 'needs_calibration') {
      ctx.progress({ message: 'no scale found', data: asJson(event) });
    } else if (event.event === 'object' && event.done !== undefined && event.total !== undefined) {
      ctx.progress({
        done: event.done,
        total: event.total,
        fraction: 0.5 + 0.45 * (event.done / Math.max(event.total, 1)),
        message: `object ${String(event['instanceId'])} ${String(event.state)}`,
      });
    } else if (
      event.event === 'progress' &&
      event.stage === 'segment' &&
      event.fraction !== undefined
    ) {
      ctx.progress({
        fraction: 0.1 + 0.35 * event.fraction,
        message: `segment: ${event.message ?? ''}`,
      });
    } else if (event.event === 'stage' && event.state === 'done' && event.stage !== undefined) {
      ctx.progress({ fraction: STAGE_END[event.stage] ?? 0, message: `${event.stage} done` });
    } else if (event.event === 'stage' && event.state === 'start' && event.stage !== undefined) {
      ctx.progress({ message: `${event.stage}…` });
    }
  };
}

// ---- vision.photo_to_wall -----------------------------------------------------------------------

function photoToWallRequest(
  deps: VisionJobDeps,
  input: PhotoToWallInput,
  photo: LoadedPhoto,
  extraPaths: readonly string[],
  calibrate: CalibrateParams | undefined,
  bank: JsonValue | null,
): ServiceRequest {
  const request: ServiceRequest = {
    ...imageRef(deps, input.wallId, photo, input.refresh),
    photo_id: input.photoId,
    calibrate: calibrateToService(calibrate),
    segment: segmentToService(input.segment),
    board: asJson(photo.wall.board),
  };
  if (bank !== null) request['bank_index'] = bank;
  if (input.fixedDims !== undefined) request['fixed_dims'] = input.fixedDims;
  if (input.instances !== undefined) request['instances'] = input.instances;
  if (input.autoApplyConfidence !== undefined && input.autoApplyConfidence !== null)
    request['auto_apply_confidence'] = input.autoApplyConfidence;
  if (input.minConfidence !== undefined) request['min_confidence'] = input.minConfidence;
  if (input.viewFlagIou !== undefined) request['view_flag_iou'] = input.viewFlagIou;
  if (input.maxObjects !== undefined) request['max_objects'] = input.maxObjects;
  if (input.anchorMm !== undefined) request['anchor_mm'] = [...input.anchorMm];
  if (input.aiAssist !== undefined) request['ai_assist'] = input.aiAssist;
  if (input.device !== undefined) request['device'] = input.device;
  if (extraPaths.length > 0) request['extra_photos'] = [...extraPaths];
  return request;
}

interface ItemOps {
  readonly item: ProposalItem;
  readonly ops: LeafOp[];
}

/** The item's ops with the stored model file path filled into its `addModelRef`. */
function withModelFile(item: ProposalItem, file: string | undefined): ItemOps {
  const ops = item.ops.map((op): LeafOp => {
    if (op.type !== 'addModelRef' || file === undefined) return op;
    return { ...op, model: { ...op.model, file } };
  });
  return { item, ops };
}

async function runPhotoToWall(
  deps: VisionJobDeps,
  input: PhotoToWallInput,
  ctx: JobContext,
): Promise<JsonValue> {
  const photo = await loadPhoto(deps, ctx, input.wallId, input.photoId);
  const extra = await Promise.all(
    (input.extraPhotoIds ?? []).map((id) => loadPhoto(deps, ctx, input.wallId, id)),
  );
  const bank = await deps.bankIndex();
  const sha = await sha256Of(photo.path);
  const extraShas = await Promise.all(extra.map((e) => sha256Of(e.path)));
  const bankHash =
    typeof bank === 'object' && bank !== null && !Array.isArray(bank)
      ? (bank['contentHash'] ?? null)
      : null;
  const key = `p2w-${sha.slice(0, 16)}-${hashOf({ ...input, wallId: undefined, refresh: undefined, askUser: undefined, extraShas, bankHash }).slice(0, 16)}`;
  if (!input.refresh) {
    const stored = await readStored(deps, input.wallId, key);
    if (stored !== null) {
      ctx.log('vision.photo_to_wall: returning the stored result for this photo and parameters');
      ctx.progress({ fraction: 1, message: 'stored result' });
      return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
        ? { ...stored, cached: true }
        : stored;
    }
  }

  const onEvent = progressOf(ctx);
  let calibrate: CalibrateParams | undefined = input.calibrate;
  let result: PhotoToWallResult | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    ctx.progress({ fraction: 0, message: 'starting the vision service…' });
    try {
      result = await deps.client.photoToWall(
        photoToWallRequest(
          deps,
          input,
          photo,
          extra.map((e) => e.path),
          calibrate,
          bank,
        ),
        onEvent,
        ctx.signal,
      );
    } catch (error) {
      throw describeError(error);
    }
    if (result.status === 'ok' || !input.askUser) break;
    const answer = await askForScale(
      ctx,
      input.wallId,
      input.photoId,
      result.calibration.message ?? 'No scale could be established.',
    );
    if (answer === null) break;
    calibrate = answer;
  }
  if (result === undefined) throw new Error('the vision service returned no result');
  if (result.status !== 'ok' || result.proposal === null) {
    return asJson({
      status: 'needs_calibration',
      photoId: input.photoId,
      calibration: result.calibration,
      message: result.calibration.message ?? null,
      events: result.events,
    });
  }

  const calibrationRev = input.applyCalibration
    ? await applyCalibration(ctx, input.wallId, photo.photo, result.calibration.core)
    : null;

  // Store each fitted model as a wall asset and fill the model refs' `file`.
  const assets: string[] = [];
  const itemOps: ItemOps[] = [];
  for (const item of result.proposal.items) {
    const file =
      item.glb === null
        ? undefined
        : await storeGlb(deps, ctx, input.wallId, result.work.imageDir, item.glb);
    if (file !== undefined) assets.push(file);
    itemOps.push(withModelFile(item, file));
  }

  let applied: { rev: number; itemIds: string[] } | null = null;
  // Item ids follow the segmentation instance, so a re-run of the same photo (other parameters, refresh) proposes the same
  // ids: what is already on the wall is not added again (an `addItem` of an existing id would fail the whole job).
  const current = (await ctx.walls.get(input.wallId)).wall;
  const onWall = new Set([...current.items.map((i) => i.id), ...current.models.map((m) => m.id)]);
  const auto = itemOps.filter(
    ({ item, ops }) =>
      item.autoApply &&
      !onWall.has(item.id) &&
      ops.every((op) => op.type !== 'addModelRef' || !onWall.has(op.model.id)),
  );
  if (auto.length > 0) {
    const outcome = await ctx.walls.apply(input.wallId, {
      ops: auto.flatMap(({ ops }) => ops),
      actor: VISION_ACTOR,
      label: `vision: ${auto.length} object(s) from photo (confidence >= ${String(input.autoApplyConfidence)})`,
    });
    applied = { rev: outcome.wall.rev, itemIds: auto.map(({ item }) => item.id) };
  }

  const items = itemOps.map(({ item, ops }) => ({
    ...item,
    ops,
    applied: applied?.itemIds.includes(item.id) ?? false,
  }));
  const output = asJson({
    status: 'ok',
    photoId: input.photoId,
    cached: false,
    calibration: result.calibration,
    calibrationApplied: calibrationRev !== null,
    proposal: {
      ...result.proposal,
      items,
      ops: items.flatMap((item) => item.ops),
    },
    applied,
    events: result.events,
    diagnostics: result.diagnostics,
    segmentation: result.segmentation ?? null,
  });
  await writeStored(deps, input.wallId, key, { result: output, assets });
  ctx.progress({ fraction: 1, message: `${items.length} object(s) proposed` });
  return output;
}

// ---- vision.photo_to_objects --------------------------------------------------------------------

async function runPhotoToObjects(
  deps: VisionJobDeps,
  input: PhotoToObjectsInput,
  ctx: JobContext,
): Promise<JsonValue> {
  let imagePath: string;
  let workDirPath: string;
  if (input.imagePath !== undefined) {
    if (!existsSync(input.imagePath)) throw new Error(`photo ${input.imagePath} does not exist`);
    imagePath = input.imagePath;
    workDirPath = join(deps.homeDir(), 'vision', 'cache');
  } else {
    const wallId = input.wallId ?? '';
    const photo = await loadPhoto(deps, ctx, wallId, input.photoId ?? '');
    imagePath = photo.path;
    workDirPath = workDir(deps, wallId);
  }
  const request: ServiceRequest = {
    image_path: imagePath,
    work_dir: workDirPath,
    calibrate: calibrateToService(input.calibrate),
    segment: segmentToService(input.segment),
  };
  const bank = input.useBank ? await deps.bankIndex() : null;
  if (bank !== null) request['bank_index'] = bank;
  if (input.refresh) request['refresh'] = true;
  if (input.outDir !== undefined) request['out_dir'] = input.outDir;
  if (input.categories !== undefined) request['categories'] = input.categories;
  if (input.fixedDims !== undefined) request['fixed_dims'] = input.fixedDims;
  if (input.instances !== undefined) request['instances'] = input.instances;
  if (input.maxObjects !== undefined) request['max_objects'] = input.maxObjects;
  if (input.minAreaPx !== undefined) request['min_area_px'] = input.minAreaPx;
  if (input.topk !== undefined) request['topk'] = input.topk;
  if (input.cropPad !== undefined) request['crop_pad'] = input.cropPad;
  if (input.colours !== undefined) request['colours'] = input.colours;
  if (input.inlineEmbeddings !== undefined) request['inline_embeddings'] = input.inlineEmbeddings;
  if (input.extraImagePaths !== undefined) request['extra_photos'] = [...input.extraImagePaths];
  if (input.device !== undefined) request['device'] = input.device;
  ctx.progress({ fraction: 0, message: 'starting the vision service…' });
  let result: PhotoToObjectsResult;
  try {
    result = await deps.client.photoToObjects(request, progressOf(ctx), ctx.signal);
  } catch (error) {
    throw describeError(error);
  }
  ctx.progress({ fraction: 1, message: `${result.objects.length} object(s)` });
  return asJson(result);
}

// ---- stage jobs -----------------------------------------------------------------------------------

/** Calibrate with the sidecar; when no scale is found and `askUser`, ask for two points and retry. */
async function calibrateWithAsk(
  deps: VisionJobDeps,
  ctx: JobContext,
  photo: LoadedPhoto,
  input: {
    wallId: string;
    photoId: string;
    askUser: boolean;
    refresh: boolean;
    calibrate?: CalibrateParams | undefined;
    segment?: SegmentParams | undefined;
  },
) {
  let params = input.calibrate;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await deps.client
      .calibrate(
        {
          ...imageRef(deps, input.wallId, photo, input.refresh),
          calibrate: calibrateToService(params),
          segment: segmentToService(input.segment),
        },
        ctx.signal,
      )
      .catch((error: unknown) => {
        throw describeError(error);
      });
    if (result.ok || !input.askUser) return result;
    const answer = await askForScale(
      ctx,
      input.wallId,
      input.photoId,
      result.message ?? 'No scale could be established.',
    );
    if (answer === null) return result;
    params = answer;
  }
  throw new Error('calibration was not established after three attempts');
}

export function registerVisionJobs(
  deps: VisionJobDeps,
  registry: JobRegistry = defaultJobRegistry,
): void {
  registerJob(
    {
      kind: JOB_KINDS.photoToWall,
      inputSchema: PhotoToWallInputSchema,
      run: (input, ctx) => runPhotoToWall(deps, input, ctx),
    },
    registry,
  );

  registerJob(
    {
      kind: JOB_KINDS.photoToObjects,
      inputSchema: PhotoToObjectsInputSchema,
      run: (input, ctx) => runPhotoToObjects(deps, input, ctx),
    },
    registry,
  );

  registerJob(
    {
      kind: JOB_KINDS.calibrate,
      inputSchema: CalibrateInputSchema,
      async run(input, ctx) {
        const photo = await loadPhoto(deps, ctx, input.wallId, input.photoId);
        ctx.progress({ fraction: 0.1, message: 'calibrating…' });
        const result = await calibrateWithAsk(deps, ctx, photo, input);
        const rev =
          result.ok && input.applyCalibration
            ? await applyCalibration(ctx, input.wallId, photo.photo, result.core)
            : null;
        ctx.progress({
          fraction: 1,
          message: result.ok
            ? `scale ${String(result.mm_per_px)} mm/px (${String(result.method)})`
            : 'no scale',
        });
        return asJson({
          status: result.ok ? 'ok' : 'needs_calibration',
          calibration: result,
          applied: rev !== null,
          rev,
        });
      },
    },
    registry,
  );

  registerJob(
    {
      kind: JOB_KINDS.segment,
      inputSchema: SegmentInputSchema,
      async run(input, ctx) {
        const photo = await loadPhoto(deps, ctx, input.wallId, input.photoId);
        ctx.progress({ fraction: 0.05, message: 'segmenting…' });
        const result = await deps.client
          .segment(
            {
              ...imageRef(deps, input.wallId, photo, input.refresh),
              segment: segmentToService(input.segment),
            },
            ctx.signal,
          )
          .catch((error: unknown) => {
            throw describeError(error);
          });
        let overlay: string | null = null;
        if (result.overlay !== undefined && result.overlay !== null) {
          const bytes = new Uint8Array(
            await readFile(join(result.imageDir, result.dir, result.overlay)),
          );
          overlay = await ctx.walls.addAsset(input.wallId, {
            dir: 'photos/derived',
            ext: 'jpg',
            bytes,
            prefix: 'seg',
          });
        }
        ctx.progress({ fraction: 1, message: `${result.instances.length} segment(s)` });
        return asJson({
          image: result.image,
          method: result.method ?? null,
          device: result.device ?? null,
          cached: result.cached ?? false,
          overlay,
          instances: result.instances.map(
            ({ id, bbox_xywh, area_px, polygon, bg_prob, stability }) => ({
              id,
              bbox_xywh,
              area_px,
              polygon,
              bg_prob: bg_prob ?? null,
              stability: stability ?? null,
            }),
          ),
        });
      },
    },
    registry,
  );

  registerJob(
    {
      kind: JOB_KINDS.fit,
      inputSchema: FitInputSchema,
      async run(input, ctx) {
        const photo = await loadPhoto(deps, ctx, input.wallId, input.photoId);
        ctx.progress({ fraction: 0.05, message: 'fitting…' });
        const request: ServiceRequest = {
          ...imageRef(deps, input.wallId, photo, input.refresh),
          calibrate: calibrateToService(input.calibrate),
          segment: segmentToService(input.segment),
          instance: input.instance,
        };
        if (input.fixedDims !== undefined) request['fixed_dims'] = input.fixedDims;
        if (input.template !== undefined) request['template'] = input.template;
        if (input.planar !== undefined) request['planar'] = input.planar;
        if (input.maxTries !== undefined) request['max_tries'] = input.maxTries;
        if (input.device !== undefined) request['device'] = input.device;
        let result;
        try {
          result = await deps.client.fit(request, ctx.signal);
        } catch (error) {
          if (
            error instanceof VisionError &&
            error.code === 'calibration_needed' &&
            input.askUser
          ) {
            const answer = await askForScale(ctx, input.wallId, input.photoId, error.message);
            if (answer === null) throw describeError(error);
            result = await deps.client
              .fit({ ...request, calibrate: calibrateToService(answer) }, ctx.signal)
              .catch((retry: unknown) => {
                throw describeError(retry);
              });
          } else {
            throw describeError(error);
          }
        }
        const glb = result.fit.glb;
        const file =
          glb === undefined ? null : await storeGlb(deps, ctx, input.wallId, result.imageDir, glb);
        ctx.progress({ fraction: 1, message: `confidence ${result.confidence.toFixed(2)}` });
        return asJson({
          instance: result.instance,
          dimensionsMm: result.dimensionsMm,
          confidence: result.confidence,
          residual: result.residual,
          fit: result.fit,
          modelFile: file,
        });
      },
    },
    registry,
  );
}
