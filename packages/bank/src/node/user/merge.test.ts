/** The served index = built bank + user tree: merge, assets, search, invalidation, damage isolation. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BankElement, BankIndex } from '../../schema.ts';
import { composeIndex } from '../compose.ts';
import { createBankHandler, type BankHandler } from '../http.ts';
import { BANK_CATEGORIES } from '../../categories.ts';
import { TOOL_CLASSES } from '../../toolClasses.ts';
import type { BankPaths } from '../paths.ts';
import { writeIndexFiles } from '../publish.ts';
import { createScratch, writeFixtureBank, type Scratch } from '../tmpbank.ts';
import { mergeUserElements } from './merge.ts';

let work: string;
let paths: BankPaths;
let userRoot: string;
let publishFixture: Scratch['publishFixture'];

beforeEach(async () => {
  const scratch = await createScratch();
  ({ work, paths, publishFixture } = scratch);
  userRoot = join(work, 'bank-user');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const get = (handler: BankHandler, path: string): Promise<Response | null> =>
  handler(new Request(`http://localhost${path}`));

async function json<T>(response: Response | null): Promise<T> {
  if (response === null) throw new Error('route not handled');
  return (await response.json()) as T;
}

/** A user tree in the format the store writes: fixture bank elements marked `source: 'user'`. */
async function writeUserTree(ids: string[]): Promise<BankElement[]> {
  const built = await writeFixtureBank(userRoot, ids, {
    specs: Object.fromEntries(
      ids.map((id) => [
        id,
        { ru: `Мой ${id}`, en: `My ${id}`, tagsEn: ['custom'], category: 'holders' },
      ]),
    ),
  });
  const elements = built.map((b) => ({ ...b.element, source: 'user' as const }));
  await writeIndexFiles(
    userRoot,
    composeIndex({
      grid: paths.grid,
      categories: [...BANK_CATEGORIES],
      toolClasses: [...TOOL_CLASSES],
      elements,
    }),
  );
  return elements;
}

describe('mergeUserElements', () => {
  test('recomputes counts and the hash; a base id wins a clash; nothing to merge returns the base', async () => {
    const built = await publishFixture(['a', 'b'], 1);
    const base = composeIndex({
      grid: paths.grid,
      categories: [...BANK_CATEGORIES],
      toolClasses: [...TOOL_CLASSES],
      elements: built.built.map((b) => b.element),
    });
    expect(mergeUserElements(base, [], [])).toBe(base);
    const mine = { ...built.built[0]!.element, id: 'my-a', source: 'user' as const };
    const merged = mergeUserElements(base, [mine, { ...mine, id: 'b' }], []);
    expect(merged.elements.map((e) => e.id)).toEqual(['a', 'b', 'my-a']);
    expect(merged.counts.total).toBe(3);
    expect(merged.contentHash).not.toBe(base.contentHash);
    expect(merged.elements.find((e) => e.id === 'b')?.source).toBeUndefined();
  });
});

describe('the bank handler with a user tree', () => {
  test('the index lists user elements with source user; the bank without a user tree is unchanged', async () => {
    await publishFixture(['a', 'b'], 1);
    const plain = createBankHandler({ paths, revalidateMs: 0 });
    const plainIndex = await json<BankIndex>(await get(plain, '/api/bank/index'));
    await writeUserTree(['my-hook', 'my-bin']);
    const handler = createBankHandler({ paths, revalidateMs: 0, userRoot });
    const index = await json<BankIndex>(await get(handler, '/api/bank/index'));
    expect(index.elements.map((e) => e.id)).toEqual(['a', 'b', 'my-hook', 'my-bin']);
    expect(index.elements.filter((e) => e.source === 'user').map((e) => e.id)).toEqual([
      'my-hook',
      'my-bin',
    ]);
    expect(index.counts.total).toBe(4);
    expect(plainIndex.elements.map((e) => e.id)).toEqual(['a', 'b']);
    const response = await get(handler, '/api/bank/index');
    expect(response?.headers.get('etag')).toBe(`"${index.contentHash}"`);
    expect(index.contentHash).not.toBe(plainIndex.contentHash);
    // an empty user tree changes nothing (same ETag as a bank without one)
    const empty = createBankHandler({ paths, revalidateMs: 0, userRoot: join(work, 'nothing') });
    expect((await json<BankIndex>(await get(empty, '/api/bank/index'))).contentHash).toBe(
      plainIndex.contentHash,
    );
  });

  test('user assets are served immutable, search and element routes find user elements', async () => {
    await publishFixture(['a'], 1);
    const [mine] = await writeUserTree(['my-hook']);
    const handler = createBankHandler({ paths, revalidateMs: 0, userRoot });
    const glb = await get(handler, `/bank/assets/${mine!.assets.lod0.path}`);
    expect(glb?.status).toBe(200);
    expect(glb?.headers.get('cache-control')).toContain('immutable');
    expect((await get(handler, `/bank/assets/${mine!.assets.thumbnail.path}`))?.status).toBe(200);
    const search = await json<{ results: { id: string }[] }>(
      await get(handler, '/api/bank/search?q=custom'),
    );
    expect(search.results.map((r) => r.id)).toEqual(['my-hook']);
    const ru = await json<{ results: { id: string }[] }>(
      await get(handler, `/api/bank/search?q=${encodeURIComponent('Мой')}`),
    );
    expect(ru.results.map((r) => r.id)).toContain('my-hook');
    const one = await json<BankElement>(await get(handler, '/api/bank/elements/my-hook'));
    expect(one.source).toBe('user');
    const searchIndex = await get(handler, '/api/bank/search-index');
    expect(searchIndex?.headers.get('etag')).toBe(
      (await get(handler, '/api/bank/index'))?.headers.get('etag'),
    );
  });

  test('a change of the user tree shows up after invalidate(), and with revalidation on every request', async () => {
    await publishFixture(['a'], 1);
    await writeUserTree(['my-one']);
    const handler = createBankHandler({ paths, revalidateMs: 60_000, userRoot });
    const before = await json<BankIndex>(await get(handler, '/api/bank/index'));
    expect(before.elements.map((e) => e.id)).toEqual(['a', 'my-one']);
    await writeUserTree(['my-one', 'my-two']);
    // within the revalidation window the snapshot is trusted...
    expect((await json<BankIndex>(await get(handler, '/api/bank/index'))).elements).toHaveLength(2);
    // ...until the writer says it changed
    handler.invalidate();
    const after = await json<BankIndex>(await get(handler, '/api/bank/index'));
    expect(after.elements.map((e) => e.id)).toEqual(['a', 'my-one', 'my-two']);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  test('a user element with a lost file is withheld on its own; the bank and the other user elements keep serving', async () => {
    await publishFixture(['a'], 1);
    const [first, second] = await writeUserTree(['my-one', 'my-two']);
    await rm(join(userRoot, first!.assets.lod0.path));
    const handler = createBankHandler({ paths, revalidateMs: 0, userRoot });
    const index = await json<BankIndex>(await get(handler, '/api/bank/index'));
    expect(index.elements.map((e) => e.id)).toEqual(['a', second!.id]);
    expect(index.unavailable?.map((u) => u.id)).toEqual([first!.id]);
    const health = await json<{
      ok: boolean;
      user: { elements: number; withheld: { id: string }[] };
    }>(await get(handler, '/api/bank/health'));
    expect(health.user.elements).toBe(1);
    expect(health.user.withheld.map((w) => w.id)).toEqual([first!.id]);
    expect((await get(handler, '/api/bank/elements/my-one'))?.status).toBe(404);
  });

  test('a corrupt user index serves the bank alone and says why in health', async () => {
    await publishFixture(['a'], 1);
    await writeUserTree(['my-one']);
    await Bun.write(join(userRoot, 'index.json'), '{ broken');
    const handler = createBankHandler({ paths, revalidateMs: 0, userRoot });
    const index = await json<BankIndex>(await get(handler, '/api/bank/index'));
    expect(index.elements.map((e) => e.id)).toEqual(['a']);
    const health = await json<{ ok: boolean; user: { problems: string[] } }>(
      await get(handler, '/api/bank/health'),
    );
    expect(health.ok).toBe(true);
    expect(health.user.problems.length).toBeGreaterThan(0);
  });
});
