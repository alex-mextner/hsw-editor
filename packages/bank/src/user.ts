/**
 * Contract of user-made bank elements (`<home>/bank-user`, routes `/api/bank/user/*`, job `bank.user.import`).
 * Browser-safe: the server, the CLI's JSON bodies and the web "Add element" dialog all validate against these
 * zod schemas. Behaviour is documented in docs/bank.md ("User elements") and docs/api.md.
 */
import { z } from 'zod';
import {
  BboxMmSchema,
  CellOffsetSchema,
  FitsToolSchema,
  LocalizedTextSchema,
  MountingSchema,
  PrintNotesSchema,
  Vec3Schema,
  categoryPath,
  slugSchema,
} from './schema.ts';

/** Every user element id starts with this, so it can never collide with an id of the built bank. */
export const USER_ELEMENT_ID_PREFIX = 'my-';

export const USER_ELEMENT_ID_PATTERN = /^my-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const userElementIdSchema = z
  .string()
  .max(64)
  .regex(USER_ELEMENT_ID_PATTERN, 'expected my-<lowercase-kebab-case>');

/** Opaque ids of uploads (`up-xxxxxxxx`) and preview files. */
export const uploadIdSchema = z.string().regex(/^up-[a-z0-9]{8,32}$/);

export const MESH_FORMATS = ['stl', 'glb', '3mf'] as const;
export type MeshFormat = (typeof MESH_FORMATS)[number];

/** Largest accepted mesh file. */
export const MAX_USER_MESH_BYTES = 100 * 1024 * 1024;

export const SIGNED_AXES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const;
export const SignedAxisSchema = z.enum(SIGNED_AXES);
export type SignedAxis = z.infer<typeof SignedAxisSchema>;

/**
 * Which SOURCE axis points away from the wall (`out`) and which points up on the wall (`up`). STL and 3MF are
 * Z-up; a glTF (GLB) is Y-up. The result is the bank's wall frame (x right, y up, z out, mm), see docs/bank.md.
 */
export const OrientationSchema = z
  .object({ out: SignedAxisSchema, up: SignedAxisSchema })
  .refine((o) => o.out[1] !== o.up[1], 'out and up must be perpendicular axes');
export type Orientation = z.infer<typeof OrientationSchema>;

export const ANCHOR_MODES = ['back-bbox', 'origin', 'panel'] as const;
export const MESH_UNITS = ['auto', 'mm', 'cm', 'm', 'in'] as const;

/** How a source mesh becomes the normalised element. Every field is optional; the server fills the defaults. */
export const ConvertSettingsSchema = z.object({
  /** Part (3MF object / glTF mesh) to import; `*` merges all parts. Default: the biggest part. */
  partId: z.string().min(1).max(200).optional(),
  /** Default: guessed from a hex plug end / the largest flat face (`Upload.parts[].guess`). */
  orient: OrientationSchema.optional(),
  /** `back-bbox` (default): lattice phase found from the wall-facing silhouette; `origin`: keep the source origin; `panel`: centre of the box. */
  anchor: z.enum(ANCHOR_MODES).optional(),
  /** Unit of the source numbers. `auto`: mm, except a glTF smaller than 2 units across is taken as metres. */
  unit: z.enum(MESH_UNITS).optional(),
  /** Try to close holes / fix winding when the mesh is not watertight (default true). */
  repair: z.boolean().optional(),
});
export type ConvertSettings = z.infer<typeof ConvertSettingsSchema>;

export const UserNameSchema = z
  .object({ ru: z.string().max(120).optional(), en: z.string().max(120).optional() })
  .refine((n) => (n.ru ?? '').trim() !== '' || (n.en ?? '').trim() !== '', 'give a ru or en name');
export type UserName = z.infer<typeof UserNameSchema>;

const tagsSchema = z.object({
  ru: z.array(z.string().min(1).max(60)).max(40),
  en: z.array(z.string().min(1).max(60)).max(40),
});

/** Editable metadata shared by creation and `PATCH`; geometry is only changed by re-importing. */
const cellsSchema = z.array(CellOffsetSchema).min(1).max(400);
export const UserMetaFieldsSchema = z.object({
  name: UserNameSchema,
  description: LocalizedTextSchema.optional(),
  category: categoryPath,
  tags: tagsSchema,
  toolClasses: z.array(slugSchema).max(20),
  fitsTool: z.array(FitsToolSchema).max(20),
  /** Honeycomb cells under the element (offsets from the anchor, which must be included). Default: detected. */
  footprint: cellsSchema,
  /** Mounting interface: kind plus the cells that carry pegs / screws (subset of the footprint). Default: detected. */
  mounting: MountingSchema,
  printNotes: PrintNotesSchema.optional(),
});

/** Body of the `bank.user.import` job. `uploadId` (new file) and/or `replaceId` (edit; stored original when no `uploadId`). */
export const UserImportInputSchema = z
  .object({
    uploadId: uploadIdSchema.optional(),
    replaceId: userElementIdSchema.optional(),
    /** Wanted id; default `my-<slug of the name>` (a numeric suffix resolves a clash). */
    id: userElementIdSchema.optional(),
    settings: ConvertSettingsSchema.optional(),
    name: UserNameSchema,
    description: LocalizedTextSchema.optional(),
    category: categoryPath,
    tags: tagsSchema.optional(),
    toolClasses: z.array(slugSchema).max(20).optional(),
    fitsTool: z.array(FitsToolSchema).max(20).optional(),
    footprint: cellsSchema.optional(),
    mounting: MountingSchema.optional(),
    printNotes: PrintNotesSchema.optional(),
  })
  .refine((i) => i.uploadId !== undefined || i.replaceId !== undefined, {
    message: 'uploadId or replaceId is required',
  });
export type UserImportInput = z.infer<typeof UserImportInputSchema>;

/** Body of `PATCH /api/bank/user/elements/:id`: any subset of the metadata (no geometry change). */
export const UserPatchSchema = UserMetaFieldsSchema.partial().strict();
export type UserPatch = z.infer<typeof UserPatchSchema>;

export const MeshPartSchema = z.object({
  partId: z.string(),
  triangles: z.number().int(),
  bboxMm: BboxMmSchema,
  dimsMm: Vec3Schema,
  watertight: z.boolean(),
  /** Orientation the pipeline would pick (hex plug end, else the largest flat face on the bounding box). */
  guess: OrientationSchema,
});
export type MeshPart = z.infer<typeof MeshPartSchema>;

/** `POST /api/bank/user/uploads` -> `201 { upload }`. */
export const UploadSchema = z.object({
  id: uploadIdSchema,
  filename: z.string(),
  format: z.enum(MESH_FORMATS),
  bytes: z.number().int(),
  sha256: z.string(),
  parts: z.array(MeshPartSchema),
  /** Part picked by default (the biggest). */
  defaultPartId: z.string(),
  /** Name proposed from the file name. */
  suggestedName: z.string(),
  createdAt: z.string(),
});
export type Upload = z.infer<typeof UploadSchema>;

/** `ConvertSettings` with every default applied: what a conversion really used. */
export const ResolvedSettingsSchema = z.object({
  partId: z.string(),
  orient: OrientationSchema,
  anchor: z.enum(ANCHOR_MODES),
  unit: z.enum(MESH_UNITS),
  repair: z.boolean(),
});
export type ResolvedSettings = z.infer<typeof ResolvedSettingsSchema>;

/** Result of one conversion with the given settings (`POST .../uploads/:id/preview`); also what an import stores. */
export const ConversionSchema = z.object({
  /** The normalised GLB in the wall frame (uncompressed), loadable with GLTFLoader. */
  glbUrl: z.string(),
  bboxMm: BboxMmSchema,
  dimsMm: Vec3Schema,
  triangles: z.number().int(),
  /** Detected honeycomb cells under the silhouette (offsets from the anchor cell, which is {0,0}). */
  footprint: z.array(CellOffsetSchema),
  /** Detected mounting cells (screw holes of the silhouette, else all footprint cells). */
  mountingCells: z.array(CellOffsetSchema),
  watertight: z.boolean(),
  /** The mesh was not watertight and the repair step fixed it. */
  repaired: z.boolean(),
  /** The settings after defaults (what was really used). */
  settings: ResolvedSettingsSchema,
  warnings: z.array(z.string()),
});
export type Conversion = z.infer<typeof ConversionSchema>;

/** Sidecar of one user element (`<home>/bank-user/meta/<id>.json`), returned by `GET /api/bank/user/elements/:id`. */
export const UserElementMetaSchema = z.object({
  originalName: z.string(),
  format: z.enum(MESH_FORMATS),
  sourceSha256: z.string(),
  sourceBytes: z.number().int(),
  settings: ResolvedSettingsSchema,
  watertight: z.boolean(),
  repaired: z.boolean(),
  warnings: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserElementMeta = z.infer<typeof UserElementMetaSchema>;

export const USER_IMPORT_JOB = 'bank.user.import';

export const userRoutes = {
  elements: '/api/bank/user/elements',
  element: (id: string): string => `/api/bank/user/elements/${encodeURIComponent(id)}`,
  reopen: (id: string): string => `/api/bank/user/elements/${encodeURIComponent(id)}/reopen`,
  uploads: '/api/bank/user/uploads',
  upload: (id: string): string => `/api/bank/user/uploads/${encodeURIComponent(id)}`,
  preview: (id: string): string => `/api/bank/user/uploads/${encodeURIComponent(id)}/preview`,
} as const;
