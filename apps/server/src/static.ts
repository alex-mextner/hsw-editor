/** Static serving of the built web app with cache headers suited to a service-worker PWA. */
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Revalidate on every load so a new deploy (and the service worker script) is picked up immediately. */
const REVALIDATE = 'no-cache';

interface Resolved {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

async function resolveAsset(webDist: string, decoded: string): Promise<Resolved | null> {
  if (decoded.includes('\0')) return null;
  const requested = normalize(join(webDist, decoded));
  if (requested !== webDist && !requested.startsWith(webDist + sep)) return null;
  try {
    const info = await stat(requested);
    return info.isFile() ? { path: requested, size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

function fileResponse(request: Request, file: Resolved, cacheControl: string): Response {
  const etag = `W/"${file.size.toString(16)}-${Math.floor(file.mtimeMs).toString(16)}"`;
  const headers = { 'cache-control': cacheControl, etag };
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  const body = Bun.file(file.path);
  const typed = { ...headers, 'content-type': body.type, 'content-length': String(file.size) };
  return new Response(request.method === 'HEAD' ? null : body, { headers: typed });
}

/** GET/HEAD handler. Missing files with an extension are 404; extensionless paths fall back to the SPA shell. */
export function createStaticHandler(webDist: string): (request: Request) => Promise<Response> {
  const indexPath = join(webDist, 'index.html');
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json(
        {
          error: { code: 'method_not_allowed', message: `${request.method} is not supported here` },
        },
        { status: 405, headers: { allow: 'GET, HEAD' } },
      );
    }
    const { pathname } = new URL(request.url);
    let decoded: string | null;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = null; // malformed escapes: treated as a client-side route
    }
    const file = decoded === null ? null : await resolveAsset(webDist, decoded);
    if (file !== null) {
      return fileResponse(request, file, pathname.startsWith('/assets/') ? IMMUTABLE : REVALIDATE);
    }
    if (decoded !== null && extname(decoded) !== '') {
      return Response.json(
        { error: { code: 'not_found', message: 'no such file' } },
        { status: 404 },
      );
    }
    const index = await resolveAsset(webDist, '/index.html');
    if (index !== null) return fileResponse(request, index, REVALIDATE);
    return new Response(
      `hsw-editor: web app is not built (expected ${indexPath}; run \`bun run build\`)`,
      {
        status: 503,
      },
    );
  };
}
