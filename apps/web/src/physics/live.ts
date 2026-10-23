import { useEffect } from 'react';
import { bankStore } from '@/bank/client.ts';
import { variantVersion } from '@/bank/models.ts';
import { libraryStore } from '@/features/tools/store.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { physicsEnabledStore } from './enabled.ts';
import { clearPhysics, runPhysicsCheck } from './run.ts';

export { physicsEnabledStore };

/** Quiet time after the last edit before the check starts: a burst of edits is one check. */
export const LIVE_DEBOUNCE_MS = 400;

/**
 * Keeps the physics report of the open wall current: re-runs the check, debounced, when the wall changes (items,
 * regenerated variants, the tool library or the bank arriving), and not while an item is being dragged. Switched
 * off by the persisted "physics checks" setting, which also drops the report. Mount once, next to `useInvalidZones`.
 */
export function usePhysicsLive(): void {
  const enabled = useStore(physicsEnabledStore);
  const wall = useStore(sessionStore)?.wall ?? null;
  const bankStatus = useStore(bankStore).status;
  const library = useStore(libraryStore).status;
  const variants = useStore(variantVersion);
  const dragging = useStore(editorStore).dragging.size > 0;

  useEffect(() => {
    if (!enabled || wall === null) {
      clearPhysics();
      return undefined;
    }
    if (bankStatus !== 'ready' || dragging) return undefined;
    const timer = setTimeout(() => {
      void runPhysicsCheck({ force: false });
    }, LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `library` and `variants` change which model an item is; the run itself reads the stores.
  }, [enabled, wall, bankStatus, library, variants, dragging]);
}
