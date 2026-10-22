/** Daemon configuration, read once from the environment (the CLI's `_serve` verb sets these). */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEFAULT_PORT = 8794;

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  /** Wall store root; `walls/` lives under it. */
  readonly home: string;
  readonly webDist: string;
  /** Browser origins other than the daemon's own that may call the API (the Vite dev server). */
  readonly allowedOrigins: readonly string[];
  readonly heartbeatMs: number;
}

export function defaultHome(env: Record<string, string | undefined>): string {
  const dataHome = env['XDG_DATA_HOME'] ?? join(homedir(), '.local/share');
  return join(dataHome, 'hsw-editor');
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const origins = env['HSW_EDITOR_ALLOWED_ORIGINS'];
  return {
    port: Number(env['HSW_EDITOR_PORT'] ?? DEFAULT_PORT),
    host: env['HSW_EDITOR_HOST'] ?? '127.0.0.1',
    home: resolve(env['HSW_EDITOR_HOME'] ?? defaultHome(env)),
    webDist: resolve(env['HSW_EDITOR_WEB_DIST'] ?? join(import.meta.dir, '../../web/dist')),
    allowedOrigins:
      origins === undefined
        ? ['http://127.0.0.1:5194', 'http://localhost:5194']
        : origins
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin !== ''),
    heartbeatMs: Number(env['HSW_EDITOR_HEARTBEAT_MS'] ?? 15_000),
  };
}
