import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratch, writeFixtureBank, type Scratch } from './tmpbank.ts';
import { createBankHandler } from './http.ts';
import type { BankPaths } from './paths.ts';
import { adoptBank } from './publish.ts';

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

type Handler = (request: Request) => Promise<Response | null>;
const get = (handler: Handler, path: string) => handler(new Request(`http://localhost${path}`));

describe('serving across generations (regression: caliper-cradle GLB 404)', () => {
  test('an asset name from the previous index still resolves after a rebuild that dropped the element', async () => {
    const first = await publishFixture(['caliper-cradle', 'elem-a'], 1);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const staleIndex = (await (await get(handler, '/api/bank/index'))!.json()) as {
      elements: { id: string; assets: { lod0: { path: string } } }[];
    };
    const stalePath = staleIndex.elements.find((e) => e.id === 'caliper-cradle')!.assets.lod0.path;
    await publishFixture(['elem-a'], 2); // the rebuild no longer contains the element
    const fresh = (await (await get(handler, '/api/bank/index'))!.json()) as {
      elements: { id: string }[];
    };
    expect(fresh.elements.map((e) => e.id)).toEqual(['elem-a']);
    const stale = await get(handler, `/bank/assets/${stalePath}`);
    expect(stale?.status).toBe(200);
    expect(stale?.headers.get('cache-control')).toContain('immutable');
    expect(stale?.headers.get('x-bank-index-hash')).toMatch(/^[0-9a-f]{64}$/);
    expect(first.built[0]!.glb).toBe(stalePath);
  });

  test('a truly unknown asset answers a diagnosable JSON 404 that is never cached', async () => {
    await publishFixture(['elem-a'], 1);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const response = await get(handler, '/bank/assets/glb/a47bacef44e3f4f4.glb');
    expect(response?.status).toBe(404);
    expect(response?.headers.get('content-type')).toContain('application/json');
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const body = (await response!.json()) as Record<string, unknown>;
    expect(body.error).toBe('asset_not_found');
    expect(body.path).toBe('glb/a47bacef44e3f4f4.glb');
    expect(body.indexHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.referencedByIndex).toBe(false);
  });

  test('a lost file withholds that one element of the current generation; the rest keeps serving', async () => {
    const good = await publishFixture(['elem-a'], 1);
    const bad = await publishFixture(['elem-a', 'elem-b', 'elem-c'], 2);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const before = (await (await get(handler, '/api/bank/index'))!.json()) as {
      elements: unknown[];
    };
    expect(before.elements).toHaveLength(3);
    // the newest generation loses one file after it was published (disk damage, manual cleanup)
    const lost = bad.built.find((b) => b.id === 'elem-b')!;
    await rm(join(paths.bankDir, 'generations', bad.publish.id, lost.glb));
    // a request for that name proves the served root is damaged; the next snapshot withholds the element
    const miss = await get(handler, `/bank/assets/${lost.glb}`);
    expect(miss?.status).toBe(404);
    expect(((await miss!.json()) as { referencedByIndex: boolean }).referencedByIndex).toBe(true);
    const handlerNow = createBankHandler({ paths, revalidateMs: 0 }); // fresh process: loads the damaged root
    const index = (await (await get(handlerNow, '/api/bank/index'))!.json()) as {
      elements: { id: string }[];
      unavailable?: { id: string; reason: string }[];
    };
    expect(index.elements.map((e) => e.id)).toEqual(['elem-a', 'elem-c']);
    expect(index.unavailable?.map((u) => u.id)).toEqual(['elem-b']);
    expect(index.unavailable?.[0]?.reason).toContain(lost.glb);
    // the withheld element's file is no longer "promised" by the served index: a stale client retrying
    // that name must not keep the server revalidating
    const retry = await get(handlerNow, `/bank/assets/${lost.glb}`);
    expect(((await retry!.json()) as { referencedByIndex: boolean }).referencedByIndex).toBe(false);
    const element = await get(handlerNow, '/api/bank/elements/elem-b');
    expect(((await element!.json()) as { error: string }).error).toBe('element_unavailable');
    const search = (await (await get(handlerNow, '/api/bank/search?q=elem'))!.json()) as {
      results: { id: string }[];
    };
    expect(search.results.map((r) => r.id)).not.toContain('elem-b');
    const health = (await (await get(handlerNow, '/api/bank/health'))!.json()) as {
      ok: boolean;
      withheld: { id: string }[];
      rejected: unknown[];
      generations: string[];
    };
    expect(health.ok).toBe(false);
    expect(health.withheld.map((w) => w.id)).toEqual(['elem-b']);
    expect(health.rejected).toEqual([]);
    expect(health.generations).toEqual([bad.publish.id, good.publish.id]);
  });

  test('a current generation with an unreadable index is skipped: the previous generation takes over', async () => {
    const good = await publishFixture(['elem-a'], 1);
    const bad = await publishFixture(['elem-a', 'elem-b'], 2);
    await Bun.write(
      join(paths.bankDir, 'generations', bad.publish.id, 'index.json'),
      '{"version":',
    );
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const index = (await (await get(handler, '/api/bank/index'))!.json()) as {
      elements: { id: string }[];
    };
    expect(index.elements.map((e) => e.id)).toEqual(['elem-a']);
    const health = (await (await get(handler, '/api/bank/health'))!.json()) as {
      ok: boolean;
      served: { root: string };
      rejected: { root: string }[];
    };
    expect(health.ok).toBe(false);
    expect(health.served.root).toContain(good.publish.id);
    expect(health.rejected[0]?.root).toContain(bad.publish.id);
  });

  test('damage in an older retained generation does not make the served bank unhealthy', async () => {
    const old = await publishFixture(['elem-a', 'elem-b'], 1);
    await publishFixture(['elem-a'], 2);
    await rm(join(paths.bankDir, 'generations', old.publish.id, old.built[1]!.thumbnail));
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const health = (await (await get(handler, '/api/bank/health'))!.json()) as {
      ok: boolean;
      retainedDamaged: { root: string }[];
    };
    expect(health.ok).toBe(true);
    expect(health.retainedDamaged[0]?.root).toContain(old.publish.id);
  });

  test('health is ok for an intact bank and deep=1 hashes every file', async () => {
    await publishFixture(['elem-a'], 1);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const body = (await (await get(handler, '/api/bank/health?deep=1'))!.json()) as {
      ok: boolean;
      elements: number;
      deep: { problems: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.elements).toBe(1);
    expect(body.deep.problems).toEqual([]);
  });

  test('an element withheld by the pipeline answers 404 element_unavailable with the reason', async () => {
    const source = join(work, 'src-withheld');
    const built = await writeFixtureBank(source, ['elem-a', 'caliper-cradle']);
    await rm(join(source, built[1]!.glb));
    await adoptBank(paths, source);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const response = await get(handler, '/api/bank/elements/caliper-cradle');
    expect(response?.status).toBe(404);
    expect(((await response!.json()) as { error: string }).error).toBe('element_unavailable');
  });
});

describe('asset lookup never hands out damaged bytes under an immutable header', () => {
  test('a truncated copy in the damaged current generation is skipped in favour of the intact older copy', async () => {
    const good = await publishFixture(['elem-a', 'elem-b'], 1);
    const bad = await publishFixture(['elem-a', 'elem-b', 'elem-c'], 2);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const shared = good.built.find((b) => b.id === 'elem-a')!.glb; // same hashed name in both generations
    const intact = await Bun.file(
      join(paths.bankDir, 'generations', good.publish.id, shared),
    ).bytes();
    await truncate(join(paths.bankDir, 'generations', bad.publish.id, shared), 10);
    const response = await get(handler, `/bank/assets/${shared}`);
    expect(response?.status).toBe(200);
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(intact);
  });

  test('a file that is intact in a damaged generation is still served for clients holding that index', async () => {
    await publishFixture(['elem-a'], 1);
    const bad = await publishFixture(['elem-a', 'elem-b'], 2);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const lost = bad.built.find((b) => b.id === 'elem-a')!;
    const only = bad.built.find((b) => b.id === 'elem-b')!;
    await rm(join(paths.bankDir, 'generations', bad.publish.id, lost.thumbnail)); // generation is damaged
    // elem-b's glb exists only in the damaged generation and is intact there
    const response = await get(handler, `/bank/assets/${only.glb}`);
    expect(response?.status).toBe(200);
  });

  test('concurrent requests share one validation and all succeed', async () => {
    const first = await publishFixture(['elem-a'], 1);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => get(handler, `/bank/assets/${first.built[0]!.glb}`)),
    );
    expect(responses.every((r) => r?.status === 200)).toBe(true);
  });
});

describe('a damaged current generation under a running handler', () => {
  test('the bank in use stays and health lists the damaged root; a fresh process falls back to the previous generation', async () => {
    const good = await publishFixture(['elem-a'], 1);
    const bad = await publishFixture(['elem-a', 'elem-b'], 2);
    const handler = createBankHandler({ paths, revalidateMs: 0 });
    const ids = async (h: Handler): Promise<string[]> =>
      (
        (await (await get(h, '/api/bank/index'))!.json()) as { elements: { id: string }[] }
      ).elements.map((e) => e.id);
    expect(await ids(handler)).toEqual(['elem-a', 'elem-b']);
    await Bun.write(
      join(paths.bankDir, 'generations', bad.publish.id, 'index.json'),
      '{"version":',
    );
    expect(await ids(handler)).toEqual(['elem-a', 'elem-b']); // known-good bank in memory stays
    const health = (await (await get(handler, '/api/bank/health'))!.json()) as {
      ok: boolean;
      rejected: { root: string }[];
    };
    expect(health.ok).toBe(false);
    expect(health.rejected[0]?.root).toContain(bad.publish.id);
    const fresh = createBankHandler({ paths, revalidateMs: 0 });
    expect(await ids(fresh)).toEqual(['elem-a']);
    expect(good.publish.id).toBeDefined();
  });
});
