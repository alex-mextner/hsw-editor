/**
 * Wire types of the vision sidecar (`services/vision`, docs/vision.md). Requests are camelCase in the job inputs and
 * converted to the service's snake_case here; results are validated with zod, and every proposed op is parsed with
 * the `packages/core` op schema so a malformed proposal can never reach the wall store.
 */
import { IdSchema, LeafOpSchema, type JsonValue } from '@hsw-editor/core';
import { z } from 'zod';

const Point = z.tuple([z.number(), z.number()]);

export const CalibrateParamsSchema = z.strictObject({
  mode: z.enum(['auto', 'grid', 'two-point', 'reference', 'manual']).optional(),
  /** Two picked photo pixels ... */
  pointsPx: z.tuple([Point, Point]).optional(),
  /** ... and their real distance in mm. */
  distanceMm: z.number().positive().optional(),
  referenceInstance: z.number().int().optional(),
  referenceLengthMm: z.number().positive().optional(),
  mmPerPx: z.number().positive().optional(),
  fPx: z.number().positive().optional(),
  fRatio: z.number().positive().optional(),
});
export type CalibrateParams = z.infer<typeof CalibrateParamsSchema>;

export const SegmentQualitySchema = z.enum(['fast', 'accurate']);
export type SegmentQuality = z.infer<typeof SegmentQualitySchema>;
/** What the sidecar uses when a request names no quality (`DEFAULT_QUALITY` in `services/vision/hsw_vision/schemas.py`). */
export const DEFAULT_SEGMENT_QUALITY: SegmentQuality = 'fast';

export const SegmentParamsSchema = z.strictObject({
  method: z.enum(['sam2', 'sam2-dense', 'u2net']).optional(),
  /** `fast` (the sidecar default) or `accurate` (the stock SAM2 generator; docs/vision.md has the timings). Absent: the user's `vision.segmentQuality` setting, else the sidecar's default. */
  quality: SegmentQualitySchema.optional(),
  fill: z.enum(['owlv2', 'none']).optional(),
  rejectBg: z.boolean().optional(),
  pointsPerSide: z.number().int().min(8).max(128).optional(),
});
export type SegmentParams = z.infer<typeof SegmentParamsSchema>;

/** Dimension overrides in mm (`length`, `width`, `thickness`): hard constraints of the fit. */
export const FixedDimsSchema = z.record(z.string(), z.number().positive());

export function calibrateToService(params: CalibrateParams | undefined): Record<string, JsonValue> {
  if (params === undefined) return {};
  const out: Record<string, JsonValue> = {};
  if (params.mode !== undefined) out['mode'] = params.mode;
  if (params.pointsPx !== undefined) out['points_px'] = params.pointsPx.map((p) => [...p]);
  if (params.distanceMm !== undefined) out['distance_mm'] = params.distanceMm;
  if (params.referenceInstance !== undefined) out['reference_instance'] = params.referenceInstance;
  if (params.referenceLengthMm !== undefined) out['reference_length_mm'] = params.referenceLengthMm;
  if (params.mmPerPx !== undefined) out['mm_per_px'] = params.mmPerPx;
  if (params.fPx !== undefined) out['f_px'] = params.fPx;
  if (params.fRatio !== undefined) out['f_ratio'] = params.fRatio;
  return out;
}

export function segmentToService(params: SegmentParams | undefined): Record<string, JsonValue> {
  if (params === undefined) return {};
  const out: Record<string, JsonValue> = {};
  if (params.method !== undefined) out['method'] = params.method;
  if (params.quality !== undefined) out['quality'] = params.quality;
  if (params.fill !== undefined) out['fill'] = params.fill;
  if (params.rejectBg !== undefined) out['reject_bg'] = params.rejectBg;
  if (params.pointsPerSide !== undefined) out['points_per_side'] = params.pointsPerSide;
  return out;
}

// ---- results ----------------------------------------------------------------------------------------

export const CalibrationResultSchema = z.looseObject({
  ok: z.boolean(),
  method: z.string().nullable().optional(),
  mm_per_px: z.number().optional(),
  needs: z.string().optional(),
  message: z.string().optional(),
  /** The `Calibration` object of `packages/core` (`setCalibration` payload). */
  core: z.record(z.string(), z.json()).optional(),
  cached: z.boolean().optional(),
});
export type CalibrationResult = z.infer<typeof CalibrationResultSchema>;

export const ProposalItemSchema = z.looseObject({
  id: IdSchema,
  modelId: IdSchema,
  instanceId: z.number(),
  label: z.string(),
  toolClass: z.string().nullable(),
  confidence: z.number(),
  status: z.enum(['ok', 'needs_confirmation']),
  autoApply: z.boolean(),
  needsView: z.boolean(),
  /** GLB path relative to the service's `work.imageDir`. */
  glb: z.string().nullable(),
  ops: z.array(LeafOpSchema),
});
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const HolderProposalSchema = z.looseObject({
  id: IdSchema,
  bankId: z.string(),
  forItems: z.array(IdSchema),
  confidence: z.number(),
  ops: z.array(LeafOpSchema),
});

export const ProposalSchema = z.looseObject({
  version: z.number(),
  photoId: z.string().nullable(),
  autoApplyConfidence: z.number().nullable(),
  items: z.array(ProposalItemSchema),
  holders: z.array(HolderProposalSchema),
  summary: z.record(z.string(), z.number()),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const RequestViewEventSchema = z.looseObject({
  type: z.literal('request_view'),
  reason: z.string(),
  items: z.array(z.looseObject({ itemId: z.string(), confidence: z.number() })),
});

export const PhotoToWallResultSchema = z.looseObject({
  status: z.enum(['ok', 'needs_calibration']),
  image: z.looseObject({ sha256: z.string(), w: z.number(), h: z.number() }),
  calibration: CalibrationResultSchema,
  work: z.looseObject({ imageDir: z.string() }),
  proposal: ProposalSchema.nullable(),
  events: z.array(z.record(z.string(), z.json())),
  diagnostics: z.record(z.string(), z.json()),
  segmentation: z.record(z.string(), z.json()).optional(),
});
export type PhotoToWallResult = z.infer<typeof PhotoToWallResultSchema>;

/** One object of `photo_to_objects` (docs/vision.md "photo_to_objects"). Paths are relative to the result's `outDir`. */
export const ObjectRecordSchema = z.looseObject({
  id: z.number().int(),
  bboxXywh: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  areaPx: z.number(),
  mask: z.string(),
  crop: z.looseObject({ path: z.string(), boxXywh: z.array(z.number()).length(4) }),
  cutout: z.string(),
  cropOriented: z.string(),
  cutoutOriented: z.string(),
  axis: z.looseObject({ deg: z.number(), unit: z.array(z.number()).length(2) }),
  profile: z.looseObject({ length_mm: z.number(), stations: z.array(z.unknown()) }).nullable(),
  mmPerPx: z.number().nullable(),
  class: z.looseObject({
    toolClass: z.string().nullable(),
    prob: z.number().nullable().optional(),
    topk: z.array(
      z.looseObject({ toolClass: z.string().nullable(), score: z.number().nullable().optional() }),
    ),
  }),
  fit: z.looseObject({ glb: z.string() }).nullable(),
  dimensionsMm: z.record(z.string(), z.number().nullable()).nullable(),
  colours: z.looseObject({ parts: z.array(z.unknown()) }).nullable(),
  embedding: z
    .looseObject({ file: z.string(), row: z.number().int(), dim: z.number().int() })
    .nullable(),
  confidence: z.number(),
  needsView: z.boolean(),
  /** Suggested missing viewpoints; the library adds `direction_object` (a vector) and `reason` (text) to the angles. */
  needsViews: z.array(
    z.looseObject({ azimuth_deg: z.number().optional(), elevation_deg: z.number().optional() }),
  ),
  /** The compact multi-view record (docs/vision.md "Multi-view check"); null without a fit. */
  multiView: z.looseObject({ status: z.string() }).nullable().optional(),
  status: z.enum(['ok', 'needs_confirmation', 'no_scale', 'fit_failed']),
  error: z.string().nullable(),
});
export type ObjectRecord = z.infer<typeof ObjectRecordSchema>;

export const PhotoToObjectsResultSchema = z.looseObject({
  version: z.number(),
  status: z.enum(['ok', 'no_scale']),
  image: z.looseObject({ sha256: z.string(), w: z.number(), h: z.number() }),
  /** Absolute result directory: `objects.json`, `masks/`, `crops/`, `models/`, `embeddings.npy`, overlays. */
  outDir: z.string(),
  calibration: CalibrationResultSchema,
  summary: z.record(z.string(), z.number()),
  objects: z.array(ObjectRecordSchema),
  diagnostics: z.record(z.string(), z.json()),
});
export type PhotoToObjectsResult = z.infer<typeof PhotoToObjectsResultSchema>;

/** One NDJSON line of `POST /photo-to-wall` and `POST /photo-to-objects`. Stage events carry `event`, `request_view` carries `type`. */
export const StreamEventSchema = z.looseObject({
  event: z.string().optional(),
  type: z.string().optional(),
  stage: z.string().optional(),
  state: z.string().optional(),
  message: z.string().optional(),
  fraction: z.number().optional(),
  done: z.number().optional(),
  total: z.number().optional(),
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const SegmentResultSchema = z.looseObject({
  image: z.looseObject({ w: z.number(), h: z.number(), sha256: z.string() }),
  imageDir: z.string(),
  dir: z.string(),
  method: z.string().nullable().optional(),
  device: z.string().nullable().optional(),
  overlay: z.string().nullable().optional(),
  instances: z.array(
    z.looseObject({
      id: z.number(),
      bbox_xywh: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      area_px: z.number(),
      polygon: z.array(z.tuple([z.number(), z.number()])),
      mask: z.string(),
    }),
  ),
  cached: z.boolean().optional(),
});
export type SegmentResult = z.infer<typeof SegmentResultSchema>;

export const FitResultSchema = z.looseObject({
  instance: z.number(),
  fit: z.looseObject({ glb: z.string().optional() }),
  dimensionsMm: z.record(z.string(), z.number()),
  confidence: z.number(),
  residual: z.number().nullable(),
  imageDir: z.string(),
});
export type FitResult = z.infer<typeof FitResultSchema>;

export const ServiceErrorBodySchema = z.object({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    fix: z.string().optional(),
    details: z.json().optional(),
  }),
});

/** A structured failure of the sidecar (or of reaching it). `fix` is a one-line remedy for the user. */
export class VisionError extends Error {
  readonly code: string;
  readonly fix: string | undefined;
  readonly status: number | undefined;
  readonly details: JsonValue | undefined;
  constructor(
    code: string,
    message: string,
    options: { fix?: string; status?: number; details?: JsonValue } = {},
  ) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.fix = options.fix;
    this.status = options.status;
    this.details = options.details;
  }

  /** `message (fix: ...)`, what job failures show. */
  describe(): string {
    return this.fix === undefined ? this.message : `${this.message} (fix: ${this.fix})`;
  }
}

/** Request bodies of the sidecar (snake_case, as `hsw_vision.schemas`). */
export interface ServiceImageRef {
  image_path: string;
  work_dir: string;
  refresh?: boolean;
}
