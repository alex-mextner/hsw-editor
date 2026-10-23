/**
 * Why shallow overlaps used to go unmarked (tg#23742), measured: random pairs of real bank elements anchored on
 * honeycomb cells, judged by the old cell-footprint check (`layoutProblems`) and by the exact geometry engine.
 *
 *   bun apps/web/scripts/compare-footprint-vs-geometry.ts --seed <bank seed dir> [--pairs 3000] [--json]
 *
 * Reports how many pairs the old check called clean although the bodies interpenetrate, and the depth of those.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BankIndexSchema, type BankElement } from '@hsw-editor/bank';
import { cellCenter, DEFAULT_BOARD, WallItemSchema, type WallItem } from '@hsw-editor/core';
import { InvalidZoneEngine, type SolidMesh } from '../src/scene/invalid-zones/engine.ts';
import { readGlbSolid } from '../src/scene/invalid-zones/glb.ts';
import { loadManifold } from '../src/scene/invalid-zones/manifold.ts';
import { layoutProblems } from '../src/wall/footprint.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const seedDir = flag('seed');
const pairCount = Number(flag('pairs') ?? 3000);
if (!seedDir || !Number.isInteger(pairCount) || pairCount < 1) {
  console.error('usage: compare-footprint-vs-geometry --seed DIR [--pairs N] [--json]');
  process.exit(2);
}

const index = BankIndexSchema.parse(
  JSON.parse(readFileSync(resolve(seedDir, 'index.json'), 'utf8')),
);
const elements = new Map<string, BankElement>(
  index.elements.map((element) => [element.id, element]),
);
const wasm = await loadManifold();
const engine = new InvalidZoneEngine(wasm);
for (const element of index.elements) {
  const bytes = readFileSync(resolve(seedDir, element.assets.lod0.path));
  const mesh: SolidMesh = await readGlbSolid(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  engine.defineSolid(element.id, { kind: 'mesh', mesh });
}

let seed = 17;
const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
const board = { ...DEFAULT_BOARD, cols: 30, rows: 20 };

function place(id: string, bankId: string, col: number, row: number, rotZ: number): WallItem {
  const centre = cellCenter(board, { col, row });
  return WallItemSchema.parse({
    id,
    kind: 'holder',
    bankId,
    cell: { col, row },
    pose: { x: centre.x, y: centre.y, rotZ },
  });
}

const ids = index.elements.map((element) => element.id);
let footprintClean = 0;
let footprintFlagged = 0;
let geometryOverlap = 0;
let missedByFootprint = 0;
let falseAlarmOfFootprint = 0;
const missedDepths: number[] = [];
for (let n = 0; n < pairCount; n += 1) {
  const a = place('a', pick(ids), 14, 9, pick([0, 60, 120, 180, 240, 300]));
  const b = place(
    'b',
    pick(ids),
    14 + Math.floor(rnd() * 9) - 4,
    9 + Math.floor(rnd() * 9) - 4,
    pick([0, 60, 120, 180, 240, 300]),
  );
  if (a.cell?.col === b.cell?.col && a.cell?.row === b.cell?.row) continue;
  const old = layoutProblems([a, b], board, elements).size > 0;
  const solved = engine.solve(
    board,
    [a, b].map((item) => ({
      id: item.id,
      kind: item.kind,
      solidKey: item.bankId ?? '',
      pose: item.pose,
    })),
  );
  const overlap = solved.reasons.find((reason) => reason.kind === 'overlap');
  if (old) footprintFlagged += 1;
  else footprintClean += 1;
  if (overlap) geometryOverlap += 1;
  if (!old && overlap?.kind === 'overlap') {
    missedByFootprint += 1;
    missedDepths.push(overlap.depthMm);
  }
  if (old && !overlap) falseAlarmOfFootprint += 1;
}
missedDepths.sort((x, y) => x - y);
const at = (q: number): number =>
  +(missedDepths[Math.floor(missedDepths.length * q)] ?? 0).toFixed(2);
const report = {
  pairs: footprintClean + footprintFlagged,
  oldCheckFlagged: footprintFlagged,
  oldCheckClean: footprintClean,
  geometryOverlap,
  overlapsTheOldCheckMissed: missedByFootprint,
  oldCheckFalseAlarms: falseAlarmOfFootprint,
  missedDepthMm: {
    min: at(0),
    median: at(0.5),
    p90: at(0.9),
    max: +(missedDepths.at(-1) ?? 0).toFixed(2),
  },
  missedUnder1mm: missedDepths.filter((depth) => depth < 1).length,
};
engine.dispose();
console.info(args.includes('--json') ? JSON.stringify(report, null, 2) : report);
