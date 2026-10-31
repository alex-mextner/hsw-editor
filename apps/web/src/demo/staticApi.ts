/**
 * The daemon API as far as the demo build (GitHub Pages, no daemon) can answer it. `fetch` is wrapped once at startup
 * (`installDemoApi`), so every caller of an `/api/*` route keeps its code and nothing ever shows a raw `HTTP 404`:
 *
 *  - the Tool Library is served from what the build ships: `GET /api/tools` is an empty user library, `GET /api/tools/classes` is
 *    the static class list (`/api/tools/assets/classes`, written by `scripts/tools/demo-assets.ts`), class thumbnails and the
 *    bank are plain static files, and the per-parameter answers (`holding`, `model.glb` with `?p=` / `?preset=`) are generated in the
 *    browser with the daemon's own generators (`classModels.ts`);
 *  - everything that needs a daemon (saving a tool, photo import drafts, jobs, any write) and any other route the build does
 *    not ship answers with a `demo_unavailable` error whose message says so in the user's language.
 */
import type { ClassResource } from './classModels.ts';
import { t } from '@/i18n/index.ts';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const DEMO_UNAVAILABLE = 'demo_unavailable';
const CLASS_ROUTE = /^\/api\/tools\/classes\/([a-z0-9][a-z0-9-]{0,63})\/(holding|model\.glb)$/;

/** The error every route the demo cannot serve answers with; the message is what the UI shows. */
export function unavailableResponse(): Response {
  return Response.json(
    { error: { code: DEMO_UNAVAILABLE, message: t('demo.unavailable') } },
    { status: 501 },
  );
}

/** The URL of a request (relative ones against the page) and whether it targets the page's own origin. */
function requestOf(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { url: URL; method: string; sameOrigin: boolean } {
  const page = new URL(globalThis.location?.href ?? 'http://localhost/');
  const url = new URL(input instanceof Request ? input.url : String(input), page);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return { url, method: method.toUpperCase(), sameOrigin: url.origin === page.origin };
}

function isJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('json');
}

/** A `fetch` that answers the routes above and passes everything else to `real`. */
export function createDemoFetch(real: FetchFn): FetchFn {
  return async (input, init) => {
    const { url, method, sameOrigin } = requestOf(input, init);
    if (!sameOrigin || !url.pathname.startsWith('/api/')) return real(input, init);
    if (method !== 'GET' && method !== 'HEAD') return unavailableResponse();
    if (url.pathname === '/api/tools') return Response.json({ tools: [] });
    if (url.pathname === '/api/tools/classes') return real('/api/tools/assets/classes', init);
    const resource = CLASS_ROUTE.exec(url.pathname);
    if (resource?.[1] !== undefined && resource[2] !== undefined) {
      // Dynamic on purpose: the generators are a large chunk that only the class detail page needs, not the startup path.
      const { classResponse } = await import('./classModels.ts');
      return (
        classResponse(resource[1], resource[2] as ClassResource, url.searchParams) ??
        unavailableResponse()
      );
    }
    const response = await real(input, init);
    // A missing file is answered by the host's HTML 404 page; a JSON error body of a shipped route is left alone.
    return response.ok || isJson(response) ? response : unavailableResponse();
  };
}

/** Wraps the page's `fetch` (demo build only). */
export function installDemoApi(): void {
  const real: FetchFn = globalThis.fetch.bind(globalThis);
  globalThis.fetch = Object.assign(createDemoFetch(real), globalThis.fetch);
}
