import { useEffect } from 'react';
import type { Wall } from '@hsw-editor/core';
import { photoStore } from '@/state/photo.ts';
import { useStore } from '@/state/react.ts';
import {
  CLEAN_DEBOUNCE_MS,
  autoCleanStore,
  cleanStore,
  planClean,
  runClean,
} from './cleanBackground.ts';

/**
 * Keeps the shown photo's cleaned background current: when the photo is calibrated and the board footprint has no
 * matching variant (first time, or it moved materially), waits for the footprint to settle and runs `photo.clean`.
 */
export function useAutoClean(wall: Wall): void {
  const { photoId, calibrating, draft } = useStore(photoStore);
  const enabled = useStore(autoCleanStore);
  // While a job runs a due clean waits; when it ends the effect looks again (the board may have moved meanwhile).
  const phase = useStore(cleanStore).phase;
  const plan = photoId === null || calibrating || draft !== null ? null : planClean(wall, photoId);
  const due =
    enabled && phase !== 'running' && plan !== null && (plan.needsClean || plan.needsUpgrade);
  const signature = plan?.signature ?? null;
  useEffect(() => {
    if (!due || photoId === null || signature === null) return undefined;
    const timer = setTimeout(() => {
      void runClean(wall.id, photoId, signature);
    }, CLEAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [due, photoId, signature, wall.id]);
}
