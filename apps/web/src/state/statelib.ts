import { createScope } from './statelib-scope.ts';
import type { ValueStore } from './types.ts';

export const stateBackend = 'state-lib' as const;

/** One app-wide scope: the editor's stores live as long as the page. */
const appScope = createScope();

export function createValueStore<T>(initial: T): ValueStore<T> {
  return appScope.value(initial);
}
