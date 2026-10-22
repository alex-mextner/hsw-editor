import { useSyncExternalStore } from 'react';
import type { Store } from './types.ts';

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
