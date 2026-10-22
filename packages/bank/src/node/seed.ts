/**
 * The committed seed: the redistributable subset of the built bank (project originals, generated
 * families, CC-BY sources) so that a fresh clone has a working bank without the HSW source tree.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BankIndexSchema, type BankElement, type BankIndex } from '../schema.ts';
import { buildSearchIndex, serializeSearchIndex } from '../search.ts';
import { validateBankIndex } from '../validate.ts';
import type { BankPaths } from './paths.ts';

export const SEED_BUDGET_BYTES = 5 * 1024 * 1024;
/** Leave headroom for index.json, the search index and attribution. */
const SEED_ASSET_BUDGET_BYTES = 3.6 * 1024 * 1024;

export interface SeedResult {
  elements: number;
  bytes: number;
  excluded: number;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

export function attributionMarkdown(elements: readonly BankElement[]): string {
  const lines = [
    '# Seed attribution',
    '',
    'Geometry in this directory is redistributable under the licence listed per element.',
    'Generated and project-original elements are MIT (see the repository LICENSE).',
    '',
  ];
  const external = elements.filter((e) => e.license.spdx !== 'MIT');
  const bySource = new Map<string, string[]>();
  for (const e of external) {
    const list = bySource.get(e.license.attribution) ?? [];
    list.push(e.id);
    bySource.set(e.license.attribution, list);
  }
  for (const [attribution, ids] of [...bySource].sort()) {
    lines.push(`- ${attribution}: ${ids.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function assetBytes(e: BankElement): number {
  const lod1 = e.assets.lod1.path === e.assets.lod0.path ? 0 : e.assets.lod1.bytes;
  return e.assets.lod0.bytes + lod1 + e.assets.thumbnail.bytes;
}

/** Van der Corput order over 0..n-1: first, middle, quarters... so any prefix spans the whole size ladder. */
function spreadOrder(n: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; order.length < n; i++) {
    let index = 0;
    let bit = i;
    let weight = 0.5;
    while (bit > 0) {
      if (bit & 1) index += weight;
      bit >>= 1;
      weight /= 2;
    }
    const candidate = Math.min(n - 1, Math.floor(index * n));
    if (!seen.has(candidate)) {
      seen.add(candidate);
      order.push(candidate);
    }
    if (i > n * 8) break;
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);
  return order;
}

/**
 * All non-generated redistributable elements, plus generated ones as far as the asset budget allows:
 * families are served round-robin with ladder rungs spread over their range. Generated elements left out
 * are rebuilt by `bank:ingest` (OpenSCAD only, no source files needed).
 */
export function pickSeedElements(redistributable: readonly BankElement[]): BankElement[] {
  const picked = redistributable.filter((e) => !e.generated);
  let bytes = picked.reduce((sum, e) => sum + assetBytes(e), 0);
  const families = new Map<string, BankElement[]>();
  for (const e of redistributable) {
    if (!e.generated) continue;
    const key = e.family ?? e.id;
    families.set(key, [...(families.get(key) ?? []), e]);
  }
  const queues = [...families.values()].map((list) =>
    spreadOrder(list.length).map((i) => list[i]!),
  );
  for (let round = 0; queues.some((q) => q.length > round); round++) {
    for (const queue of queues) {
      const e = queue[round];
      if (!e || bytes + assetBytes(e) > SEED_ASSET_BUDGET_BYTES) continue;
      picked.push(e);
      bytes += assetBytes(e);
    }
  }
  return picked.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
}

/** Rebuilds `packages/bank/seed` from the built bank dir. Fails when it exceeds the size budget. */
export async function exportSeed(paths: BankPaths): Promise<SeedResult> {
  const built = BankIndexSchema.parse(await Bun.file(join(paths.bankDir, 'index.json')).json());
  const keep = pickSeedElements(built.elements.filter((e) => e.license.redistributable));
  const generated = keep.filter((e) => e.generated).length;
  const base = {
    version: built.version,
    grid: built.grid,
    counts: {
      total: keep.length,
      generated,
      fromSources: keep.length - generated,
      redistributable: keep.length,
    },
    categories: built.categories,
    toolClasses: built.toolClasses,
    elements: keep,
  };
  const index: BankIndex = { ...base, contentHash: sha256(JSON.stringify(base)) };
  const validation = validateBankIndex(index);
  if (!validation.ok) throw new Error(`seed index invalid:\n${validation.errors.join('\n')}`);

  await rm(paths.seedDir, { recursive: true, force: true });
  await mkdir(join(paths.seedDir, 'glb'), { recursive: true });
  await mkdir(join(paths.seedDir, 'thumb'), { recursive: true });
  const assets = new Set<string>();
  for (const e of keep) {
    for (const a of [e.assets.lod0, e.assets.lod1, e.assets.thumbnail]) assets.add(a.path);
  }
  let bytes = 0;
  for (const path of assets) {
    await copyFile(join(paths.bankDir, path), join(paths.seedDir, path));
    bytes += Bun.file(join(paths.seedDir, path)).size;
  }
  const indexJson = JSON.stringify(index);
  const searchJson = serializeSearchIndex(buildSearchIndex(keep), index.contentHash);
  await Bun.write(join(paths.seedDir, 'index.json'), indexJson);
  await Bun.write(join(paths.seedDir, 'search-index.json'), searchJson);
  await Bun.write(join(paths.seedDir, 'ATTRIBUTION.md'), attributionMarkdown(keep));
  bytes += indexJson.length + searchJson.length;
  if (bytes > SEED_BUDGET_BYTES) {
    throw new Error(`seed is ${bytes} bytes, over the ${SEED_BUDGET_BYTES} byte budget`);
  }
  return { elements: keep.length, bytes, excluded: built.elements.length - keep.length };
}
