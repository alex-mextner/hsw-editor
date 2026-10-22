import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBank } from '../bank.ts';
import { BankIndexSchema } from '../schema.ts';
import { bankPaths } from './paths.ts';
import { makeElement, makeIndex } from '../testing.ts';
import { exportSeed, SEED_BUDGET_BYTES } from './seed.ts';

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

describe('exportSeed', () => {
  test('an over-budget export fails and leaves the existing seed untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bank-seed-'));
    const paths = { ...bankPaths(), bankDir: join(root, 'bank'), seedDir: join(root, 'seed') };
    await mkdir(join(paths.bankDir, 'glb'), { recursive: true });
    await mkdir(join(paths.bankDir, 'thumb'), { recursive: true });
    await mkdir(paths.seedDir);
    await Bun.write(join(paths.seedDir, 'index.json'), 'previous seed');
    await Bun.write(
      join(paths.bankDir, 'glb/0000000000000000.glb'),
      new Uint8Array(SEED_BUDGET_BYTES),
    );
    await Bun.write(join(paths.bankDir, 'thumb/0000000000000000.webp'), new Uint8Array(10));
    const element = makeElement({ id: 'big', ru: 'Б', en: 'Big', category: 'hooks' });
    await Bun.write(join(paths.bankDir, 'index.json'), JSON.stringify(makeIndex([element])));

    await expect(exportSeed(paths)).rejects.toThrow(/over the/);
    expect(await Bun.file(join(paths.seedDir, 'index.json')).text()).toBe('previous seed');
    expect((await readdir(root)).sort()).toEqual(['bank', 'seed']);
  });
});
