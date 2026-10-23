/** On-demand rebuild of a parametric element at other dimensions (dimension widget). */
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FamilyFileSchema } from '../families.ts';
import type { BankElement, VariantResponse } from '../schema.ts';
import { compressGlb } from './compress.ts';
import { openscadAvailable, runMeshTool } from './exec.ts';
import { buildCodeHash } from './fingerprint.ts';
import { artefactInputs, geometryOf, type BuiltGeometry } from './geometry.ts';
import type { AnchorMode, BuildResult } from './meshTool.ts';
import type { BankPaths } from './paths.ts';
import { renderMissing, scadKey, type ScadJob } from './scad.ts';
import { MESH_TOOL_VERSION } from './sources.ts';

export class VariantError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** Clamps every given value to its ParamDef range and snaps it to the step; unknown keys are rejected. */
export function normalizeParams(
  element: BankElement,
  requested: Record<string, number>,
): Record<string, number> {
  const defs = element.params;
  const generator = element.provenance.generator;
  if (!defs || !generator) throw new VariantError(409, `${element.id} has no parametric generator`);
  const values: Record<string, number> = { ...generator.values };
  for (const [key, raw] of Object.entries(requested)) {
    const def = defs.find((p) => p.key === key);
    if (!def) throw new VariantError(400, `unknown parameter ${key}`);
    if (!Number.isFinite(raw))
      throw new VariantError(400, `parameter ${key} is not a finite number`);
    const clamped = Math.min(def.max, Math.max(def.min, raw));
    const snapped = def.min + Math.round((clamped - def.min) / def.step) * def.step;
    values[key] = Math.round(Math.min(def.max, snapped) * 1000) / 1000;
  }
  return values;
}

/** What a finished variant build stores next to its GLB. */
type VariantBuild = { glb: string } & BuiltGeometry;

/** Heavy renders (OpenSCAD + mesh_tool + compression) allowed at once across all variant requests. */
const MAX_CONCURRENT_BUILDS = 2;
let activeBuilds = 0;
const waiting: (() => void)[] = [];

async function withBuildSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeBuilds >= MAX_CONCURRENT_BUILDS) await new Promise<void>((r) => waiting.push(r));
  else activeBuilds++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeBuilds--;
  }
}

const inFlight = new Map<string, Promise<VariantResponse>>();

/** Concurrent requests that resolve to the same build (same paramHash) share one run. */
export async function buildVariant(
  paths: BankPaths,
  element: BankElement,
  requested: Record<string, number>,
): Promise<VariantResponse> {
  const generator = element.provenance.generator;
  if (!generator) throw new VariantError(409, `${element.id} has no parametric generator`);
  const params = normalizeParams(element, requested);
  if (!openscadAvailable()) throw new VariantError(503, 'openscad is not installed');

  const families = FamilyFileSchema.parse(
    await Bun.file(join(paths.generatorsDir, 'families.json')).json(),
  );
  const family = families.families.find((f) => f.id === element.family);
  if (!family)
    throw new VariantError(409, `family ${element.family ?? '?'} of ${element.id} is not defined`);

  const job: ScadJob = {
    generator: generator.generator,
    part: generator.part,
    version: generator.version,
    values: params,
  };
  // the geometry key plus everything else that shapes the stored artefacts
  const inputs = artefactInputs(element.category);
  const paramHash = sha256(
    JSON.stringify([
      await scadKey(paths, job),
      MESH_TOOL_VERSION,
      await buildCodeHash(paths),
      family.anchor,
      inputs,
      element.mounting.kind,
    ]),
  ).slice(0, 16);

  // a finished build needs no render slot and no in-flight bookkeeping
  const dir = join(paths.cacheDir, 'variants', paramHash);
  const doneFile = Bun.file(join(dir, 'done.json'));
  if ((await doneFile.exists()) && (await Bun.file(variantGlbPath(paths, paramHash)).exists())) {
    return respond((await doneFile.json()) as VariantBuild, paramHash, params, true);
  }

  const running = inFlight.get(paramHash);
  if (running) return running;
  const started = withBuildSlot(() =>
    buildVariantUncached(paths, element.mounting.kind, family.anchor, inputs, job, paramHash),
  ).finally(() => inFlight.delete(paramHash));
  inFlight.set(paramHash, started);
  return started;
}

function variantGlbPath(paths: BankPaths, paramHash: string): string {
  return join(paths.bankDir, 'variant', `${paramHash}.glb`);
}

function respond(
  build: VariantBuild,
  paramHash: string,
  params: Record<string, number>,
  cached: boolean,
): VariantResponse {
  return {
    glbUrl: `/bank/assets/${build.glb}`,
    bboxMm: build.bboxMm,
    dimsMm: build.dimsMm,
    footprint: build.footprint,
    mountingCells: build.mountingCells,
    paramHash,
    params,
    cached,
  };
}

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

async function buildVariantUncached(
  paths: BankPaths,
  mountKind: BankElement['mounting']['kind'],
  anchor: AnchorMode,
  inputs: ReturnType<typeof artefactInputs>,
  job: ScadJob,
  paramHash: string,
): Promise<VariantResponse> {
  const dir = join(paths.cacheDir, 'variants', paramHash);
  await mkdir(dir, { recursive: true });
  const rendered = await renderMissing(paths, [job]);
  const stl = [...rendered.stl.values()][0];
  if (!stl)
    throw new VariantError(500, [...rendered.failed.values()][0] ?? 'render produced no output');
  const result = await runMeshTool<BuildResult>(
    paths,
    {
      op: 'build',
      grid: paths.grid,
      items: [
        {
          key: paramHash,
          path: stl,
          partId: '0',
          orient: { out: '+z', up: '+y' },
          anchor,
          glb: join(dir, 'raw.glb'),
          ...inputs,
        },
      ],
    },
    `variant-${paramHash}`,
  );
  const built = result.items[0];
  if (result.toolVersion !== MESH_TOOL_VERSION || !built?.ok || !built.bboxMm) {
    throw new VariantError(500, built?.error ?? 'variant build failed');
  }
  const compressed = await compressGlb(
    new Uint8Array(await Bun.file(join(dir, 'raw.glb')).arrayBuffer()),
  );
  await Bun.write(join(dir, 'variant.glb'), compressed.lod0);
  await mkdir(join(paths.bankDir, 'variant'), { recursive: true });
  await copyFile(join(dir, 'variant.glb'), variantGlbPath(paths, paramHash));
  const build: VariantBuild = { glb: `variant/${paramHash}.glb`, ...geometryOf(built, mountKind) };
  await Bun.write(join(dir, 'done.json'), JSON.stringify(build));
  return respond(build, paramHash, job.values, false);
}

const VARIANT_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const VARIANT_MAX_BYTES = 256 * 1024 * 1024;

/** Deletes variant GLBs (and their build dirs) older than 14 days, then the oldest until under 256 MiB. */
export async function collectVariantGarbage(paths: BankPaths, now = Date.now()): Promise<void> {
  const dir = join(paths.bankDir, 'variant');
  const names = await readdir(dir).catch(() => []);
  const files = (
    await Promise.all(
      names.map(async (name) => {
        const info = await stat(join(dir, name)).catch(() => null);
        return info ? { name, size: info.size, mtimeMs: info.mtimeMs } : null;
      }),
    )
  )
    .filter((f) => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let total = 0;
  for (const file of files) {
    total += file.size;
    if (now - file.mtimeMs <= VARIANT_MAX_AGE_MS && total <= VARIANT_MAX_BYTES) continue;
    await rm(join(dir, file.name), { force: true });
    await rm(join(paths.cacheDir, 'variants', file.name.replace(/\.glb$/, '')), {
      recursive: true,
      force: true,
    });
  }
}
