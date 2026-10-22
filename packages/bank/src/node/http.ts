/**
 * Fetch-style request handler for the bank routes (see docs/bank.md). Mount it in the server before the
 * app's own routing: it returns `null` for URLs that are not bank routes.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createBank, type Bank, type ElementFilter, type MountingKind } from '../bank.ts';
import { BankIndexSchema, MOUNTING_KINDS, VariantRequestSchema } from '../schema.ts';
import { buildVariant, VariantError } from './variant.ts';
import type { BankPaths } from './paths.ts';

// the extension is bound to the kind: GLB models under glb/ and variant/, WebP thumbnails under thumb/
const ASSET_PATH =
  /^\/bank\/assets\/((?:(?:glb|variant)\/[0-9a-f]{16}\.glb)|(?:thumb\/[0-9a-f]{16}\.webp))$/;
const ELEMENT_PATH = /^\/api\/bank\/elements\/([a-z0-9-]+)(\/variant)?$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

interface Loaded {
  bank: Bank;
  etag: string;
  /** mtimes of every root's index.json when this bank was chosen (see `stampOf`). */
  stamp: string;
  searchJson: string | undefined;
}

export interface BankHandlerOptions {
  /** Directories searched in order for index.json: the built bank first, the committed seed after. */
  roots: string[];
  paths: BankPaths;
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

/** mtime and size of each root's index.json: changes when a built bank appears, is replaced, or is removed. */
async function stampOf(roots: string[]): Promise<string> {
  const stamps = await Promise.all(
    roots.map(async (root) => {
      const info = await stat(join(root, 'index.json')).catch(() => null);
      return info ? `${info.mtimeMs}:${info.size}` : '-';
    }),
  );
  return stamps.join(',');
}

async function loadRoot(root: string, stamp: string): Promise<Loaded | null> {
  try {
    const index = BankIndexSchema.parse(await Bun.file(join(root, 'index.json')).json());
    const searchFile = Bun.file(join(root, 'search-index.json'));
    const searchJson = (await searchFile.exists()) ? await searchFile.text() : undefined;
    return {
      bank: createBank(index, searchJson),
      etag: `"${index.contentHash}"`,
      stamp,
      searchJson,
    };
  } catch {
    return null; // missing, half-written or invalid
  }
}

/**
 * The first root that has an index.json decides: when it cannot be read, no later root (the seed) takes
 * over silently; the caller keeps the bank in use instead. A root without index.json is skipped.
 */
async function loadFrom(
  roots: string[],
  stamp: string,
): Promise<{ root: string; loaded: Loaded | null } | null> {
  for (const root of roots) {
    if (!(await stat(join(root, 'index.json')).catch(() => null))) continue;
    return { root, loaded: await loadRoot(root, stamp) };
  }
  return null;
}

export function createBankHandler(
  options: BankHandlerOptions,
): (request: Request) => Promise<Response | null> {
  let current: { root: string; loaded: Loaded } | null = null;

  /**
   * Reloads when any root's index.json changed on disk (a new ingest, or a built bank appearing after
   * the seed was loaded) so the server needs no restart. When the new files cannot be loaded (an ingest
   * is mid-write) the bank in use stays.
   */
  async function bank(): Promise<{ root: string; loaded: Loaded } | null> {
    const stamp = await stampOf(options.roots);
    if (current && current.loaded.stamp === stamp) return current;
    const next = await loadFrom(options.roots, stamp);
    if (next?.loaded) current = { root: next.root, loaded: next.loaded };
    // A failed load keeps the stamp stale on purpose so the next request retries (an ingest mid-write).
    return current;
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
        pathname === '/api/bank/search');
    if (readRoute && request.method !== 'GET' && request.method !== 'HEAD')
      return json({ error: 'use GET' }, { status: 405, headers: { allow: 'GET, HEAD' } });
    if (isVariant && request.method !== 'POST')
      return json({ error: 'use POST' }, { status: 405, headers: { allow: 'POST' } });

    const asset = ASSET_PATH.exec(pathname);
    if (asset) {
      const relative = asset[1] ?? '';
      for (const root of options.roots) {
        const file = Bun.file(join(root, relative));
        if (await file.exists())
          return new Response(file, { headers: { 'cache-control': IMMUTABLE } });
      }
      return json({ error: 'asset not found' }, { status: 404 });
    }

    const state = await bank();
    if (!state)
      return json(
        { error: 'bank not built: run `bun run bank:ingest` or restore packages/bank/seed' },
        { status: 503 },
      );
    const { bank: data, etag } = state.loaded;

    if (pathname === '/api/bank/index' || pathname === '/api/bank/search-index') {
      if (request.headers.get('if-none-match') === etag)
        return new Response(null, { status: 304, headers: { etag } });
      const headers = {
        etag,
        'cache-control': 'no-cache',
        'content-type': 'application/json; charset=utf-8',
      };
      if (pathname === '/api/bank/index')
        return new Response(JSON.stringify(data.index), { headers });
      if (state.loaded.searchJson === undefined)
        return json({ error: 'no search index built' }, { status: 404 });
      return new Response(state.loaded.searchJson, { headers });
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

    if (elementMatch) {
      const found = data.getElement(elementMatch[1] ?? '');
      if (!found) return json({ error: 'unknown element' }, { status: 404 });
      if (!isVariant) return json(found);
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
