/**
 * Top-1 / top-3 of class suggestion on the labelled carpet crops: CLIP text only vs prototypes only vs fused.
 *
 *   bun packages/tools/scripts/eval-recognition.ts <prototype dir> <crops dir> [--w 0.5] [--k 3] [--registered-only] [--misses]
 * Inputs come from `prototypes.ts` + `scripts/py/embed.py` (see there). Prints a markdown table.
 */
import { existsSync, readFileSync } from 'node:fs';
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
  dinoDim?: number;
  classes: string[];
};
const manifest = JSON.parse(readFileSync(join(protoDir, 'manifest.json'), 'utf8')) as {
  classId: string;
}[];
const cropMeta = JSON.parse(readFileSync(join(cropDir, 'crops-meta.json'), 'utf8')) as {
  crops: { index: number; label: string; accept: string[] }[];
};
const dim = meta.dim;
// crops of things the library has no class for (a storage box, a charger) can never be a hit: `--registered-only` drops them
const registered = new Set(meta.classes);
const evaluated = args.includes('--registered-only')
  ? cropMeta.crops.filter((c) => c.accept.some((id) => registered.has(id)))
  : cropMeta.crops;
const dinoDim = meta.dinoDim;
const haveDino =
  dinoDim !== undefined &&
  existsSync(join(protoDir, 'dino-prototypes.f32')) &&
  existsSync(join(cropDir, 'dino-crops.f32'));
const index = buildPrototypeIndex({
  dim,
  classIds: meta.classes,
  text: f32(join(protoDir, 'text.f32'), dim),
  protos: f32(join(protoDir, 'prototypes.f32'), dim),
  protoClassIds: manifest.map((m) => m.classId),
  ...(haveDino && dinoDim
    ? { dinoDim, dinoProtos: f32(join(protoDir, 'dino-prototypes.f32'), dinoDim) }
    : {}),
});
const crops = f32(join(cropDir, 'crops.f32'), dim);
const dinoCrops = haveDino && dinoDim ? f32(join(cropDir, 'dino-crops.f32'), dinoDim) : null;
if (dinoCrops && dinoDim && dinoCrops.length !== cropMeta.crops.length * dinoDim)
  throw new Error('dino-crops.f32 does not match crops-meta.json: run embed.py crops again');
const dinoOf = (i: number): Float32Array | undefined =>
  dinoCrops && dinoDim ? dinoCrops.subarray(i * dinoDim, (i + 1) * dinoDim) : undefined;
const fuse: FuseOptions = { w: Number(flag('w', '0.5')), k: Number(flag('k', '3')) };

type Ranker = (e: Float32Array, d?: Float32Array) => string[];
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
  ...(haveDino
    ? {
        'DINOv2 retrieval only': (_e: Float32Array, d?: Float32Array) =>
          d ? rank(protoScores(index, d, fuse.k ?? 3, 'dino')) : [],
        'fused CLIP + DINOv2 (defaults)': (e: Float32Array, d?: Float32Array) =>
          suggestClasses(index, e, {}, d).map((s) => s.classId),
      }
    : {}),
};

const misses: Record<string, string[]> = {};
console.log('| method | top-1 | top-3 | top-5 |');
console.log('| --- | --- | --- | --- |');
for (const [name, ranker] of Object.entries(rankers)) {
  const hits = [0, 0, 0];
  cropMeta.crops.forEach((c, i) => {
    if (!evaluated.includes(c)) return;
    const e = crops.subarray(i * dim, (i + 1) * dim);
    const order = ranker(e, dinoOf(i));
    [1, 3, 5].forEach((k, j) => {
      if (order.slice(0, k).some((id) => c.accept.includes(id))) hits[j] = (hits[j] ?? 0) + 1;
    });
    if (!c.accept.includes(order[0] ?? ''))
      (misses[name] ??= []).push(`#${c.index} ${c.label} -> ${order.slice(0, 3).join(', ')}`);
  });
  const n = evaluated.length;
  console.log(
    `| ${name} | ${((hits[0] ?? 0) / n).toFixed(2)} | ${((hits[1] ?? 0) / n).toFixed(2)} | ${((hits[2] ?? 0) / n).toFixed(2)} |`,
  );
}
console.log(
  `\n${evaluated.length} crops, ${meta.classes.length} classes, ${manifest.length} prototype images`,
);
if (haveDino && args.includes('--loo')) {
  // Leave-one-out: the (w, wd, dinoTemp) of each crop's ranking is chosen on the OTHER crops, so the number is not tuned on itself.
  const grid: FuseOptions[] = [];
  for (const w of [0.3, 0.5, 0.7])
    for (const wd of [0.3, 0.5, 0.8, 1.2])
      for (const dinoTemp of [4, 8]) grid.push({ ...fuse, w, wd, dinoTemp });
  const hit = (g: FuseOptions, i: number): [boolean, boolean] => {
    const c = cropMeta.crops[i] as (typeof cropMeta.crops)[number];
    const order = suggestClasses(index, crops.subarray(i * dim, (i + 1) * dim), g, dinoOf(i)).map(
      (s) => s.classId,
    );
    return [c.accept.includes(order[0] ?? ''), order.slice(0, 3).some((id) => c.accept.includes(id))];
  };
  const table = grid.map((g) => cropMeta.crops.map((_, i) => hit(g, i)));
  const idx = cropMeta.crops.map((_, i) => i).filter((i) => evaluated.includes(cropMeta.crops[i] as never));
  let loo1 = 0;
  let loo3 = 0;
  const picked = new Map<string, number>();
  for (const i of idx) {
    const rest = idx.filter((j) => j !== i);
    const score = (gi: number): number =>
      rest.reduce((a, j) => a + ((table[gi]?.[j]?.[0] ? 1 : 0) + (table[gi]?.[j]?.[1] ? 0.01 : 0)), 0);
    let best = 0;
    for (let gi = 1; gi < grid.length; gi++) if (score(gi) > score(best)) best = gi;
    const [h1, h3] = table[best]?.[i] ?? [false, false];
    loo1 += h1 ? 1 : 0;
    loo3 += h3 ? 1 : 0;
    const g = grid[best] as FuseOptions;
    const key = `w=${g.w} wd=${g.wd} dinoTemp=${g.dinoTemp}`;
    picked.set(key, (picked.get(key) ?? 0) + 1);
  }
  console.log(
    `\nleave-one-out over ${idx.length} crops: top-1 ${(loo1 / idx.length).toFixed(2)}, top-3 ${(loo3 / idx.length).toFixed(2)}; chosen: ${[...picked].map(([k, v]) => `${k} x${v}`).join(', ')}`,
  );
}
if (args.includes('--misses'))
  for (const [k, v] of Object.entries(misses)) console.log(`\n${k}\n  ${v.join('\n  ')}`);
