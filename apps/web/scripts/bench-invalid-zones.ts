/**
 * Perf budget for the invalid-zone engine (ticket #48): 200 real holders, cold full solve, then a drag of one
 * holder across its neighbours with the warm pair cache, which is what runs per pointer move. Exits 1 when a
 * budget is exceeded, so it doubles as a regression gate:
 *
 *   bun apps/web/scripts/bench-invalid-zones.ts [--items 200] [--seed <bank seed dir>] [--steps 150] [--json]
 *
 * Without `--seed` it uses the three real bank GLBs committed as test fixtures. The engine runs in a Web Worker in
 * the app, so the numbers are worker-thread cost per update; the render thread only receives the result.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Board, DEFAULT_BOARD, PoseSchema } from '@hsw-editor/core';
import {
  InvalidZoneEngine,
  type EngineItem,
  type SolidMesh,
} from '../src/scene/invalid-zones/engine.ts';
import { readGlbSolid } from '../src/scene/invalid-zones/glb.ts';
import { loadManifold } from '../src/scene/invalid-zones/manifold.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const count = (name: string, fallback: number): number => {
  const raw = flag(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(
      `usage: bench-invalid-zones [--items N] [--steps N] [--seed DIR] [--json] (bad --${name}: ${raw})`,
    );
    process.exit(2);
  }
  return value;
};
const itemCount = count('items', 200);
const steps = count('steps', 150);
const seedDir = flag('seed');
const asJson = args.includes('--json');

/**
 * Budgets (ms). The solve runs in a worker, so the render thread keeps 60 fps regardless; the budget keeps the stripes
 * following the pointer at >= 40 Hz (p95) even when the dragged holder sits deep inside its neighbours.
 */
const BUDGET = { dragStepP95Ms: 25, dragStepMaxMs: 60, coldSolveMs: 3000 };
const FRAME_MS = 1000 / 60;

const fixtures = new URL('../src/scene/invalid-zones/__fixtures__/', import.meta.url);

async function loadSolids(): Promise<Map<string, SolidMesh>> {
  const solids = new Map<string, SolidMesh>();
  const read = async (path: string | URL, key: string): Promise<void> => {
    const bytes = readFileSync(path);
    solids.set(
      key,
      await readGlbSolid(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    );
  };
  if (seedDir) {
    const index = JSON.parse(readFileSync(resolve(seedDir, 'index.json'), 'utf8')) as {
      elements: { id: string; assets: { lod0: { path: string } } }[];
    };
    for (const element of index.elements)
      await read(resolve(seedDir, element.assets.lod0.path), element.id);
  } else {
    for (const name of [
      'scissors-slot-slots1-bladethickness4',
      'bit-block-bitsperrow14-rows1',
      'cup-round-innerdiameter30-cupheight40',
    ]) {
      await read(new URL(`${name}.glb`, fixtures), name);
    }
  }
  return solids;
}

function boundsOf(mesh: SolidMesh): { w: number; h: number; cx: number; cy: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    minX = Math.min(minX, mesh.positions[i] ?? 0);
    maxX = Math.max(maxX, mesh.positions[i] ?? 0);
    minY = Math.min(minY, mesh.positions[i + 1] ?? 0);
    maxY = Math.max(maxY, mesh.positions[i + 1] ?? 0);
  }
  return { w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** Row-packed layout: holders side by side with a 1 mm gap, rows by tallest holder; deterministic. */
function layout(solids: Map<string, SolidMesh>, board: Board, count: number): EngineItem[] {
  const keys = [...solids.keys()];
  const items: EngineItem[] = [];
  let seed = 3;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const width = board.cols * board.colPitchMm;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  while (items.length < count) {
    const key = keys[Math.floor(rnd() ** 2 * keys.length)] ?? keys[0];
    const mesh = key === undefined ? undefined : solids.get(key);
    if (key === undefined || !mesh) throw new Error('no solids');
    const { w, h, cx, cy } = boundsOf(mesh);
    if (x + w > width) {
      x = 0;
      y += rowHeight + 1;
      rowHeight = 0;
    }
    items.push({
      id: `i${items.length}`,
      kind: 'holder',
      solidKey: key,
      pose: PoseSchema.parse({ x: x + w / 2 - cx + 1, y: y + h / 2 - cy + 1 }),
    });
    x += w + 1;
    rowHeight = Math.max(rowHeight, h);
  }
  return items;
}

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

const wasm = await loadManifold();
const solids = await loadSolids();
const board: Board = { ...DEFAULT_BOARD, cols: 90, rows: 60 };
const engine = new InvalidZoneEngine(wasm);
for (const [key, mesh] of solids) engine.defineSolid(key, { kind: 'mesh', mesh });
const items = layout(solids, board, itemCount);

let started = performance.now();
const cold = engine.solve(board, items);
const coldMs = performance.now() - started;

// Drag one mid-wall holder across the row: warm cache, only pairs involving it change per step.
const mover = items[Math.floor(items.length / 2)];
if (!mover) throw new Error('empty layout');
const times: number[] = [];
let overlapsSeen = 0;
let booleans = 0;
for (let step = 0; step < steps; step++) {
  const moved = items.map((it) =>
    it.id === mover.id
      ? {
          ...it,
          pose: PoseSchema.parse({
            ...it.pose,
            x: it.pose.x + step * 1.1,
            y: it.pose.y + Math.sin(step / 9) * 6,
          }),
        }
      : it,
  );
  started = performance.now();
  const result = engine.solve(board, moved);
  times.push(performance.now() - started);
  booleans += result.stats.booleans;
  if (result.reasons.some((r) => r.kind === 'overlap')) overlapsSeen += 1;
}
times.sort((a, b) => a - b);
const report = {
  items: items.length,
  solids: solids.size,
  coldSolveMs: Math.round(coldMs),
  coldBooleans: cold.stats.booleans,
  coldInvalidReasons: cold.reasons.length,
  dragSteps: steps,
  dragStepsWithOverlap: overlapsSeen,
  dragBooleansPerStep: +(booleans / steps).toFixed(2),
  dragStepsWithinFrame: `${times.filter((t) => t <= FRAME_MS).length}/${times.length} <= ${FRAME_MS.toFixed(1)} ms`,
  dragStepMs: {
    p50: +percentile(times, 0.5).toFixed(2),
    p95: +percentile(times, 0.95).toFixed(2),
    max: +(times[times.length - 1] ?? 0).toFixed(2),
  },
  budget: BUDGET,
};
engine.dispose();

const failures: string[] = [];
if (report.dragStepMs.p95 > BUDGET.dragStepP95Ms)
  failures.push(`drag step p95 ${report.dragStepMs.p95} ms > ${BUDGET.dragStepP95Ms}`);
if (report.dragStepMs.max > BUDGET.dragStepMaxMs)
  failures.push(`drag step max ${report.dragStepMs.max} ms > ${BUDGET.dragStepMaxMs}`);
if (report.coldSolveMs > BUDGET.coldSolveMs)
  failures.push(`cold solve ${report.coldSolveMs} ms > ${BUDGET.coldSolveMs}`);
if (asJson) console.info(JSON.stringify({ ...report, failures }, null, 2));
else {
  console.info(report);
  console.info(
    failures.length === 0 ? 'perf budget: OK' : `perf budget: FAILED\n  ${failures.join('\n  ')}`,
  );
}
process.exit(failures.length === 0 ? 0 : 1);
