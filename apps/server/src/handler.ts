import { existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

export interface HealthPayload {
  readonly ok: true;
  readonly name: 'hsw-editor';
  readonly version: string;
}

export const SERVER_VERSION = '0.1.0';

/** Request handler: `/api/health`, then static files from the built web app with SPA fallback. */
export function createHandler(webDist: string): (request: Request) => Response {
  const indexPath = join(webDist, 'index.html');
  return (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/health') {
      const body: HealthPayload = { ok: true, name: 'hsw-editor', version: SERVER_VERSION };
      return Response.json(body, { headers: { 'cache-control': 'no-store' } });
    }
    if (pathname.startsWith('/api/')) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const file = resolveAsset(webDist, pathname);
    if (file) return new Response(file);
    if (existsSync(indexPath)) return new Response(Bun.file(indexPath));
    return new Response('hsw-editor: web app is not built (run `bun run build`)', { status: 503 });
  };
}

function resolveAsset(webDist: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const requested = normalize(join(webDist, decoded));
  if (!requested.startsWith(webDist + sep)) return null;
  try {
    return statSync(requested).isFile() ? Bun.file(requested) : null;
  } catch {
    return null;
  }
}
