import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HolderSpec } from '@hsw-editor/compat';
import { showcaseToolIndex } from '@/toolmodels/testing.ts';
import { buildShowcaseWall } from './showcase.ts';
import { SHOWCASE_LAYOUT } from './showcaseLayout.ts';

const SEED = resolve(import.meta.dir, '../../../../packages/bank/seed/index.json');

interface SeedElement {
  id: string;
  category: string;
  bboxMm: HolderSpec['bboxMm'];
  fitsTool?: HolderSpec['fitsTool'];
}

function seedSpecs(): Map<string, HolderSpec> {
  const index = JSON.parse(readFileSync(SEED, 'utf8')) as { elements: SeedElement[] };
  return new Map(
    index.elements.map((element) => [
      element.id,
      {
        id: element.id,
        category: element.category,
        fitsTool: element.fitsTool ?? [],
        bboxMm: element.bboxMm,
      },
    ]),
  );
}

const index = showcaseToolIndex(
  SHOWCASE_LAYOUT.flatMap((holder) => holder.tools.map((tool) => tool.classId)),
);

describe('showcase wall', () => {
  const specs = seedSpecs();

  test('every holder of the layout exists in the seed bank', () => {
    for (const holder of SHOWCASE_LAYOUT) expect(specs.has(holder.bankId)).toBe(true);
  });

  test('every tool hangs in its holder', () => {
    const { wall, unhung } = buildShowcaseWall('demo', 'Showcase', SHOWCASE_LAYOUT, specs, index);
    expect(unhung).toEqual([]);
    const tools = wall.items.filter((item) => item.kind === 'tool');
    expect(tools).toHaveLength(SHOWCASE_LAYOUT.reduce((n, holder) => n + holder.tools.length, 0));
    for (const tool of tools) {
      expect(tool.parentId).toBeDefined();
      expect(tool.slot).toBeDefined();
    }
    expect(wall.models).toHaveLength(tools.length);
  });

  test('tools in one holder take different slots', () => {
    const { wall } = buildShowcaseWall('demo', 'Showcase', SHOWCASE_LAYOUT, specs, index);
    const slots = wall.items
      .filter((item) => item.parentId === 'sc-pliers')
      .map((item) => item.slot)
      .sort();
    expect(slots).toEqual([0, 1, 2]);
  });
});
