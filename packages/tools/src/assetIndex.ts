/**
 * Index of the tool model asset store (`/api/tools/assets/index`): one entry per built-in class (its default
 * build) and per user tool, each with its LOD0/LOD1 GLB under a content-hash name (`glb/<16 hex>.glb`, served at
 * `/tools/assets/glb/...` with an immutable cache header like the bank's), the box and the holding summary
 * the editor needs without opening the GLB. Browser-safe (zod only), shared by the server, the web client and the demo build.
 */
import { z } from 'zod';

export const TOOL_ASSET_PATH = /^glb\/[0-9a-f]{16}\.glb$/;
/** URL prefix the server (and the demo build) serve asset paths under. */
export const TOOL_ASSET_URL_PREFIX = '/tools/assets/';
export const TOOL_ASSET_INDEX_URL = '/api/tools/assets/index';

const finite = z.number().finite();
const Dims = z.strictObject({ x: finite, y: finite, z: finite });
const Vec3 = z.tuple([finite, finite, finite]);

export const ToolAssetFileSchema = z.strictObject({
  path: z.string().regex(TOOL_ASSET_PATH),
  size: z.number().int().positive(),
  triangles: z.number().int().nonnegative(),
});
export type ToolAssetFile = z.infer<typeof ToolAssetFileSchema>;

export const HoldingSummarySchema = z.strictObject({
  lengthMm: finite,
  hang: z
    .strictObject({
      point: Vec3,
      kind: z.enum(['hole', 'loop', 'butt', 'head', 'body', 'neck']),
      diameterMm: finite.optional(),
    })
    .nullable(),
  maxSection: z.strictObject({ w: finite, t: finite, r: finite }),
  dims: z.record(z.string(), finite),
});

export const ToolAssetEntrySchema = z.strictObject({
  /** `class:<generator class id>` or `tool:<user tool id>`. */
  id: z.string().min(1),
  kind: z.enum(['class', 'tool']),
  classId: z.string().nullable(),
  bankClass: z.string().nullable(),
  /** Resolved class values of the build (the base a regenerated model starts from); null for a generic loft. */
  values: z.record(z.string(), z.union([z.number(), z.string()])).nullable(),
  /** Hash of class + values (`paramHash`) for a class build, else of the GLB bytes. */
  paramHash: z.string().regex(/^[0-9a-f]{16}$/),
  /** Bounding box in the tool frame: x width, y length, z thickness. */
  dimsMm: Dims,
  /** Centre of that box in the tool frame. */
  centreMm: Dims,
  holding: HoldingSummarySchema,
  lod0: ToolAssetFileSchema,
  lod1: ToolAssetFileSchema,
});
export type ToolAssetEntry = z.infer<typeof ToolAssetEntrySchema>;

export const ToolAssetIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Hash of the entries: the value of the `X-Tools-Index-Hash` header, the identity of this index. */
  contentHash: z.string().regex(/^[0-9a-f]{16}$/),
  entries: z.array(ToolAssetEntrySchema),
  /** User tools left out because their files are missing or damaged. */
  unavailable: z.array(z.strictObject({ id: z.string(), reason: z.string() })),
});
export type ToolAssetIndex = z.infer<typeof ToolAssetIndexSchema>;

export function classAssetId(classId: string): string {
  return `class:${classId}`;
}

export function toolAssetId(toolId: string): string {
  return `tool:${toolId}`;
}

/** URL of an asset file of the store, relative to the origin. */
export function toolAssetUrl(file: Pick<ToolAssetFile, 'path'>): string {
  return `${TOOL_ASSET_URL_PREFIX}${file.path}`;
}
