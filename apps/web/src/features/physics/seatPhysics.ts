import { notify } from '@/features/notices/notices.ts';
import { t, tn } from '@/i18n/index.ts';
import { createValueStore } from '#state-backend';
import { ensureToolModels, livePostStepDeps } from '@/physics/context.ts';
import { runPhysicsCheck } from '@/physics/run.ts';
import { seatAllTools } from '@/physics/seat.ts';

/** A seating is running: a second one would race it (the first one's undo step changes the wall under the second). */
export const seatingStore = createValueStore<boolean>(false);

/**
 * Puts every hung tool where the physics says it rests in its holder (one undo step), tells the user what happened and
 * checks the wall again. Never throws; a second call while one runs does nothing.
 */
export async function seatPhysics(): Promise<void> {
  if (seatingStore.get()) return;
  const deps = livePostStepDeps();
  if (!deps.enabled()) {
    notify('info', t('physics.seat.off'));
    return;
  }
  seatingStore.set(true);
  try {
    // Models are found through the tool model index; without it every tool would be reported as having no seat.
    await ensureToolModels();
    const outcome = await seatAllTools(deps);
    if (outcome.stale) {
      notify('error', t('physics.seat.stale'));
    } else {
      if (outcome.seated.length > 0) {
        notify('info', tn('physics.seat.done', outcome.seated.length));
      } else if (outcome.kept.length === 0) {
        notify('info', t('physics.seat.nothing'));
      }
      // Tools the physics could not seat (no model yet, no free slot, a rotated holder) are not "already seated".
      if (outcome.kept.length > 0) notify('error', tn('physics.seat.kept', outcome.kept.length));
    }
    await runPhysicsCheck({ force: true }).catch(() => undefined);
  } finally {
    seatingStore.set(false);
  }
}
