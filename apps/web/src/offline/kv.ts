/**
 * Async key-value store the offline layer persists into. Two implementations: IndexedDB in the
 * browser (`idb.ts`) and an in-memory one for tests and for contexts without IndexedDB (private
 * mode, SSR). Values are structured-cloned on the way in and out, so a caller can never mutate what
 * is stored.
 *
 * Reads go through the caller's `parse`: storage outlives the code that wrote it (an older build, a
 * hand-edited DevTools value), so every record is validated and an unreadable one is treated as absent
 * instead of crashing the editor.
 */
export interface KvStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Deletes `key` only if its current record satisfies `condition`, atomically (one IndexedDB transaction),
   * so a concurrent write between "check" and "delete" is never lost. Resolves whether it deleted.
   */
  deleteIf(key: string, condition: (current: V) => boolean): Promise<boolean>;
  /**
   * Atomic read-modify-write of one key (one IndexedDB transaction): `change` sees the stored value (or `undefined`)
   * and returns the new one, or `undefined` to leave the key untouched. Two writers (page and service worker) can
   * never overwrite each other's change.
   */
  update(key: string, change: (current: V | undefined) => V | undefined): Promise<void>;
  /** Every valid record; unreadable ones are skipped. */
  entries(): Promise<[string, V][]>;
}

export type Parse<V> = (raw: unknown) => V | undefined;

/** In-memory store with the same clone-on-read/write semantics as IndexedDB. */
export function createMemoryStore<V>(parse: Parse<V>): KvStore<V> {
  const data = new Map<string, unknown>();
  const read = (key: string): V | undefined =>
    data.has(key) ? parse(structuredClone(data.get(key))) : undefined;
  return {
    get(key) {
      return Promise.resolve(read(key));
    },
    set(key, value) {
      data.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete(key) {
      data.delete(key);
      return Promise.resolve();
    },
    update(key, change) {
      const next = change(read(key));
      if (next !== undefined) data.set(key, structuredClone(next));
      return Promise.resolve();
    },
    deleteIf(key, condition) {
      const current = read(key);
      if (current === undefined || !condition(current)) return Promise.resolve(false);
      data.delete(key);
      return Promise.resolve(true);
    },
    entries() {
      const out: [string, V][] = [];
      for (const key of data.keys()) {
        const value = read(key);
        if (value !== undefined) out.push([key, value]);
      }
      return Promise.resolve(out);
    },
  };
}
