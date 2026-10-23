import { createValueStore } from '#state-backend';
import type { ValueStore } from './types.ts';

/**
 * Value store mirrored to localStorage under `key`. `parse` validates the stored string and
 * returns null when it is not a valid value (stale format, tampering), so the default is used.
 */
export function createPersistedStore<T>(
  key: string,
  initial: T,
  parse: (raw: string) => T | null,
  serialize: (value: T) => string = (value) => JSON.stringify(value),
): ValueStore<T> {
  let start = initial;
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (raw != null) start = parse(raw) ?? initial;
  } catch {
    // Storage unavailable (private mode): keep the default.
  }
  const store = createValueStore<T>(start);
  store.subscribe(() => {
    try {
      globalThis.localStorage?.setItem(key, serialize(store.get()));
    } catch {
      // The in-memory store still works.
    }
  });
  return store;
}
