/**
 * The daemon's ONE draw runtime (paths, guard state, backends, settings): the `/api/draw/*` routes and the
 * `tools.draw_view` job share it, so a quota or login state learned by one is seen by the other. Created on first use,
 * under the daemon's data home (`HSW_EDITOR_HOME`) unless `HSW_EDITOR_DATA_DIR` says otherwise; the CLI (its own process)
 * reads the same files.
 */
import { type DrawRuntime, createDrawRuntime } from './runtime.ts';

let shared: DrawRuntime | null = null;

export function sharedDrawRuntime(home: string): DrawRuntime {
  shared ??= createDrawRuntime({
    env: { ...process.env, HSW_EDITOR_DATA_DIR: process.env['HSW_EDITOR_DATA_DIR'] ?? home },
  });
  return shared;
}
