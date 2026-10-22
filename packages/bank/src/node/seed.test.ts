import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createBank } from '../bank.ts';
import { BankIndexSchema } from '../schema.ts';
import { bankPaths } from './paths.ts';
import { SEED_BUDGET_BYTES } from './seed.ts';

const seed = bankPaths().seedDir;

describe('committed seed', () => {
  test('is licence-clean, small, and answers ru/en queries without any source files', async () => {
    const index = BankIndexSchema.parse(await Bun.file(join(seed, 'index.json')).json());
    expect(index.elements.every((e) => e.license.redistributable)).toBe(true);
    expect(index.elements.some((e) => e.generated)).toBe(true);
    let bytes = 0;
    for (const e of index.elements) {
      for (const a of new Set([e.assets.lod0.path, e.assets.lod1.path, e.assets.thumbnail.path])) {
        bytes += Bun.file(join(seed, a)).size;
      }
    }
    expect(bytes).toBeLessThan(SEED_BUDGET_BYTES);
    const bank = createBank(index, await Bun.file(join(seed, 'search-index.json')).text());
    expect(bank.search('отвертка')[0]?.element.toolClasses).toContain('screwdriver');
    expect(bank.search('screwdriver holder').length).toBeGreaterThan(0);
    expect(bank.search('плоскогубцы').some((r) => r.element.category === 'holders/pliers')).toBe(
      true,
    );
  });
});
