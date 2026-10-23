import { runPhysicsCheck } from '@/physics/run.ts';
import { physicsStore } from '@/physics/store.ts';

/**
 * Runs the wall physics check. A failure lands in the store (the panel shows it) instead of escaping into an
 * unhandled rejection, unless the runner already published its own error.
 */
export async function checkPhysics(): Promise<void> {
  try {
    await runPhysicsCheck();
  } catch (error) {
    if (physicsStore.get().status !== 'error') {
      physicsStore.set({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
