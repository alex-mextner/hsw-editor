/**
 * Mesh import for user elements: format sniffing, probing an upload, converting a part to the wall frame
 * (scripts/bank/user/user_mesh.py) and the optional external repair step of the `3d` CLI.
 */
import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import type { BankElement } from '../../schema.ts';
import {
  MESH_FORMATS,
  type ConvertSettings,
  type ResolvedSettings,
  type MeshFormat,
  type Orientation,
  SignedAxisSchema,
} from '../../user.ts';
import { runPythonScript } from '../exec.ts';
import type { BankPaths } from '../paths.ts';

const USER_MESH_SCRIPT = 'scripts/bank/user/user_mesh.py';
/** meshfix on a big mesh takes a while; a hung tool must not hold an import job forever. */
const EXTERNAL_REPAIR_TIMEOUT_MS = 120_000;

/** Raised for input the user can fix (bad file, unknown part); maps to 4xx, anything else is a 5xx. */
export class UserElementError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'UserElementError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const Vec3Tuple = z.tuple([z.number(), z.number(), z.number()]);
const BboxTuple = z.object({ min: Vec3Tuple, max: Vec3Tuple });
const CellPairs = z.array(z.tuple([z.number().int(), z.number().int()]));
const GuessSchema = z.object({ out: SignedAxisSchema, up: SignedAxisSchema });

const ProbeResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    sha256: z.string(),
    defaultPartId: z.string(),
    parts: z.array(
      z.object({
        partId: z.string(),
        triangles: z.number().int(),
        bboxMm: BboxTuple,
        watertight: z.boolean(),
        guess: GuessSchema,
      }),
    ),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const ConvertResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    bboxMm: BboxTuple,
    triangles: z.number().int(),
    cells: CellPairs,
    mountingCells: CellPairs,
    watertight: z.boolean(),
    repaired: z.boolean(),
    watertightBefore: z.boolean(),
    thumbnailFallback: z.boolean(),
    geometryHash: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type ProbeOutput = Extract<z.infer<typeof ProbeResultSchema>, { ok: true }>;
export type ConvertOutput = Extract<z.infer<typeof ConvertResultSchema>, { ok: true }>;

/** Settings with every default applied: what a conversion really used. */
export type { ResolvedSettings };

function isStl(bytes: Uint8Array): boolean {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 5));
  if (bytes.length >= 84) {
    const triangles = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      80,
      true,
    );
    if (bytes.length === 84 + triangles * 50) return true; // binary STL: exact size (may start with "solid")
  }
  return head === 'solid';
}

/** Format by extension AND content, so a renamed file is refused before a converter sees it. */
export function sniffMesh(bytes: Uint8Array, filename: string): MeshFormat | null {
  const ext = extname(filename).slice(1).toLowerCase();
  const format = MESH_FORMATS.find((f) => f === ext);
  if (format === undefined) return null;
  const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 4));
  if (format === 'glb') return magic === 'glTF' ? 'glb' : null;
  if (format === '3mf') return magic.startsWith('PK') ? '3mf' : null;
  return isStl(bytes) ? 'stl' : null;
}

function mapToolFailure(message: string): UserElementError {
  return new UserElementError(
    422,
    'mesh_unreadable',
    `the mesh could not be processed: ${message}`,
  );
}

/** The converter needs the bank python env (`uv`); without it the user gets a 503 with the fix, not a 500. */
async function callTool<T>(
  paths: BankPaths,
  job: object,
  name: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await runPythonScript<unknown>(paths, USER_MESH_SCRIPT, job, name);
  } catch (error) {
    throw new UserElementError(
      503,
      'converter_unavailable',
      `the mesh converter could not run: ${error instanceof Error ? error.message : String(error)}`,
      {
        fix: 'install uv and run `hsw-editor doctor`; the converter uses the bank python environment',
      },
    );
  }
  return schema.parse(raw);
}

function dimsOf(box: z.infer<typeof BboxTuple>): { x: number; y: number; z: number } {
  return {
    x: box.max[0] - box.min[0],
    y: box.max[1] - box.min[1],
    z: box.max[2] - box.min[2],
  };
}

export interface ProbedPart {
  partId: string;
  triangles: number;
  bboxMm: BankElement['bboxMm'];
  dimsMm: BankElement['dimsMm'];
  watertight: boolean;
  guess: Orientation;
}

export interface Probe {
  sha256: string;
  defaultPartId: string;
  parts: ProbedPart[];
}

export async function probeMesh(paths: BankPaths, file: string): Promise<Probe> {
  const result = await callTool(
    paths,
    { op: 'probe', path: file, unit: 'auto' },
    'user-probe',
    ProbeResultSchema,
  );
  if (!result.ok) throw mapToolFailure(result.error);
  return {
    sha256: result.sha256,
    defaultPartId: result.defaultPartId,
    parts: result.parts.map((part) => ({
      partId: part.partId,
      triangles: part.triangles,
      bboxMm: {
        min: { x: part.bboxMm.min[0], y: part.bboxMm.min[1], z: part.bboxMm.min[2] },
        max: { x: part.bboxMm.max[0], y: part.bboxMm.max[1], z: part.bboxMm.max[2] },
      },
      dimsMm: dimsOf(part.bboxMm),
      watertight: part.watertight,
      guess: part.guess,
    })),
  };
}

/** Applies defaults; the guessed orientation comes from the (default) part the settings select. */
export function resolveSettings(
  settings: ConvertSettings | undefined,
  probe: Probe,
): ResolvedSettings {
  const partId = settings?.partId ?? probe.defaultPartId;
  const part = probe.parts.find((p) => p.partId === partId);
  if (part === undefined && partId !== '*')
    throw new UserElementError(400, 'invalid_body', `no part ${partId} in the file`, {
      parts: probe.parts.map((p) => p.partId),
    });
  const guess = part?.guess ?? probe.parts.find((p) => p.partId === probe.defaultPartId)?.guess;
  return {
    partId,
    orient: settings?.orient ?? guess ?? { out: '+z', up: '+y' },
    anchor: settings?.anchor ?? 'back-bbox',
    unit: settings?.unit ?? 'auto',
    repair: settings?.repair ?? true,
  };
}

export interface ConvertRequest {
  /** Source mesh file. */
  file: string;
  /** Number of parts in the source: the external repair only handles single-part files. */
  format: MeshFormat;
  partCount: number;
  settings: ResolvedSettings;
  grid: BankPaths['grid'];
  glb: string;
  /** Thumbnail target; omitted for previews. */
  thumbnail?: string;
  color: string;
  /** Scratch dir for the externally repaired copy. */
  workDir: string;
}

export interface Converted extends ConvertOutput {
  warnings: string[];
}

/** `3d mesh --repair` (meshfix); null when the CLI or meshfix is missing, or the mesh stays broken. */
async function externalRepair(file: string, out: string): Promise<boolean> {
  const bin = process.env.HSW_3D_BIN ?? Bun.which('3d');
  if (!bin) return false;
  const timer = AbortSignal.timeout(EXTERNAL_REPAIR_TIMEOUT_MS);
  const proc = Bun.spawn([bin, 'mesh', file, '--repair', '-o', out], {
    stdout: 'ignore',
    stderr: 'ignore',
    signal: timer,
  });
  await proc.exited.catch(() => undefined);
  return Bun.file(out).exists();
}

async function convertOnce(
  paths: BankPaths,
  request: ConvertRequest,
  source: string,
  settings: ResolvedSettings,
): Promise<ConvertOutput> {
  const result = await callTool(
    paths,
    {
      op: 'convert',
      path: source,
      partId: settings.partId,
      orient: settings.orient,
      anchor: settings.anchor,
      unit: settings.unit,
      repair: settings.repair,
      grid: request.grid,
      backSlabMm: 1,
      glb: request.glb,
      thumbnail: request.thumbnail ?? '',
      color: request.color,
      views: ['iso'],
    },
    'user-convert',
    ConvertResultSchema,
  );
  if (!result.ok) throw mapToolFailure(result.error);
  return result;
}

/**
 * Converts one part of the source into the wall frame. A mesh that is still not watertight after the
 * in-process repair is handed to `3d mesh --repair` once (single-part STL/3MF only) when that CLI is installed.
 */
export async function convertMesh(paths: BankPaths, request: ConvertRequest): Promise<Converted> {
  const warnings: string[] = [];
  let result = await convertOnce(paths, request, request.file, request.settings);
  if (
    !result.watertight &&
    request.settings.repair &&
    request.partCount === 1 &&
    request.format !== 'glb'
  ) {
    const fixed = join(request.workDir, 'external-repair.stl');
    if (await externalRepair(request.file, fixed)) {
      // the repaired STL keeps the units of the original and has one part
      const again = await convertOnce(paths, request, fixed, {
        ...request.settings,
        partId: '0',
      }).catch(() => null);
      await rm(fixed, { force: true });
      if (again?.watertight) result = { ...again, repaired: true, watertightBefore: false };
    }
  }
  if (!result.watertight)
    warnings.push(
      'the mesh is not watertight and could not be repaired automatically; footprint and thumbnail may be off',
    );
  else if (result.repaired) warnings.push('the mesh was not watertight and has been repaired');
  if (result.thumbnailFallback)
    warnings.push('no GPU/EGL here: the thumbnail was drawn by the software fallback');
  return { ...result, warnings };
}
