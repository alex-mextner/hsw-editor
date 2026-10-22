/** On-demand rebuild of a parametric element at other dimensions (dimension widget). */
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FamilyFileSchema } from '../families.ts';
import type { BankElement, VariantResponse } from '../schema.ts';
import { compressGlb } from './compress.ts';
import { openscadAvailable, runMeshTool } from './exec.ts';
import type { BuildResult } from './meshTool.ts';
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

interface VariantBuild {
  glb: string;
  bboxMm: VariantResponse['bboxMm'];
  footprint: VariantResponse['footprint'];
}

const inFlight = new Map<string, Promise<VariantResponse>>();

/** Concurrent requests for the same parameters share one build. */
export function buildVariant(
  paths: BankPaths,
  element: BankElement,
  requested: Record<string, number>,
): Promise<VariantResponse> {
  const key = `${element.id}:${JSON.stringify(Object.entries(normalizeParams(element, requested)).sort())}`;
  const running = inFlight.get(key);
  if (running) return running;
  const started = buildVariantUncached(paths, element, requested).finally(() =>
    inFlight.delete(key),
  );
  inFlight.set(key, started);
  return started;
}

async function buildVariantUncached(
  paths: BankPaths,
  element: BankElement,
  requested: Record<string, number>,
): Promise<VariantResponse> {
  const generator = element.provenance.generator;
  if (!generator) throw new VariantError(409, `${element.id} has no parametric generator`);
  const params = normalizeParams(element, requested);
  if (!openscadAvailable()) throw new VariantError(503, 'openscad is not installed');

  const families = FamilyFileSchema.parse(
    await Bun.file(join(paths.repoRoot, 'packages/bank/generators/families.json')).json(),
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
  const paramHash = (await scadKey(paths, job)).slice(0, 16);
  const dir = join(paths.cacheDir, 'variants', paramHash);
  const doneFile = Bun.file(join(dir, 'done.json'));
  const bankGlb = join(paths.bankDir, 'variant', `${paramHash}.glb`);

  let build: VariantBuild;
  let cached = false;
  if ((await doneFile.exists()) && (await Bun.file(bankGlb).exists())) {
    build = (await doneFile.json()) as VariantBuild;
    cached = true;
  } else {
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
            anchor: family.anchor,
            backSlabMm: 1,
            glb: join(dir, 'raw.glb'),
            views: ['iso'],
            color: '#4f7fb0',
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
    await copyFile(join(dir, 'variant.glb'), bankGlb);
    const cells = (built.cells ?? [[0, 0]]).map(([dCol, dRow2]) => ({ dCol, dRow2 }));
    const cols = cells.map((c) => c.dCol);
    const rows2 = cells.map((c) => c.dRow2);
    build = {
      glb: `variant/${paramHash}.glb`,
      bboxMm: {
        min: { x: built.bboxMm.min[0], y: built.bboxMm.min[1], z: built.bboxMm.min[2] },
        max: { x: built.bboxMm.max[0], y: built.bboxMm.max[1], z: built.bboxMm.max[2] },
      },
      footprint: {
        cells,
        cols: Math.max(...cols) - Math.min(...cols) + 1,
        rows: Math.ceil((Math.max(...rows2) - Math.min(...rows2)) / 2) + 1,
      },
    };
    await Bun.write(join(dir, 'done.json'), JSON.stringify(build));
  }
  const { min, max } = build.bboxMm;
  return {
    glbUrl: `/bank/assets/${build.glb}`,
    bboxMm: build.bboxMm,
    dimsMm: { x: max.x - min.x, y: max.y - min.y, z: max.z - Math.max(0, min.z) },
    footprint: build.footprint,
    paramHash,
    params,
    cached,
  };
}
