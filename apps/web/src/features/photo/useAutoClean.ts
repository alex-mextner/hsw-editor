import { useEffect } from 'react';
import type { Wall } from '@hsw-editor/core';
import { photoStore } from '@/state/photo.ts';
import { useStore } from '@/state/react.ts';
import { isCopyPending, isTemplateWall } from '@/wall/session.ts';
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
    enabled &&
    // A template is never changed in the background: its copy is made by the first edit of the visitor.
    !isTemplateWall(wall.id) &&
    // The copy of a template exists on the service only after its clone request is answered.
    !isCopyPending(wall.id) &&
    phase !== 'running' &&
    plan !== null &&
    (plan.needsClean || plan.needsUpgrade);
  const signature = plan?.signature ?? null;
  useEffect(() => {
    if (!due || photoId === null || signature === null) return undefined;
    const timer = setTimeout(() => {
      void runClean(wall.id, photoId, signature);
    }, CLEAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [due, photoId, signature, wall.id]);
}
