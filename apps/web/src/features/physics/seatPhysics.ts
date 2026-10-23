import { notify, type NoticeKind } from '@/features/notices/notices.ts';
import { t, tn } from '@/i18n/index.ts';
import { createValueStore } from '#state-backend';
import { ensureToolModels, livePostStepDeps } from '@/physics/context.ts';
import { runPhysicsCheck } from '@/physics/run.ts';
import { seatAllTools, type PostStepDeps } from '@/physics/seat.ts';

/** A seating is running: a second one would race it (the first one's undo step changes the wall under the second). */
export const seatingStore = createValueStore<boolean>(false);

/** What the seating needs from the editor: the post-step inputs, the model index, the follow-up check and the way to tell the user. */
export interface SeatPhysicsDeps {
  readonly post: PostStepDeps;
  readonly ensureModels: () => Promise<void>;
  readonly check: () => Promise<unknown>;
  readonly tell: (kind: NoticeKind, text: string) => void;
}

export async function seatPhysicsWith(deps: SeatPhysicsDeps): Promise<void> {
  if (seatingStore.get()) return;
  if (!deps.post.enabled()) {
    deps.tell('info', t('physics.seat.off'));
    return;
  }
  seatingStore.set(true);
  try {
    // Models are found through the tool model index; without it every tool would be reported as having no seat.
    await deps.ensureModels();
    const outcome = await seatAllTools(deps.post);
    if (!deps.post.enabled()) {
      // Switched off while the worker was busy: nothing was applied, and "already seated" would be untrue.
      deps.tell('info', t('physics.seat.off'));
    } else if (outcome.stale) {
      deps.tell('error', t('physics.seat.stale'));
    } else {
      if (outcome.seated.length > 0) {
        deps.tell('info', tn('physics.seat.done', outcome.seated.length));
      } else if (outcome.kept.length === 0 && outcome.unslotted.length === 0) {
        deps.tell('info', t('physics.seat.nothing'));
      }
      // Tools the physics could not seat (no model yet, no free slot, a rotated holder) are not "already seated".
      if (outcome.kept.length > 0) {
        deps.tell('error', tn('physics.seat.kept', outcome.kept.length));
      }
      if (outcome.unslotted.length > 0) {
        deps.tell('error', tn('physics.seat.unslotted', outcome.unslotted.length));
      }
    }
    // Switched off meanwhile: a forced check would publish a report that stays on screen while checks are off.
    if (deps.post.enabled()) await deps.check().catch(() => undefined);
  } finally {
    seatingStore.set(false);
  }
}

/**
 * Puts every hung tool where the physics says it rests in its holder (one undo step), tells the user what happened and
 * checks the wall again. Never throws; a second call while one runs does nothing.
 */
export function seatPhysics(): Promise<void> {
  return seatPhysicsWith({
    post: livePostStepDeps(),
    ensureModels: ensureToolModels,
    check: () => runPhysicsCheck({ force: true }),
    tell: notify,
  });
}
