/**
 * The omp bridge as a `ServerModule`: lazily builds the host on the first request (it needs the daemon's
 * home directory and listening address) and serves `/api/omp/*`.
 */
import type { ServerModule } from '../modules.ts';
import { createAppCommandToolFactory } from './app-command-tool.ts';
import { loadOmpConfig, type OmpConfig } from './config.ts';
import { OmpHost } from './host.ts';
import { createOmpRoutes, OMP_SOCKET_OPTIONS, type OmpRoutes } from './routes.ts';
import type { ToolFactory } from './tool-types.ts';
import { createWallToolFactory } from './wall-tools.ts';

export interface OmpModule extends ServerModule {
  /** Required here (optional on `ServerModule`): stops every omp child gracefully, safe before any request. */
  stop(): Promise<void>;
  /** The host once the first request created it (tests inspect it). */
  readonly host: () => OmpHost | null;
}

export interface OmpModuleOptions {
  readonly config?: Partial<OmpConfig>;
  /** Tools registered next to the wall tools (vision, draw, ...). */
  readonly extraTools?: readonly ToolFactory[];
}

interface Running {
  readonly host: OmpHost;
  readonly routes: OmpRoutes;
}

/**
 * `http://host:port` the wall tools use to call the daemon's own API: wildcard binds are reached over
 * loopback (the global Host guard only accepts loopback names), IPv6 literals need brackets.
 */
function daemonOrigin(hostname: string | undefined, port: number | undefined): string {
  const host =
    hostname === undefined || hostname === '0.0.0.0' ? '127.0.0.1' : hostname === '::' ? '::1' : hostname;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function createOmpModule(options: OmpModuleOptions = {}): OmpModule {
  let running: Running | null = null;
  /** True while `stop()` drains the children: requests then get 503 instead of starting new ones. */
  let stopping = false;
  let apiBase = '';

  const ensure = (home: string): Running => {
    if (running !== null) return running;
    const wallTools = createWallToolFactory({ apiBase: () => apiBase });
    const factories = [wallTools, createAppCommandToolFactory(), ...(options.extraTools ?? [])];
    const host = new OmpHost({
      config: loadOmpConfig(process.env, { dataDir: home, ...options.config }),
      createTools: (env) => factories.flatMap((factory) => factory(env)),
      log: (message) => console.warn(`[omp] ${message}`),
    });
    host.installExitHook();
    running = { host, routes: createOmpRoutes(host) };
    return running;
  };

  return {
    name: 'omp',
    host: () => running?.host ?? null,
    async handle(request, deps, server) {
      if (!new URL(request.url).pathname.startsWith('/api/omp/')) return null;
      if (stopping) return Response.json({ error: { code: 'shutting_down' } }, { status: 503 });
      apiBase = daemonOrigin(server.hostname, server.port);
      return ensure(deps.config.home).routes.handle(request, server);
    },
    websocket: {
      ...OMP_SOCKET_OPTIONS,
      open: (ws) => running?.routes.websocket.open?.(ws),
      message: (ws, message) => running?.routes.websocket.message(ws, message),
      close: (ws, code, reason) => running?.routes.websocket.close?.(ws, code, reason),
      drain: (ws) => running?.routes.websocket.drain?.(ws),
    },
    async stop() {
      stopping = true;
      const current = running;
      running = null;
      try {
        await current?.host.shutdown();
      } finally {
        stopping = false;
      }
    },
  };
}

/** The module the daemon mounts (see `modules.ts`). */
export const ompModule: OmpModule = createOmpModule();
