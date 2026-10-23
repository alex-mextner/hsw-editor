/**
 * Fetch-style request handler for the bank routes (see docs/bank.md). Mount it in the server before the
 * app's own routing: it returns `null` for URLs that are not bank routes.
 *
 * Serving rules (they keep a rebuilt or damaged bank from reaching the page as a 404 or as corrupt bytes
 * cached forever):
 * - The index comes from the best usable root: the current generation, else an older one, else the seed.
 *   A root is unusable when its index.json is unreadable or inconsistent; it is then skipped, logged
 *   once and listed in `/api/bank/health`. A root whose index is fine but some elements' files are
 *   missing or truncated is still served, with exactly those elements moved to `unavailable`, so one lost
 *   file costs one element instead of the whole bank.
 * - A hashed asset is served from the first root whose OWN index lists it and whose file has the
 *   recorded size, so names from an index a browser tab fetched earlier keep resolving after a rebuild,
 *   and a truncated copy is never sent under an `immutable` header while an intact copy exists.
 * - Root state is a snapshot re-validated at most every 500 ms (one stat per root), rebuilt only when an
 *   index changed, and shared by concurrent requests (single flight).
 */
import { lstat, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createBank, type Bank, type ElementFilter, type MountingKind } from '../bank.ts';
import { MOUNTING_KINDS, VariantRequestSchema, type BankIndex } from '../schema.ts';
import { bankRoots, currentLink, generationsDir, listGenerations } from './generations.ts';
import { composeIndex, searchIndexJson, withholdBroken } from './compose.ts';
import { buildVariant, VariantError } from './variant.ts';
import { firstProblemByElement, formatIssue, verifyBank, type VerifyIssue } from './verify.ts';
import type { BankPaths } from './paths.ts';

// the extension is bound to the kind: GLB models under glb/ and variant/, WebP thumbnails under thumb/
const ASSET_PATH =
  /^\/bank\/assets\/((?:(?:glb|variant)\/[0-9a-f]{16}\.glb)|(?:thumb\/[0-9a-f]{16}\.webp))$/;
const ELEMENT_PATH = /^\/api\/bank\/elements\/([a-z0-9-]+)(\/variant)?$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Root state is re-validated at most this often (one stat per root). */
const CHECK_INTERVAL_MS = 500;
/** An unusable root is re-verified this often, so files restored by hand heal it without a restart. */
const REJECTED_RETRY_MS = 5000;
/** A request that proves the served root is damaged forces a rebuild, but at most this often. */
const DIRTY_MIN_INTERVAL_MS = 2000;
/** `?deep=1` results are reused this long: it hashes and decodes the whole bank. */
const DEEP_TTL_MS = 30_000;

export interface BankHandlerOptions {
  paths: BankPaths;
  /**
   * Fixed list of roots searched in order (tests, tools). By default the roots follow the generation
   * store of `paths.bankDir`: current generation, older generations, the bank dir, the seed.
   */
  roots?: string[];
  /** Re-validate the root snapshot at most this often (ms); 0 = on every request. Default 500. */
  revalidateMs?: number;
}

interface Served {
  root: string;
  bank: Bank;
  etag: string;
  /** Hash of the served view: the ETag. Differs from `indexHash` when elements are withheld. */
  contentHash: string;
  /** `contentHash` of the index.json on disk (what the generation id and `bank:verify` carry). */
  indexHash: string;
  /** Asset paths the served index lists (withheld elements excluded). */
  paths: ReadonlySet<string>;
  searchJson: string | undefined;
  /** Elements of this root left out of the served index because their files are damaged. */
  withheld: { id: string; reason: string }[];
}

/** A root that cannot be served at all (unreadable or inconsistent index). */
interface Rejected {
  root: string;
  problems: string[];
}

interface RootState {
  root: string;
  /** Asset path -> recorded bytes, from this root's own index; null when it has no readable index. */
  sizes: ReadonlyMap<string, number> | null;
}

interface Snapshot {
  roots: RootState[];
  served: Served | null;
  /** Unusable roots ranked above the served one (or all of them when nothing can be served). */
  rejected: Rejected[];
  /** Damaged roots ranked below the served one: only the retention of old asset names is affected. */
  retained: Rejected[];
  signature: string;
  checkedAt: number;
  rebuiltAt: number;
  /** The first root with an index.json could not be read or verified (torn write, damage, a failed read). */
  decidingUnreadable: boolean;
}

function isMountingKind(value: string): value is MountingKind {
  return (MOUNTING_KINDS as readonly string[]).includes(value);
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });
}

const indexHashHeader = (hash: string | undefined): Record<string, string> =>
  hash ? { 'x-bank-index-hash': hash } : {};

function sizesOf(index: BankIndex): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const { assets } of index.elements)
    for (const asset of [assets.lod0, assets.lod1, assets.thumbnail])
      sizes.set(asset.path, asset.bytes);
  return sizes;
}

/** Identity of every root's index.json: changes when a generation is published, replaced or removed. */
async function signatureOf(roots: string[]): Promise<string> {
  const infos = await Promise.all(
    roots.map((root) => stat(join(root, 'index.json')).catch(() => null)),
  );
  return roots
    .map((root, i) => {
      const info = infos[i];
      return `${root}:${info ? `${info.ino}:${info.mtimeMs}:${info.size}` : 'none'}`;
    })
    .join('|');
}

/** Index served for a root with damaged files: the broken elements move to `unavailable`. */
function withheldView(index: BankIndex, broken: ReadonlyMap<string, string>): BankIndex {
  const { grid, categories, toolClasses, elements, unavailable } = index;
  return composeIndex(
    withholdBroken(
      { grid, categories, toolClasses, elements, ...(unavailable ? { unavailable } : {}) },
      broken,
    ),
  );
}

async function serveRoot(
  root: string,
  index: BankIndex,
  broken: ReadonlyMap<string, string>,
): Promise<Served> {
  const withheld = [...broken].map(([id, reason]) => ({ id, reason }));
  const view = broken.size > 0 ? withheldView(index, broken) : index;
  const searchJson =
    broken.size > 0
      ? searchIndexJson(view)
      : await Bun.file(join(root, 'search-index.json'))
          .text()
          .catch(() => undefined);
  return {
    root,
    bank: createBank(view, searchJson),
    etag: `"${view.contentHash}"`,
    contentHash: view.contentHash,
    indexHash: index.contentHash,
    paths: new Set(sizesOf(view).keys()),
    searchJson,
    withheld,
  };
}

type LogOnce = (root: string, message: string) => void;

/** Verifies every root with an index; the first usable one is served, the others only supply assets. */
async function rebuild(roots: string[], signature: string, logOnce: LogOnce): Promise<Snapshot> {
  const states: RootState[] = [];
  const rejected: Rejected[] = [];
  const retained: Rejected[] = [];
  let served: Served | null = null;
  let decidingUnreadable = false;
  let decided = false;
  for (const root of roots) {
    if (!(await stat(join(root, 'index.json')).catch(() => null))) {
      states.push({ root, sizes: null });
      continue;
    }
    const check = await verifyBank(root, { quick: true });
    states.push({ root, sizes: check.index ? sizesOf(check.index) : null });
    const indexProblem = check.issues.find((i) => i.kind === 'index');
    const broken = firstProblemByElement(check.issues);
    const damage = { root, problems: check.problems };
    if (!decided) {
      decided = true;
      decidingUnreadable = !check.index || indexProblem !== undefined;
    }
    if (!check.index || indexProblem) {
      logOnce(root, `not serving: ${check.problems[0] ?? 'unreadable index'}`);
      (served ? retained : rejected).push(damage);
      continue;
    }
    if (broken.size > 0) {
      logOnce(root, `${broken.size} elements withheld, first: ${check.problems[0]}`);
      if (served) retained.push(damage);
    }
    if (served) continue;
    try {
      served = await serveRoot(root, check.index, broken);
    } catch (error) {
      const reason = `cannot build the served view: ${error instanceof Error ? error.message : String(error)}`;
      logOnce(root, `not serving: ${reason}`);
      rejected.push({ root, problems: [reason] });
    }
  }
  const now = Date.now();
  return {
    roots: states,
    served,
    rejected,
    retained,
    signature,
    checkedAt: now,
    rebuiltAt: now,
    decidingUnreadable,
  };
}

export function createBankHandler(
  options: BankHandlerOptions,
): (request: Request) => Promise<Response | null> {
  const revalidateMs = options.revalidateMs ?? CHECK_INTERVAL_MS;
  let snap: Snapshot | null = null;
  let pending: Promise<Snapshot> | null = null;
  /** Set when a request found proof that the served root is damaged (a promised file is gone/truncated). */
  let dirty = false;
  let rootsCache: { key: string; roots: string[] } | null = null;
  /** Problems already logged, so a root that stays damaged is reported once, not on every rebuild. */
  const logged = new Set<string>();
  const logOnce: LogOnce = (root, message) => {
    const key = `${root}|${message}`;
    if (logged.has(key)) return;
    logged.add(key);
    console.error(`bank: ${root}: ${message}`);
  };
  let deepCache: { key: string; at: number; pending: Promise<VerifyIssue[]> } | null = null;

  /** Roots in serving order; recomputed only when `current` or the generations directory changed. */
  async function roots(): Promise<string[]> {
    if (options.roots) return options.roots;
    const [link, generations] = await Promise.all([
      lstat(currentLink(options.paths)).catch(() => null),
      stat(generationsDir(options.paths)).catch(() => null),
    ]);
    const key = `${link?.ino ?? 'none'}:${link?.mtimeMs ?? 'none'}:${generations?.mtimeMs ?? 'none'}`;
    if (rootsCache?.key !== key) rootsCache = { key, roots: await bankRoots(options.paths) };
    return rootsCache.roots;
  }

  /** Current root state; concurrent callers share one validation (single flight). */
  function snapshot(): Promise<Snapshot> {
    if (pending) return pending;
    if (snap && !dirty && Date.now() - snap.checkedAt < revalidateMs) return Promise.resolve(snap);
    pending = (async () => {
      const list = await roots();
      const signature = await signatureOf(list);
      const previous = snap;
      const age = previous ? Date.now() - previous.rebuiltAt : Number.POSITIVE_INFINITY;
      // A request that proved damage forces a rebuild, but never more often than DIRTY_MIN_INTERVAL_MS.
      const forced = dirty && age > DIRTY_MIN_INTERVAL_MS;
      if (forced) dirty = false;
      const stale =
        previous === null ||
        previous.signature !== signature ||
        (previous.rejected.length > 0 && age > REJECTED_RETRY_MS) ||
        forced;
      const rebuilt = previous === null || stale;
      const next = rebuilt
        ? await rebuild(list, signature, logOnce)
        : { ...previous, checkedAt: Date.now() };
      // The first root with an index decides. When its index cannot be read or verified (an ingest
      // mid-write, a failed read, damage) the bank already in use stays instead of a shrunken older root
      // or the seed taking over; a fresh process with no bank in use falls through to the next root.
      snap =
        rebuilt && next.decidingUnreadable && previous?.served
          ? {
              ...previous,
              rejected: next.rejected,
              // the real signature: a rewrite (torn write finished, restored copy) triggers a rebuild at
              // once; while it stays unreadable it is retried every REJECTED_RETRY_MS, not on every request
              signature,
              rebuiltAt: Date.now(),
              checkedAt: Date.now(),
            }
          : next;
      return snap;
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  /** First root whose own index lists the asset and whose file has the recorded size. */
  async function locate(state: Snapshot, relative: string): Promise<string | null> {
    if (relative.startsWith('variant/')) {
      // Variants are written atomically (temp file + rename) beside the bank and are not listed in an index.
      const file = join(options.paths.bankDir, relative);
      return (await Bun.file(file).exists()) ? file : null;
    }
    for (const { root, sizes } of state.roots) {
      const expected = sizes?.get(relative);
      if (expected === undefined) continue;
      const file = join(root, relative);
      const info = await stat(file).catch(() => null);
      if (info?.size === expected) return file;
      // Present but truncated/replaced in the root being served: re-validate (debounced) so it is reported.
      if (info && root === state.served?.root && state.served.paths.has(relative)) dirty = true;
    }
    return null;
  }

  /** `GET /api/bank/health[?deep=1]`: which bank is served and whether it is intact (smoke checks). */
  async function health(url: URL, state: Snapshot): Promise<Response> {
    const served = state.served;
    const deep = url.searchParams.get('deep') === '1';
    const issues = served && deep ? await deepIssues(served) : [];
    const generations = options.roots
      ? []
      : (await listGenerations(options.paths)).map((g) => g.id);
    const index = served?.bank.index;
    return json(
      {
        ok:
          served !== null &&
          served.withheld.length === 0 &&
          state.rejected.length === 0 &&
          issues.length === 0,
        served: served
          ? {
              root: served.root,
              generation: basename(served.root),
              contentHash: served.contentHash,
              indexHash: served.indexHash,
            }
          : null,
        elements: index?.elements.length ?? 0,
        unavailable: index?.unavailable?.length ?? 0,
        withheld: served?.withheld ?? [],
        generations,
        rejected: state.rejected,
        retainedDamaged: state.retained,
        ...(deep ? { deep: { problems: issues.slice(0, 50).map(formatIssue) } } : {}),
      },
      { status: served ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  /** Full verification (hashes + GLB bounds) of the served bank, shared and cached for a short time. */
  function deepIssues(served: Served): Promise<VerifyIssue[]> {
    const key = `${served.root}|${served.contentHash}`;
    if (deepCache?.key === key && Date.now() - deepCache.at < DEEP_TTL_MS) return deepCache.pending;
    const pending = verifyBank(served.root).then((result) => result.issues);
    deepCache = { key, at: Date.now(), pending };
    return pending;
  }

  return async (request) => {
    const url = new URL(request.url);
    const { pathname } = url;
    if (!pathname.startsWith('/api/bank/') && !pathname.startsWith('/bank/assets/')) return null;

    const elementMatch = ELEMENT_PATH.exec(pathname);
    const isVariant = elementMatch?.[2] !== undefined;
    const readRoute =
      !isVariant &&
      (ASSET_PATH.test(pathname) ||
        elementMatch !== null ||
        pathname === '/api/bank/index' ||
        pathname === '/api/bank/search-index' ||
        pathname === '/api/bank/search' ||
        pathname === '/api/bank/health');
    if (readRoute && request.method !== 'GET' && request.method !== 'HEAD')
      return json({ error: 'use GET' }, { status: 405, headers: { allow: 'GET, HEAD' } });
    if (isVariant && request.method !== 'POST')
      return json({ error: 'use POST' }, { status: 405, headers: { allow: 'POST' } });

    const state = await snapshot();
    const served = state.served;
    const asset = ASSET_PATH.exec(pathname);
    if (asset) {
      const relative = asset[1] ?? '';
      const indexHash = served?.contentHash;
      const file = await locate(state, relative);
      if (file)
        return new Response(Bun.file(file), {
          headers: { 'cache-control': IMMUTABLE, ...indexHashHeader(indexHash) },
        });
      const promised = served?.paths.has(relative) === true;
      if (served && promised) {
        // The served index itself points at a file that is gone: re-validate (debounced) so the
        // element is withheld or a healthy older generation takes over.
        logOnce(served.root, `references missing asset ${relative}`);
        dirty = true;
      }
      return json(
        {
          error: 'asset_not_found',
          referencedByIndex: promised,
          path: relative,
          indexHash: indexHash ?? null,
          message: `bank asset ${relative} is not in any bank generation on this server`,
          hint: 'the bank was rebuilt after your index was fetched; reload /api/bank/index and use the new asset paths',
        },
        {
          status: 404,
          headers: { 'cache-control': 'no-store', ...indexHashHeader(indexHash) },
        },
      );
    }

    if (pathname === '/api/bank/health') return health(url, state);
    if (!served)
      return json(
        state.rejected.length > 0
          ? { error: 'bank_inconsistent', rejected: state.rejected }
          : { error: 'bank not built: run `bun run bank:ingest` or restore packages/bank/seed' },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      );
    const { bank: data, etag, contentHash } = served;

    if (pathname === '/api/bank/index' || pathname === '/api/bank/search-index') {
      if (request.headers.get('if-none-match') === etag)
        return new Response(null, { status: 304, headers: { etag } });
      const headers = {
        etag,
        'cache-control': 'no-cache',
        'content-type': 'application/json; charset=utf-8',
        'x-bank-index-hash': contentHash,
      };
      if (pathname === '/api/bank/index')
        return new Response(JSON.stringify(data.index), { headers });
      if (served.searchJson === undefined)
        return json({ error: 'no search index built' }, { status: 404 });
      return new Response(served.searchJson, { headers });
    }

    if (pathname === '/api/bank/search') {
      const q = url.searchParams.get('q') ?? '';
      const filter: ElementFilter = {};
      const category = url.searchParams.get('category');
      const tool = url.searchParams.get('tool');
      const mounting = url.searchParams.get('mounting');
      if (category) filter.category = category;
      if (tool) filter.toolClass = tool;
      if (mounting) {
        if (!isMountingKind(mounting))
          return json({ error: `unknown mounting ${mounting}` }, { status: 400 });
        filter.mounting = mounting;
      }
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
      const results = data.search(q, filter, limit).map(({ id, score }) => ({ id, score }));
      return json({ results });
    }

    const element = ELEMENT_PATH.exec(pathname);
    if (element) {
      const found = data.getElement(element[1] ?? '');
      if (!found) {
        const withheld = data.index.unavailable?.find((u) => u.id === element[1]);
        return withheld
          ? json(
              { error: 'element_unavailable', id: withheld.id, reason: withheld.reason },
              { status: 404 },
            )
          : json({ error: 'unknown element' }, { status: 404 });
      }
      if (!element[2]) return json(found);
      const body = VariantRequestSchema.safeParse(await request.json().catch(() => null));
      if (!body.success)
        return json({ error: 'body must be { params: { key: number } }' }, { status: 400 });
      try {
        return json(await buildVariant(options.paths, found, body.data.params));
      } catch (error) {
        if (error instanceof VariantError)
          return json({ error: error.message }, { status: error.status });
        throw error;
      }
    }
    return json({ error: 'unknown bank route' }, { status: 404 });
  };
}
