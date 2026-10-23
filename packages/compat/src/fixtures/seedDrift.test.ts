import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import seedProjection from './bank-seed-holders.json';

interface SeedElement {
  id: string;
  category: string;
  fitsTool: unknown;
  bboxMm: unknown;
}

describe('bank-seed-holders.json', () => {
  test('is exactly the projection of the committed bank seed (regenerate with scripts/project-seed.ts)', async () => {
    const index: { elements: SeedElement[] } = await Bun.file(
      join(import.meta.dir, '../../../bank/seed/index.json'),
    ).json();
    const projection = index.elements.map(({ id, category, fitsTool, bboxMm }) => ({
      id,
      category,
      fitsTool,
      bboxMm,
    }));
    // Compared as JSON text: the seed's element type is wider than the fixture's inferred one.
    expect(JSON.stringify(seedProjection)).toBe(JSON.stringify(projection));
  });
});
