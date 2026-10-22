import type { ValueStore } from './types.ts';

export const stateBackend = 'baseline' as const;

/** Dependency-free backend, used when the private state-lib is not installed (e.g. in CI). */
export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const notify of [...listeners]) notify();
    },
    subscribe(notify) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
}
