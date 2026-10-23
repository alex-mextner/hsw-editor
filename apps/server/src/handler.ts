/** Request pipeline: loopback guard -> modules -> core API -> static web app. */
import type { Server } from 'bun';
import { type HealthPayload, handleApi } from './api.ts';
import { checkRequestOrigin } from './guard.ts';
import type { ModuleSocketData, ServerDeps, ServerModule } from './modules.ts';
import { createStaticHandler } from './static.ts';

export type { HealthPayload };

export type Handler = (
  request: Request,
  server: Server<ModuleSocketData>,
) => Promise<Response | undefined>;

export function createHandler(deps: ServerDeps, modules: readonly ServerModule[]): Handler {
  const serveStatic = createStaticHandler(deps.config.webDist);
  return async (request, server) => {
    const verdict = checkRequestOrigin(request, deps.config.allowedOrigins);
    if (verdict !== null) {
      return Response.json(
        { error: { code: verdict.code, message: verdict.message } },
        { status: 403 },
      );
    }
    for (const module of modules) {
      const handled = await module.handle(request, deps, server);
      if (handled !== null) return handled;
    }
    const api = await handleApi(request, deps);
    if (api !== null) {
      if (!api.headers.has('cache-control')) api.headers.set('cache-control', 'no-store');
      return api;
    }
    return serveStatic(request);
  };
}
