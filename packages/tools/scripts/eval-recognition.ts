/**
 * Top-1 / top-3 of class suggestion on the labelled carpet crops: CLIP text only vs prototypes only vs fused.
 *
 *   bun packages/tools/scripts/eval-recognition.ts <prototype dir> <crops dir> [--w 0.5] [--k 3]
 * Inputs come from `prototypes.ts` + `scripts/py/embed.py` (see there). Prints a markdown table.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FuseOptions,
  buildPrototypeIndex,
  protoScores,
  readF32,
  suggestClasses,
  textLogits,
} from '../src/recognize/fuse.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const [protoDir, cropDir] = args.filter(
  (a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'),
);
if (!protoDir || !cropDir)
  throw new Error('usage: eval-recognition.ts <prototype dir> <crops dir>');

const f32 = (path: string, dim: number): Float32Array => {
  const b = readFileSync(path);
  return readF32(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, dim);
};
const meta = JSON.parse(readFileSync(join(protoDir, 'meta.json'), 'utf8')) as {
  dim: number;
  classes: string[];
};
const manifest = JSON.parse(readFileSync(join(protoDir, 'manifest.json'), 'utf8')) as {
  classId: string;
}[];
const cropMeta = JSON.parse(readFileSync(join(cropDir, 'crops-meta.json'), 'utf8')) as {
  crops: { index: number; label: string; accept: string[] }[];
};
const dim = meta.dim;
const index = buildPrototypeIndex({
  dim,
  classIds: meta.classes,
  text: f32(join(protoDir, 'text.f32'), dim),
  protos: f32(join(protoDir, 'prototypes.f32'), dim),
  protoClassIds: manifest.map((m) => m.classId),
});
const crops = f32(join(cropDir, 'crops.f32'), dim);
const fuse: FuseOptions = { w: Number(flag('w', '0.5')), k: Number(flag('k', '3')) };

type Ranker = (e: Float32Array) => string[];
const rank = (scores: number[]): string[] =>
  scores
    .map((s, i) => [s, meta.classes[i] as string] as const)
    .sort((a, b) => b[0] - a[0])
    .map((x) => x[1]);
const rankers: Record<string, Ranker> = {
  'CLIP text (class-bias corrected)': (e) => rank(textLogits(index, e)),
  'prototype retrieval only': (e) => rank(protoScores(index, e, fuse.k ?? 3)),
  [`fused (w=${fuse.w}, k=${fuse.k})`]: (e) => suggestClasses(index, e, fuse).map((s) => s.classId),
  'fused, prototypes only (w=1)': (e) =>
    suggestClasses(index, e, { ...fuse, w: 1 }).map((s) => s.classId),
};

const misses: Record<string, string[]> = {};
console.log('| method | top-1 | top-3 | top-5 |');
console.log('| --- | --- | --- | --- |');
for (const [name, ranker] of Object.entries(rankers)) {
  const hits = [0, 0, 0];
  cropMeta.crops.forEach((c, i) => {
    const e = crops.subarray(i * dim, (i + 1) * dim);
    const order = ranker(e);
    [1, 3, 5].forEach((k, j) => {
      if (order.slice(0, k).some((id) => c.accept.includes(id))) hits[j] = (hits[j] ?? 0) + 1;
    });
    if (!c.accept.includes(order[0] ?? ''))
      (misses[name] ??= []).push(`#${c.index} ${c.label} -> ${order.slice(0, 3).join(', ')}`);
  });
  const n = cropMeta.crops.length;
  console.log(
    `| ${name} | ${((hits[0] ?? 0) / n).toFixed(2)} | ${((hits[1] ?? 0) / n).toFixed(2)} | ${((hits[2] ?? 0) / n).toFixed(2)} |`,
  );
}
console.log(
  `\n${cropMeta.crops.length} crops, ${meta.classes.length} classes, ${manifest.length} prototype images`,
);
if (args.includes('--misses'))
  for (const [k, v] of Object.entries(misses)) console.log(`\n${k}\n  ${v.join('\n  ')}`);
