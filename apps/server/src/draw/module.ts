/** Mounts `/api/draw/*` (backend status, settings, manual-upload inbox) on the daemon. */
import type { ServerModule } from '../modules.ts';
import { createDrawRoutes } from './routes.ts';
import type { DrawRuntime } from './runtime.ts';
import { sharedDrawRuntime } from './shared.ts';

export interface DrawModuleOptions {
  /** Test seam: a runtime with fake backends and a scratch data directory. */
  runtime?: DrawRuntime;
}

export function createDrawModule(options: DrawModuleOptions = {}): ServerModule {
  return {
    name: 'draw',
    handle(request, deps) {
      if (!new URL(request.url).pathname.startsWith('/api/draw/')) return null;
      return createDrawRoutes(options.runtime ?? sharedDrawRuntime(deps.config.home))(request);
    },
  };
}
