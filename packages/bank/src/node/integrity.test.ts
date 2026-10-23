import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readlink, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { BankIndexSchema } from '../schema.ts';
import { createScratch, writeFixtureBank, type Scratch } from './tmpbank.ts';
import {
  bankRoots,
  createStaging,
  currentGeneration,
  listGenerations,
  publishGeneration,
  BankVerificationError,
} from './generations.ts';
import type { BankPaths } from './paths.ts';
import {
  adoptBank,
  composeVerified,
  copyInto,
  migrateFlatBank,
  replaceDirectory,
} from './publish.ts';
import { exportSeed } from './seed.ts';
import { verifyBank } from './verify.ts';

let work: string;
let paths: BankPaths;
let publishFixture: Scratch['publishFixture'];

beforeEach(async () => {
  const scratch = await createScratch();
  ({ work, paths, publishFixture } = scratch);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe('verifyBank', () => {
  test('accepts a consistent tree and reports its contentHash', async () => {
    await writeFixtureBank(join(work, 'ok'), ['a-one', 'a-two']);
    const result = await verifyBank(join(work, 'ok'));
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(2);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a deleted glb is reported against the element that needs it', async () => {
    const root = join(work, 'deleted');
    const [first] = await writeFixtureBank(root, ['caliper-cradle', 'other']);
    await rm(join(root, first!.glb));
    const result = await verifyBank(root);
    expect(
      result.issues.some(
        (i) => i.id === 'caliper-cradle' && i.kind === 'missing' && i.path === first!.glb,
      ),
    ).toBe(true);
    expect(result.problems[0]).toContain('missing glb/');
  });

  test('a same-size content change is a hash mismatch; a truncated file is a size mismatch', async () => {
    const root = join(work, 'corrupt');
    const [a, b] = await writeFixtureBank(root, ['elem-a', 'elem-b']);
    const bytes = new Uint8Array(await Bun.file(join(root, a!.glb)).arrayBuffer());
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
    await Bun.write(join(root, a!.glb), bytes);
    await truncate(join(root, b!.glb), 10);
    const kinds = (await verifyBank(root, { bounds: false })).issues.map(
      (i) => `${i.id}:${i.kind}`,
    );
    expect(kinds).toContain('elem-a:hash');
    expect(kinds).toContain('elem-b:size');
    expect(kinds).toContain('elem-b:hash');
  });

  test('quick mode finds missing and truncated files without hashing', async () => {
    const root = join(work, 'quick');
    const [a, b] = await writeFixtureBank(root, ['elem-a', 'elem-b']);
    await rm(join(root, a!.thumbnail));
    await truncate(join(root, b!.glb), 10);
    const kinds = (await verifyBank(root, { quick: true })).issues.map((i) => i.kind).sort();
    expect(kinds).toEqual(['missing', 'size']);
  });

  test('an edited index no longer matches its contentHash', async () => {
    const root = join(work, 'edited');
    await writeFixtureBank(root, ['elem-a']);
    const text = await Bun.file(join(root, 'index.json')).text();
    await Bun.write(join(root, 'index.json'), text.replace('Element elem-a', 'Hacked'));
    const result = await verifyBank(root);
    expect(result.problems.join('\n')).toContain('contentHash');
  });

  test('a missing or unparsable index is an index problem, not an exception', async () => {
    expect((await verifyBank(join(work, 'nothing'))).issues[0]?.kind).toBe('index');
    await mkdir(join(work, 'junk'), { recursive: true });
    await Bun.write(join(work, 'junk/index.json'), '{"version":');
    expect((await verifyBank(join(work, 'junk'))).issues[0]?.kind).toBe('index');
  });
});

describe('generation store', () => {
  test('publishing swaps `current` atomically and keeps previous generations for old index holders', async () => {
    const first = await publishFixture(['elem-a', 'elem-b'], 1);
    const second = await publishFixture(['elem-a', 'elem-c'], 2);
    expect(await readlink(join(paths.bankDir, 'current'))).toBe(`generations/${second.publish.id}`);
    expect((await listGenerations(paths)).map((g) => g.id)).toEqual([
      second.publish.id,
      first.publish.id,
    ]);
    // elem-b disappeared from the index, but its files still resolve through the older generation
    const roots = await bankRoots(paths);
    expect(roots[0]).toBe((await currentGeneration(paths))?.root);
    expect(roots).toContain(join(paths.bankDir, 'generations', first.publish.id));
    const bGlb = first.built.find((b) => b.id === 'elem-b')!.glb;
    expect(await Bun.file(join(roots[1]!, bGlb)).exists()).toBe(true);
  });

  test('retention prunes everything older than the newest N generations', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await publishFixture([`elem-${i}`], i)).publish.id);
    const left = (await listGenerations(paths)).map((g) => g.id);
    expect(left).toEqual([ids[4]!, ids[3]!, ids[2]!]);
  });

  test('republishing identical content is a no-op', async () => {
    const first = await publishFixture(['elem-a'], 1);
    const again = await adoptBank(paths, first.source);
    expect(again.publish.unchanged).toBe(true);
    expect((await listGenerations(paths)).length).toBe(1);
  });

  test('identical content replaces a damaged current generation instead of being skipped', async () => {
    const first = await publishFixture(['elem-a', 'elem-b'], 1);
    const lost = first.built[0]!.glb;
    await rm(join(paths.bankDir, 'generations', first.publish.id, lost));
    const again = await adoptBank(paths, first.source);
    expect(again.publish.unchanged).toBe(false);
    expect(again.publish.id).not.toBe(first.publish.id);
    expect((await currentGeneration(paths))?.id).toBe(again.publish.id);
    expect((await verifyBank((await currentGeneration(paths))!.root)).problems).toEqual([]);
  });

  test('a same-size bit flip in the current generation is repaired by publishing the identical clean content', async () => {
    const first = await publishFixture(['elem-a', 'elem-b'], 1);
    const file = join(paths.bankDir, 'generations', first.publish.id, first.built[0]!.glb);
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
    await Bun.write(file, bytes);
    expect(
      (await verifyBank((await currentGeneration(paths))!.root, { bounds: false })).problems[0],
    ).toContain('content hash mismatch');
    const again = await adoptBank(paths, first.source);
    expect(again.publish.unchanged).toBe(false);
    expect((await verifyBank((await currentGeneration(paths))!.root)).problems).toEqual([]);
  });

  test('a current generation whose index.json is unreadable is replaced, and no staging is leaked', async () => {
    const first = await publishFixture(['elem-a'], 1);
    await Bun.write(join(paths.bankDir, 'generations', first.publish.id, 'index.json'), '');
    const again = await adoptBank(paths, first.source);
    expect(again.publish.unchanged).toBe(false);
    expect((await verifyBank((await currentGeneration(paths))!.root)).problems).toEqual([]);
    const leftovers = (await readdir(join(paths.bankDir, 'generations'))).filter((n) =>
      n.startsWith('.staging-'),
    );
    expect(leftovers).toEqual([]);
  });

  test('one element whose GLB bounds disagree with the index is withheld, not allowed to block the whole adopt', async () => {
    const source = join(work, 'src-drift');
    await writeFixtureBank(source, ['elem-a', 'elem-drifted', 'elem-c'], {
      drift: ['elem-drifted'],
    });
    const { publish, withheld } = await adoptBank(paths, source);
    expect(withheld.map((w) => w.id)).toEqual(['elem-drifted']);
    expect(withheld[0]?.reason).toContain('max.x');
    const root = join(paths.bankDir, 'generations', publish.id);
    const index = BankIndexSchema.parse(await Bun.file(join(root, 'index.json')).json());
    expect(index.elements.map((e) => e.id)).toEqual(['elem-a', 'elem-c']);
    expect((await verifyBank(root)).problems).toEqual([]);
  });

  test('adopting a source whose index was hand-edited is refused outright', async () => {
    const source = join(work, 'src-tampered');
    await writeFixtureBank(source, ['elem-a']);
    const text = await Bun.file(join(source, 'index.json')).text();
    await Bun.write(join(source, 'index.json'), text.replace('Element elem-a', 'Hacked'));
    await expect(adoptBank(paths, source)).rejects.toBeInstanceOf(BankVerificationError);
    expect(await currentGeneration(paths)).toBeNull();
    const staged = (await readdir(join(paths.bankDir, 'generations')).catch(() => [])).filter((n) =>
      n.startsWith('.staging-'),
    );
    expect(staged).toEqual([]);
  });

  test('a staging tree with a missing file is refused: current is untouched and staging is gone', async () => {
    const good = await publishFixture(['elem-a'], 1);
    const staging = await createStaging(paths);
    const built = await writeFixtureBank(join(work, 'src-bad'), ['elem-a', 'elem-z']);
    for (const b of built) {
      await copyInto(staging, b.glb, join(work, 'src-bad', b.glb));
      await copyInto(staging, b.thumbnail, join(work, 'src-bad', b.thumbnail));
    }
    await copyInto(staging, 'index.json', join(work, 'src-bad/index.json'));
    await rm(join(staging, built[1]!.glb)); // the glb of elem-z never arrived
    await expect(publishGeneration(paths, staging)).rejects.toBeInstanceOf(BankVerificationError);
    expect((await currentGeneration(paths))?.id).toBe(good.publish.id);
    expect(await stat(staging).catch(() => null)).toBeNull();
  });

  test('adopting a source with a deleted glb withholds that element instead of publishing it broken', async () => {
    const source = join(work, 'src-partial');
    const built = await writeFixtureBank(source, ['elem-a', 'caliper-cradle']);
    await rm(join(source, built[1]!.glb));
    const { publish, withheld } = await adoptBank(paths, source);
    expect(withheld.map((w) => w.id)).toEqual(['caliper-cradle']);
    expect(withheld[0]?.reason).toContain('missing glb/');
    const root = join(paths.bankDir, 'generations', publish.id);
    const index = BankIndexSchema.parse(await Bun.file(join(root, 'index.json')).json());
    expect(index.elements.map((e) => e.id)).toEqual(['elem-a']);
    expect(index.unavailable?.map((u) => u.id)).toEqual(['caliper-cradle']);
    expect((await verifyBank(root)).problems).toEqual([]);
  });
});

describe('composeVerified (ingest publish step)', () => {
  test('an element whose GLB drifted from its bboxMm is withheld; the rest still publishes', async () => {
    const root = join(work, 'stage');
    const built = await writeFixtureBank(root, ['elem-a', 'elem-drifted'], {
      drift: ['elem-drifted'],
    });
    const source = BankIndexSchema.parse(await Bun.file(join(root, 'index.json')).json());
    const index = await composeVerified(root, {
      grid: source.grid,
      categories: source.categories,
      toolClasses: source.toolClasses,
      elements: built.map((b) => b.element),
    });
    expect(index.elements.map((e) => e.id)).toEqual(['elem-a']);
    expect(index.unavailable?.map((u) => u.id)).toEqual(['elem-drifted']);
    expect((await verifyBank(root)).problems).toEqual([]);
  });
});

describe('migrateFlatBank', () => {
  test('a flat bank from an older ingest becomes the first generation and its flat files go away', async () => {
    const built = await writeFixtureBank(paths.bankDir, ['elem-a', 'elem-b']);
    await mkdir(join(paths.bankDir, 'variant'), { recursive: true });
    await Bun.write(join(paths.bankDir, 'variant/0123456789abcdef.glb'), 'variant');
    expect(await migrateFlatBank(paths)).toBe(true);
    const current = await currentGeneration(paths);
    expect(current).not.toBeNull();
    expect((await verifyBank(current!.root)).problems).toEqual([]);
    expect(await Bun.file(join(current!.root, built[0]!.glb)).exists()).toBe(true);
    for (const flat of ['index.json', 'glb', 'thumb'])
      expect(await stat(join(paths.bankDir, flat)).catch(() => null)).toBeNull();
    expect(await Bun.file(join(paths.bankDir, 'variant/0123456789abcdef.glb')).text()).toBe(
      'variant',
    );
    expect(await migrateFlatBank(paths)).toBe(false);
  });
});

describe('migrateFlatBank with a damaged flat bank', () => {
  test('a flat bank with an unreadable index is moved aside and does not block publishing', async () => {
    await mkdir(paths.bankDir, { recursive: true });
    await Bun.write(join(paths.bankDir, 'index.json'), '{"version":');
    expect(await migrateFlatBank(paths)).toBe(false);
    // moved aside, not deleted: it no longer serves, and the evidence stays
    expect(await Bun.file(join(paths.bankDir, 'index.json')).exists()).toBe(false);
    expect((await readdir(paths.bankDir)).some((n) => n.startsWith('index.json.damaged-'))).toBe(
      true,
    );
    const fresh = await publishFixture(['elem-a'], 1);
    expect((await currentGeneration(paths))?.id).toBe(fresh.publish.id);
  });
});

describe('replaceDirectory', () => {
  test('swaps a finished tree in and drops the old one', async () => {
    await mkdir(join(work, 'target'), { recursive: true });
    await Bun.write(join(work, 'target/old.txt'), 'old');
    await mkdir(join(work, 'next'), { recursive: true });
    await Bun.write(join(work, 'next/new.txt'), 'new');
    await replaceDirectory(join(work, 'next'), join(work, 'target'));
    expect(await Bun.file(join(work, 'target/new.txt')).text()).toBe('new');
    expect(await Bun.file(join(work, 'target/old.txt')).exists()).toBe(false);
    expect((await readdir(work)).filter((n) => n.includes('.old-'))).toEqual([]);
  });

  test('puts the old tree back when the swap fails', async () => {
    await mkdir(join(work, 'target'), { recursive: true });
    await Bun.write(join(work, 'target/old.txt'), 'old');
    await expect(
      replaceDirectory(join(work, 'does-not-exist'), join(work, 'target')),
    ).rejects.toThrow();
    expect(await Bun.file(join(work, 'target/old.txt')).text()).toBe('old');
  });
});

describe('seed export', () => {
  test('a failed export leaves the committed seed untouched', async () => {
    await publishFixture(['elem-a'], 1);
    await mkdir(paths.seedDir, { recursive: true });
    await Bun.write(join(paths.seedDir, 'index.json'), 'previous seed');
    // the built generation loses a file after it was published: exporting from it must fail
    const generation = await currentGeneration(paths);
    const index = BankIndexSchema.parse(
      await Bun.file(join(generation!.root, 'index.json')).json(),
    );
    await rm(join(generation!.root, index.elements[0]!.assets.lod0.path));
    await expect(exportSeed(paths)).rejects.toThrow();
    expect(await Bun.file(join(paths.seedDir, 'index.json')).text()).toBe('previous seed');
    expect((await readdir(work)).filter((n) => n.startsWith('seed.next'))).toEqual([]);
  });

  test('a good export replaces the seed with a tree that verifies', async () => {
    await publishFixture(['elem-a', 'elem-b'], 1);
    await mkdir(paths.seedDir, { recursive: true });
    await Bun.write(join(paths.seedDir, 'stale.txt'), 'x');
    const result = await exportSeed(paths);
    expect(result.elements).toBe(2);
    expect((await verifyBank(paths.seedDir)).problems).toEqual([]);
    expect(await Bun.file(join(paths.seedDir, 'stale.txt')).exists()).toBe(false);
  });
});

describe('bank:verify CLI (the CI / pre-ship gate)', () => {
  const script = join(import.meta.dir, '../../../../scripts/bank/verify.ts');
  async function run(...args: string[]) {
    const proc = Bun.spawn(['bun', script, ...args], {
      env: { ...process.env, HSW_BANK_DIR: paths.bankDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  test('exits 0 for a consistent bank, 1 once a glb is deleted, 1 again for a hash mismatch', async () => {
    const root = join(work, 'cli');
    const [a, b] = await writeFixtureBank(root, ['elem-a', 'elem-b']);
    expect((await run('--root', root)).code).toBe(0);
    await rm(join(root, a!.glb));
    const missing = await run('--root', root);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`elem-a: missing ${a!.glb}`);
    await writeFixtureBank(join(work, 'cli2'), ['elem-a', 'elem-b']);
    const bytes = new Uint8Array(await Bun.file(join(work, 'cli2', b!.glb)).arrayBuffer());
    bytes[bytes.length - 1] = (bytes[bytes.length - 1]! + 1) % 256;
    await Bun.write(join(work, 'cli2', b!.glb), bytes);
    const mismatch = await run('--root', join(work, 'cli2'), '--no-bounds');
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain('content hash mismatch');
  });

  test('exits 3 when nothing was built, and verifies the published generation by default', async () => {
    expect((await run()).code).toBe(3);
    await publishFixture(['elem-a'], 1);
    const ok = await run('--json');
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).ok).toBe(true);
  });
});
