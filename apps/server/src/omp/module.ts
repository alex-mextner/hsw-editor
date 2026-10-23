/**
 * The omp bridge as a `ServerModule`: lazily builds the host on the first request (it needs the daemon's
 * home directory and listening port) and serves `/api/omp/*`.
 */
import type { ServerModule } from '../modules.ts';
import { loadOmpConfig, type OmpConfig } from './config.ts';
import { OmpHost } from './host.ts';
import { createOmpRoutes, type OmpRoutes } from './routes.ts';
import type { ToolFactory } from './tool-types.ts';
import { createWallToolFactory } from './wall-tools.ts';

export interface OmpModule extends ServerModule {
  /** Gracefully stop every omp child (close stdin, wait, escalate). Safe to call before any request. */
  stop(): Promise<void>;
  /** The host once the first request created it (tests inspect it). */
  readonly host: () => OmpHost | null;
}

export interface OmpModuleOptions {
  readonly config?: Partial<OmpConfig>;
  /** Tools registered next to the wall tools (vision, draw, ...). */
  readonly extraTools?: readonly ToolFactory[];
}

export function createOmpModule(options: OmpModuleOptions = {}): OmpModule {
  let host: OmpHost | null = null;
  let routes: OmpRoutes | null = null;
  let apiBase = '';

  const ensure = (home: string): OmpRoutes => {
    if (routes !== null && host !== null) return routes;
    const wallTools = createWallToolFactory({ apiBase: () => apiBase });
    const factories = [wallTools, ...(options.extraTools ?? [])];
    host = new OmpHost({
      config: loadOmpConfig(process.env, { dataDir: home, ...options.config }),
      createTools: (env) => factories.flatMap((factory) => factory(env)),
      log: (message) => console.warn(`[omp] ${message}`),
    });
    host.installExitHook();
    routes = createOmpRoutes(host);
    return routes;
  };

  return {
    name: 'omp',
    host: () => host,
    async handle(request, deps, server) {
      if (!new URL(request.url).pathname.startsWith('/api/omp/')) return null;
      apiBase = `http://127.0.0.1:${server.port}`;
      return ensure(deps.config.home).handle(request, server);
    },
    websocket: {
      open: (ws) => routes?.websocket.open?.(ws),
      message: (ws, message) => routes?.websocket.message(ws, message),
      close: (ws, code, reason) => routes?.websocket.close?.(ws, code, reason),
      drain: (ws) => routes?.websocket.drain?.(ws),
    },
    async stop() {
      await host?.shutdown();
    },
  };
}

/** The module the daemon mounts (see `modules.ts`). */
export const ompModule: OmpModule = createOmpModule();
