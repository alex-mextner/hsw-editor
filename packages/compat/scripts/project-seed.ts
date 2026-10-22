/**
 * Regenerates `src/fixtures/bank-seed-holders.json` from a bank index:
 * `bun packages/compat/scripts/project-seed.ts packages/bank/seed/index.json`.
 * Keeps only what the compatibility maths reads (id, category, fitsTool, bboxMm).
 */
import { resolve } from 'node:path';

const source = process.argv[2];
if (source === undefined) {
  console.error('usage: bun packages/compat/scripts/project-seed.ts <path to bank index.json>');
  process.exit(2);
}

interface Element {
  id: string;
  category: string;
  fitsTool: unknown;
  bboxMm: unknown;
}

const index: { contentHash: string; elements: Element[] } = await Bun.file(resolve(source)).json();
const projection = index.elements.map(({ id, category, fitsTool, bboxMm }) => ({
  id,
  category,
  fitsTool,
  bboxMm,
}));
const target = resolve(import.meta.dir, '../src/fixtures/bank-seed-holders.json');
await Bun.write(target, `${JSON.stringify(projection)}\n`);
console.info(`${projection.length} elements from bank ${index.contentHash} -> ${target}`);
