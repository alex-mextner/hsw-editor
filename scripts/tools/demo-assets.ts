/**
 * Writes the tool model assets the demo build (GitHub Pages, no daemon) serves: content-hashed LOD0/LOD1 GLBs of the classes the
 * showcase wall uses and their index, with the same store and file names as the daemon's `/tools/assets/*`, and `seats.json`, the ops
 * that seat the showcase tools in their holders (`showcase-seats.ts`). The web build copies the result next to the app
 * (`demoSeedBank` in apps/web/vite.config.ts). Rebuilt from scratch every time (models of an older generator never travel into the build).
 *
 *   bun scripts/tools/demo-assets.ts [out dir]     (default apps/web/.generated/tools-assets)
 */
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { HolderSpec } from '../../packages/compat/src/index.ts';
import '../../packages/tools/src/classes/index.ts';
import { ToolAssetStore } from '../../packages/tools/src/node/assets.ts';
import { SHOWCASE_LAYOUT } from '../../apps/web/src/demo/showcaseLayout.ts';
import { seatShowcase } from './showcase-seats.ts';

interface SeedElement {
  readonly id: string;
  readonly category: string;
  readonly bboxMm: HolderSpec['bboxMm'];
  readonly fitsTool?: HolderSpec['fitsTool'];
}

// Only the demo build ships these models; the daemon serves its own. `--force` (bun run tools:demo-assets) writes them anyway.
if (process.env['VITE_HSW_DEMO'] !== '1' && !process.argv.includes('--force')) {
  console.log('tool assets: skipped (not a demo build)');
  process.exit(0);
}
const out = resolve(
  process.argv.find((arg, at) => at >= 2 && !arg.startsWith('--')) ??
    `${import.meta.dir}/../../apps/web/.generated/tools-assets`,
);
const classIds = [
  ...new Set(SHOWCASE_LAYOUT.flatMap((holder) => holder.tools.map((tool) => tool.classId))),
];
// Start from nothing: models of an older generator must not travel into the build.
await rm(out, { recursive: true, force: true });
const index = await new ToolAssetStore(out, undefined, classIds).index();
const bytes = index.entries.reduce((sum, entry) => sum + entry.lod0.size + entry.lod1.size, 0);
console.log(
  `tool assets: ${index.entries.length} classes, ${(bytes / 1e6).toFixed(1)} MB in ${out}`,
);

// The seats are computed on the committed seed bank the demo ships, whatever bank the environment points at.
delete process.env['HSW_BANK_DIR'];
delete process.env['HSW_BANK_USER_DIR'];
// The demo has no daemon to seat the tools: seat them now, on the committed seed bank the demo ships.
const seed: { elements: readonly SeedElement[] } = await Bun.file(
  `${import.meta.dir}/../../packages/bank/seed/index.json`,
).json();
const specs = new Map<string, HolderSpec>(
  seed.elements.map((element) => [
    element.id,
    {
      id: element.id,
      category: element.category,
      fitsTool: element.fitsTool ?? [],
      bboxMm: element.bboxMm,
    },
  ]),
);
const { unhung, seats } = await seatShowcase(SHOWCASE_LAYOUT, specs, index);
if (unhung.length > 0) throw new Error(`demo seats: tools that do not hang: ${unhung.join(', ')}`);
await Bun.write(`${out}/seats.json`, `${JSON.stringify(seats)}\n`);
console.log(
  `demo seats: ${seats.seated} tools seated, ${seats.unchanged} already seated, ${seats.kept.length} without a seat`,
);
