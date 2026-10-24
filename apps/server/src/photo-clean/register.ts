/**
 * Registers the `photo.clean` job and mounts the draw routes (`/api/draw/*`: backend status for the editor's quiet
 * "basic clean, sign in for the AI one" note). Imported once for its side effect by the daemon entry; the draw
 * runtime is created lazily and nothing is started until the first AI step.
 */
import { join } from 'node:path';
import type { DrawBackendId } from '@hsw-editor/draw';
import { loadConfig } from '../config.ts';
import { createDrawRuntime, type DrawRuntime } from '../draw/runtime.ts';
import { createDrawRoutes } from '../draw/routes.ts';
import { modules } from '../modules.ts';
import { type CleanDraw, registerPhotoCleanJob } from './job.ts';

let runtime: DrawRuntime | null = null;
const drawRuntime = (): DrawRuntime => (runtime ??= createDrawRuntime());

/** The backends the AI clean may use: the user's draw setting, never the manual one (it needs a human upload). */
export function cleanBackends(setting: DrawBackendId | 'auto'): readonly DrawBackendId[] {
  if (setting === 'auto') return ['draw-cli', 'omp', 'chatgpt-browser'];
  return setting === 'manual' ? [] : [setting];
}

const draw: CleanDraw = {
  async order() {
    return cleanBackends((await drawRuntime().getSettings()).backend);
  },
  run: (req, signal, forced) => drawRuntime().run(req, signal, forced),
};

registerPhotoCleanJob({
  wallDir: (wallId) => join(loadConfig().home, 'walls', wallId),
  draw,
});

modules.push({
  name: 'draw',
  // The runtime is only built for a /api/draw request: a bad draw setting must not take the whole API down.
  handle: (request) =>
    new URL(request.url).pathname.startsWith('/api/draw/')
      ? createDrawRoutes(drawRuntime())(request)
      : null,
});
