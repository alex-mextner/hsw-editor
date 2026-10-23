/**
 * Routes of the tool model asset store (`ToolAssetStore`, docs/tools.md#tool-models-on-the-wall):
 *
 *   GET|HEAD /tools/assets/glb/<16 hex>.glb   immutable GLB bytes (the name is the content hash)
 *   GET      /api/tools/assets/index          the index (ETag = its content hash)
 *   GET      /api/tools/assets/health[?deep=1]
 *
 * Same contract as the bank's `/bank/assets/*`: a name the store cannot serve is a 404 `asset_not_found` with the index
 * hash and a hint, never an HTML fallback, so the service worker cannot cache a wrong body under an immutable URL.
 */
import { TOOL_ASSET_PATH, type ToolAssetIndex } from '@hsw-editor/tools';
import type { ToolAssetStore } from '@hsw-editor/tools/node';

const FILE_PREFIX = '/tools/assets/';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra } });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: { code: 'method_not_allowed', message: `only ${allow} here` } }, 405, {
    allow,
  });
}

function notFound(path: string, index: ToolAssetIndex | null): Response {
  const listed =
    index?.entries.some((entry) => entry.lod0.path === path || entry.lod1.path === path) ?? false;
  return json(
    {
      error: 'asset_not_found',
      path,
      indexHash: index?.contentHash ?? null,
      referencedByIndex: listed,
      message: listed
        ? 'The index lists this file but it is missing or damaged; the store is rebuilding it.'
        : 'No tool model has this name: it belongs to an older revision of a tool or class.',
      hint: 'Reload /api/tools/assets/index and use the paths it lists.',
    },
    404,
    index ? { 'x-tools-index-hash': index.contentHash } : {},
  );
}

/** `If-None-Match` per RFC 9110: `*`, or a comma-separated list of entity tags compared weakly. */
function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header
    .split(',')
    .some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag);
}

/** Null when `request` is not for the asset store. */
export async function handleToolAssets(
  request: Request,
  store: ToolAssetStore,
): Promise<Response | null> {
  const { pathname, searchParams } = new URL(request.url);
  if (pathname.startsWith(FILE_PREFIX)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
    const path = pathname.slice(FILE_PREFIX.length);
    const file = TOOL_ASSET_PATH.test(path) ? await store.resolveFile(path) : null;
    // The hot path never waits for the index build: the header carries the hash of the index served last, and only a miss reads the index.
    if (!file) return notFound(path, await store.index().catch(() => null));
    const indexHash = store.peekIndexHash();
    return new Response(request.method === 'HEAD' ? null : Bun.file(file.path), {
      headers: {
        'content-type': 'model/gltf-binary',
        'content-length': String(file.size),
        'cache-control': IMMUTABLE,
        ...(indexHash === null ? {} : { 'x-tools-index-hash': indexHash }),
      },
    });
  }
  if (pathname === '/api/tools/assets/index') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const index = await store.index();
    const etag = `"${index.contentHash}"`;
    const headers = {
      'cache-control': 'no-cache',
      etag,
      'x-tools-index-hash': index.contentHash,
    };
    if (matchesEtag(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return Response.json(index, { headers });
  }
  if (pathname === '/api/tools/assets/health') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const health = await store.health(searchParams.get('deep') === '1');
    return json(health, health.ok ? 200 : 503);
  }
  return null;
}
