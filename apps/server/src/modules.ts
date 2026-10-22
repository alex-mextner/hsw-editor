/**
 * Extension point for features owned by other packages (omp bridge, draw backends, vision proxy, bank).
 * A module claims requests by returning a Response (or a promise of one) and returns `null` to pass.
 * Modules run after the loopback guard and before the core wall API, so they inherit the guard.
 *
 * To add one, create it in your own directory and append it to `modules` below (a one-line change):
 *
 *   import { drawModule } from './draw/routes.ts';
 *   export const modules: ServerModule[] = [drawModule];
 */
import type { Server, WebSocketHandler } from 'bun';
import type { ServerConfig } from './config.ts';
import type { JobRunner } from './jobs.ts';
import type { SettingsStore } from './settings.ts';
import type { WallStore } from './store/wall-store.ts';

export interface ServerDeps {
  readonly config: ServerConfig;
  readonly store: WallStore;
  readonly jobs: JobRunner;
  readonly settings: SettingsStore;
}

/** Every module socket carries its module name so the daemon can dispatch frames. */
export interface ModuleSocketData {
  readonly module: string;
}

export interface ServerModule {
  readonly name: string;
  /**
   * Return `null` for requests the module does not own. For a WebSocket, call
   * `server.upgrade(request, { data: { module: this.name } })` and return `undefined`.
   */
  handle(
    request: Request,
    deps: ServerDeps,
    server: Server<ModuleSocketData>,
  ): Response | undefined | null | Promise<Response | undefined | null>;
  /** WebSocket frames for sockets this module upgraded. */
  readonly websocket?: WebSocketHandler<ModuleSocketData>;
}

export const modules: ServerModule[] = [];
