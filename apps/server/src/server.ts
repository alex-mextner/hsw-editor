/** Assembles store, jobs, modules and `Bun.serve`; shared by the daemon entry and integration tests. */
import type { Server, WebSocketHandler } from 'bun';
import type { ServerConfig } from './config.ts';
import { createHandler } from './handler.ts';
import { defaultJobRegistry, JobRunner, type JobRegistry } from './jobs.ts';
import { modules as defaultModules, type ModuleSocketData, type ServerModule } from './modules.ts';
import { SettingsStore } from './settings.ts';
import { type StoreHooks, WallStore } from './store/wall-store.ts';

export interface RunningServer {
  readonly server: Server<ModuleSocketData>;
  readonly store: WallStore;
  readonly jobs: JobRunner;
  readonly settings: SettingsStore;
  readonly url: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  modules?: readonly ServerModule[];
  jobRegistry?: JobRegistry;
  hooks?: StoreHooks;
}

/**
 * Bun takes one set of socket limits per server, so each module's limits are merged permissively: the
 * largest payload, backpressure and idle values win, pings are on if any module wants them.
 */
function composeWebsocket(modules: readonly ServerModule[]): WebSocketHandler<ModuleSocketData> {
  const owner = (name: string) => modules.find((module) => module.name === name)?.websocket;
  const handlers = modules.flatMap((module) => (module.websocket ? [module.websocket] : []));
  const limits: Partial<Record<'maxPayloadLength' | 'backpressureLimit' | 'idleTimeout', number>> =
    {};
  for (const key of ['maxPayloadLength', 'backpressureLimit', 'idleTimeout'] as const) {
    const values = handlers.flatMap((handler) => handler[key] ?? []);
    if (values.length > 0) limits[key] = Math.max(...values);
  }
  return {
    ...limits,
    ...(handlers.some((handler) => handler.sendPings) ? { sendPings: true } : {}),
    open: (ws) => owner(ws.data.module)?.open?.(ws),
    message: (ws, message) => owner(ws.data.module)?.message(ws, message),
    close: (ws, code, reason) => owner(ws.data.module)?.close?.(ws, code, reason),
    drain: (ws) => owner(ws.data.module)?.drain?.(ws),
  };
}

export async function startServer(
  config: ServerConfig,
  options: StartOptions = {},
): Promise<RunningServer> {
  const modules = options.modules ?? defaultModules;
  const store = new WallStore({
    home: config.home,
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  await store.init();
  const jobs = new JobRunner(options.jobRegistry ?? defaultJobRegistry, {
    get: (id) => store.get(id),
    apply: (id, request) => store.apply(id, request),
    addAsset: (id, slot) => store.addAsset(id, slot),
    askUser: async (id, request, actor, signal) => {
      const created = await store.createRequest(id, request, actor);
      return store.awaitRequest(id, created.id, signal);
    },
  });
  const settings = new SettingsStore({ home: config.home });
  const handler = createHandler({ config, store, jobs, settings }, modules);
  const server = Bun.serve<ModuleSocketData>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 120,
    maxRequestBodySize: 128 * 1024 * 1024,
    fetch: handler,
    websocket: composeWebsocket(modules),
  });
  const url = `http://${server.hostname}:${server.port}`;
  return {
    server,
    store,
    jobs,
    settings,
    url,
    async stop() {
      try {
        await Promise.all(modules.map((module) => module.stop?.()));
      } finally {
        await server.stop(true);
        await store.close();
      }
    },
  };
}
