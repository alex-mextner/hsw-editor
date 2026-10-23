/** Connects the offline warmup (`warm.ts`) to the app: the loaded tool library and the open wall. Not started in the daemon-less demo. */
import { DEMO } from '@/demo/mode.ts';
import { libraryStore } from '@/features/tools/store.ts';
import { sessionStore } from '@/wall/session.ts';
import { connection } from '@/offline/runtime.ts';
import { pageCacheDeps } from './pageDeps.ts';
import { downloadAssets } from './storage.ts';
import { createWarmup } from './warm.ts';

export function startOfflineWarmup(): void {
  if (DEMO || !('caches' in globalThis)) return;
  const warmup = createWarmup({
    origin: location.origin,
    deps: pageCacheDeps,
    download: downloadAssets,
    env: { estimate: () => navigator.storage.estimate() },
  });
  // The session store publishes on every edit (every step of a drag): look at the file lists only when the wall or their identity changed.
  let seen: { readonly id: string; readonly photos: unknown; readonly models: unknown } | null =
    null;
  const library = (): void => {
    const state = libraryStore.get();
    warmup.library(state.status === 'ready' ? state : null);
  };
  const wall = (force: boolean): void => {
    const current = sessionStore.get()?.wall ?? null;
    const unchanged =
      current === null
        ? seen === null
        : seen?.id === current.id &&
          seen.photos === current.photos &&
          seen.models === current.models;
    if (!force && unchanged) return;
    seen =
      current === null ? null : { id: current.id, photos: current.photos, models: current.models };
    warmup.wall(current);
  };
  libraryStore.subscribe(library);
  sessionStore.subscribe(() => wall(false));
  // A run that stopped offline is forgotten by the warmup; the daemon coming back is the moment to run it again.
  connection.onReconnect(() => {
    library();
    wall(true);
  });
  library();
  wall(true);
}
