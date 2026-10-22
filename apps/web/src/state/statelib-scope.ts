/**
 * Ownership scope over one state-lib Runtime (consumer pattern from the tasks-app state resume).
 * Invariants: one Runtime per dependent graph; signals are allocated outside transactions.
 */
import { Runtime, toExternalStore } from '@ultrabricks/state-lib';
import type { ValueStore } from './types.ts';

export interface Scope {
  readonly runtime: Runtime;
  value<T>(initial: T, equals?: (left: T, right: T) => boolean): ValueStore<T>;
  transact(fn: () => void): void;
  dispose(): void;
}

export function createScope(runtime: Runtime = new Runtime()): Scope {
  return {
    runtime,
    value<T>(initial: T, equals?: (left: T, right: T) => boolean): ValueStore<T> {
      const signal = runtime.signal<T>(initial, equals);
      const external = toExternalStore(signal);
      return Object.freeze<ValueStore<T>>({
        getSnapshot: () => external.getSnapshot(),
        subscribe: (notify) => external.subscribe(notify),
        get: () => signal.get(),
        set: (next) => signal.set(next),
      });
    },
    transact: (fn) => runtime.transaction(fn),
    dispose: () => runtime.dispose(),
  };
}
