/**
 * Wall document schema (zod is the single source of truth: types are `z.infer`, the same schemas
 * validate API bodies and generate the JSON schema for agent tool bridges via `z.toJSONSchema`).
 *
 * Objects are strict: unknown keys are rejected so agent typos (`rotation` for `rotZ`) fail loudly.
 *
 * Input leniency: fields with `.default(...)` may be omitted by clients (CLI/agents); parsing fills
 * them in, so everything stored on disk and every `Op` seen by the reducer is fully populated.
 */
import { z } from 'zod';
import { DEFAULT_BOARD } from './grid.ts';

export const WALL_SCHEMA_VERSION = 1 as const;

/** Safe for use as a directory/file name component and in URLs. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

let idCounter = 0;
/** Short unique id, e.g. `i-k3j9x2a1`. Used as a schema default for omitted ids; never inside the reducer. */
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_679_616;
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return `${prefix}-${random.toString(36).padStart(7, '0')}${idCounter.toString(36)}`;
}

export const IdSchema = z.string().regex(ID_PATTERN, 'must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}');
const finite = z.number();
const text = (max: number) => z.string().min(1).max(max);

export const GridCellSchema = z.strictObject({
  col: z.number().int().min(0),
  row: z.number().int().min(0),
});

export const BoardSchema = z.strictObject({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  colPitchMm: z.number().positive(),
  rowPitchMm: z.number().positive(),
});

/**
 * Item pose in wall coordinates: x right, y up (mm, in the wall plane), z out of the wall (mm),
 * rotations in degrees (`rotZ` is about the wall normal, the only one a snapped holder uses).
 * When the item has a `cell`, x/y are derived from it by the reducer and any given values are overwritten.
 */
export const PoseSchema = z.strictObject({
  x: finite.default(0),
  y: finite.default(0),
  z: finite.default(0),
  rotX: finite.default(0),
  rotY: finite.default(0),
  rotZ: finite.default(0),
});

export const ITEM_KINDS = ['holder', 'tool', 'board-part', 'photo-ref'] as const;
export const ItemKindSchema = z.enum(ITEM_KINDS);

export const SOURCE_TYPES = ['manual', 'agent', 'vision'] as const;
export const ItemSourceSchema = z.strictObject({
  type: z.enum(SOURCE_TYPES).default('manual'),
  /** Detector/fit confidence in [0, 1]; absent for manual items. */
  confidence: z.number().min(0).max(1).optional(),
  /** Photo the item was detected in. */
  photoId: IdSchema.optional(),
  /** Free-form producer, e.g. an agent or model name. */
  by: text(80).optional(),
});

/** Named dimension overrides in mm (e.g. `{ length: 160, shaftDiameter: 6.5 }`); the bank defines the keys. */
export const ParamsSchema = z.record(text(64), finite);

export const WallItemSchema = z
  .object({
    id: IdSchema.default(() => newId('i')),
    kind: ItemKindSchema,
    /** Bank element; required for holder/board-part, and for tools unless `modelRefId` is set. */
    bankId: text(120).optional(),
    variantId: text(120).optional(),
    /** Bank tool-class id (e.g. `screwdriver`): what the tool is; drives holder suggestions. */
    toolClass: text(60).optional(),
    /** Reference model (candidate/chosen) the item is rendered with when it has no bank element. */
    modelRefId: IdSchema.optional(),
    /** Photo displayed by a `photo-ref` item. */
    photoId: IdSchema.optional(),
    /** Holder a tool sits in. */
    parentId: IdSchema.optional(),
    /** Which of the holder's mount slots (0-based, holder-local numbering from `@hsw-editor/compat`) the tool occupies. */
    slot: z.number().int().min(0).optional(),
    label: text(200).optional(),
    cell: GridCellSchema.optional(),
    pose: PoseSchema.default(() => PoseSchema.parse({})),
    params: ParamsSchema.default({}),
    source: ItemSourceSchema.default(() => ItemSourceSchema.parse({})),
    locked: z.boolean().default(false),
  })
  .superRefine((item, ctx) => {
    if (item.kind === 'photo-ref') {
      if (item.photoId === undefined) {
        ctx.addIssue({ code: 'custom', path: ['photoId'], message: 'photo-ref requires photoId' });
      }
    } else if (item.bankId === undefined && item.modelRefId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['bankId'],
        message: `${item.kind} requires bankId or modelRefId`,
      });
    }
  });

export const CALIBRATION_METHODS = ['grid', 'two-point', 'manual', 'vision'] as const;
const Mat3Schema = z.tuple([
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
  finite,
]);

/** Most photo<->wall correspondences a stored calibration keeps. */
export const MAX_CALIBRATION_POINTS = 1000;

/** How a photo maps onto the wall plane. At least `mmPerPx` or `homography` should be present to be useful. */
export const CalibrationSchema = z.strictObject({
  method: z.enum(CALIBRATION_METHODS),
  /** Uniform scale for a fronto-parallel photo. */
  mmPerPx: z.number().positive().optional(),
  /** Row-major 3x3 homography from photo pixels to wall mm. */
  homography: Mat3Schema.optional(),
  focalPx: z.number().positive().optional(),
  reprojErrorPx: z.number().min(0).optional(),
  /** Correspondences used for the fit: photo pixel -> wall mm. */
  points: z
    .array(z.strictObject({ px: z.tuple([finite, finite]), wall: z.tuple([finite, finite]) }))
    .max(MAX_CALIBRATION_POINTS)
    .optional(),
});

export const PHOTO_ORIGINS = ['upload', 'generated'] as const;
export const PhotoSchema = z.strictObject({
  id: IdSchema.default(() => newId('p')),
  /** Path relative to the wall directory, e.g. `photos/p-abc.jpg` or `photos/derived/p-abc.png`. */
  file: text(200),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  name: text(200).optional(),
  origin: z.enum(PHOTO_ORIGINS).default('upload'),
  /** For generated images: the view that was drawn (e.g. `side`, `top`). */
  view: text(40).optional(),
  /** Backend that produced a generated image. */
  backend: text(80).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Item (object) the photo documents, for per-object extra views. */
  forItemId: IdSchema.optional(),
  /**
   * Set on a cleaned variant (`view: 'clean'`): the photo this one was made from. The original is never changed; the
   * variant shares its calibration, so it has none of its own.
   */
  cleanOf: IdSchema.optional(),
  /** Footprint (photo pixels) the cleaned variant was made for, as `footprintSignature` of `@hsw-editor/overlay`. */
  cleanFootprint: text(120).optional(),
  calibration: CalibrationSchema.optional(),
});

export const MODEL_STATUSES = ['candidate', 'chosen', 'rejected'] as const;
export const MODEL_SOURCE_TYPES = ['bank', 'library', 'generated', 'upload', 'web'] as const;
export const ModelRefSchema = z.strictObject({
  id: IdSchema.default(() => newId('m')),
  label: text(200),
  status: z.enum(MODEL_STATUSES).default('candidate'),
  source: z.strictObject({
    type: z.enum(MODEL_SOURCE_TYPES),
    url: z.string().max(2000).optional(),
    by: text(80).optional(),
  }),
  bankId: text(120).optional(),
  /** Path relative to the wall dir (`models/<id>.glb`) when the file is stored with the wall. */
  file: text(200).optional(),
  /** Item this model is a candidate for. */
  forItemId: IdSchema.optional(),
  /** Bank tool-class id of the object this model depicts. */
  toolClass: text(60).optional(),
  /** Match quality in [0, 1] from retrieval/fit. */
  score: z.number().min(0).max(1).optional(),
  dimensionsMm: z
    .object({ x: z.number().positive(), y: z.number().positive(), z: z.number().positive() })
    .optional(),
  notes: z.string().max(2000).optional(),
});

export const WallSchema = z.strictObject({
  schemaVersion: z.literal(WALL_SCHEMA_VERSION),
  id: IdSchema,
  name: text(200),
  /** Monotonic revision; +1 per applied (state-changing) op, undo and redo included. */
  rev: z.number().int().min(0),
  board: BoardSchema,
  items: z.array(WallItemSchema).max(20000),
  photos: z.array(PhotoSchema).max(1000),
  models: z.array(ModelRefSchema).max(5000),
});

// ---- Ops -------------------------------------------------------------------------------------------

const TargetItem = { id: IdSchema } as const;

export const ModelRefPatchSchema = z.strictObject({
  label: text(200).optional(),
  status: z.enum(MODEL_STATUSES).optional(),
  /** `null` clears the field. */
  forItemId: IdSchema.nullable().optional(),
  score: z.number().min(0).max(1).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  bankId: text(120).nullable().optional(),
});

const LeafOpSchemas = [
  z.strictObject({
    type: z.literal('addItem'),
    item: WallItemSchema,
    /** Insert position in `items`; default append. */
    index: z.number().int().min(0).optional(),
  }),
  z.strictObject({
    type: z.literal('moveItem'),
    ...TargetItem,
    /** Snap to a cell (x/y derived) or place freely in the wall plane. `z` is the distance from the wall. */
    to: z.union([
      z.strictObject({ cell: GridCellSchema, z: finite.optional() }),
      z.strictObject({ x: finite, y: finite, z: finite.optional() }),
    ]),
  }),
  z.strictObject({
    type: z.literal('rotateItem'),
    ...TargetItem,
    rotX: finite.optional(),
    rotY: finite.optional(),
    rotZ: finite.optional(),
  }),
  z.strictObject({
    type: z.literal('setParams'),
    ...TargetItem,
    set: ParamsSchema.optional(),
    unset: z.array(text(64)).optional(),
  }),
  z.strictObject({ type: z.literal('removeItem'), ...TargetItem }),
  z.strictObject({
    type: z.literal('setVariant'),
    ...TargetItem,
    /** `null` clears the variant. */
    variantId: text(120).nullable(),
    /** Optionally switch to a different bank element at the same time; `null` clears it (needs a modelRefId). */
    bankId: text(120).nullable().optional(),
  }),
  z.strictObject({ type: z.literal('lock'), ...TargetItem, locked: z.boolean() }),
  z.strictObject({
    type: z.literal('attachItem'),
    ...TargetItem,
    /** Holder the tool hangs on; `null` detaches it; a `slot` sent along with `null` is kept (restores a stored slot-without-parent item). */
    parentId: IdSchema.nullable(),
    /** Mount slot on that holder; `null` or omitted leaves the tool unslotted. */
    slot: z.number().int().min(0).nullable().optional(),
  }),
  z.strictObject({
    type: z.literal('addPhoto'),
    photo: PhotoSchema,
    /** Insert position in `photos`; default append. */
    index: z.number().int().min(0).optional(),
  }),
  z.strictObject({ type: z.literal('removePhoto'), id: IdSchema }),
  z.strictObject({
    type: z.literal('setCalibration'),
    photoId: IdSchema,
    /** `null` removes the calibration. */
    calibration: CalibrationSchema.nullable(),
  }),
  z.strictObject({ type: z.literal('setBoard'), board: BoardSchema }),
  z.strictObject({
    type: z.literal('rename'),
    /** `null` clears an item label (not allowed for the wall name). */
    name: text(200).nullable(),
    /** Relabel an item instead of renaming the wall. */
    itemId: IdSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('addModelRef'),
    model: ModelRefSchema,
    /** Insert position in `models`; default append. */
    index: z.number().int().min(0).optional(),
  }),
  z.strictObject({ type: z.literal('updateModelRef'), id: IdSchema, patch: ModelRefPatchSchema }),
  z.strictObject({ type: z.literal('removeModelRef'), id: IdSchema }),
] as const;

/** Everything except `batch`; batches are flat so inverse/undo stay one reversible unit. */
export const LeafOpSchema = z.discriminatedUnion('type', LeafOpSchemas);

export const BatchOpSchema = z.strictObject({
  type: z.literal('batch'),
  ops: z.array(LeafOpSchema).min(1).max(5000),
  label: text(200).optional(),
});

export const OpSchema = z.discriminatedUnion('type', [...LeafOpSchemas, BatchOpSchema]);

export const ACTOR_KINDS = ['human', 'agent', 'cli'] as const;
export const ActorSchema = z.strictObject({
  kind: z.enum(ACTOR_KINDS),
  /** Agent/user name, e.g. `omp`, `vision`, `alex`. */
  name: text(80).optional(),
});

export type Id = z.infer<typeof IdSchema>;
export type Pose = z.infer<typeof PoseSchema>;
export type ItemKind = z.infer<typeof ItemKindSchema>;
export type ItemSource = z.infer<typeof ItemSourceSchema>;
export type WallItem = z.infer<typeof WallItemSchema>;
export type Calibration = z.infer<typeof CalibrationSchema>;
export type Photo = z.infer<typeof PhotoSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ModelRefPatch = z.infer<typeof ModelRefPatchSchema>;
export type Wall = z.infer<typeof WallSchema>;
export type LeafOp = z.infer<typeof LeafOpSchema>;
export type BatchOp = z.infer<typeof BatchOpSchema>;
export type Op = z.infer<typeof OpSchema>;
export type Actor = z.infer<typeof ActorSchema>;

export function createEmptyWall(id: string, name: string, board = DEFAULT_BOARD): Wall {
  return {
    schemaVersion: WALL_SCHEMA_VERSION,
    id,
    name,
    rev: 0,
    board: { ...board },
    items: [],
    photos: [],
    models: [],
  };
}
