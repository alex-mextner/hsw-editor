/**
 * IndexedDB-backed `KvStore`s. One database (`hsw-editor-offline`) holds every offline record so the page and
 * the service worker open the same stores; this module owns the schema (`OFFLINE_STORES`):
 *   - `walls`   wall mirror + queued edits (one record per wall, written atomically)
 *   - `assets`  registry of service-worker cache entries (size, last use, pinned): `src/pwa/registry.ts`
 *   - `meta`    small settings the page and the worker share (the media cache byte budget)
 *
 * No dependency: the few needed calls (get/put/delete/delete-if + a full scan) are thin wrappers over raw
 * IndexedDB that reject on a failing transaction instead of hanging. The database handle comes from a
 * provider that reopens after another tab upgraded the schema (the old handle is closed so the upgrade is
 * never blocked), so a store never keeps a dead connection.
 */
import type { KvStore, Parse } from './kv.ts';

export const OFFLINE_DB_NAME = 'hsw-editor-offline';
export const OFFLINE_DB_VERSION = 2;
export const OFFLINE_STORES = ['walls', 'assets', 'meta'] as const;
export type OfflineStoreName = (typeof OFFLINE_STORES)[number];

export type DbProvider = () => Promise<IDBDatabase>;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'));
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      for (const name of OFFLINE_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('indexeddb open failed'));
    // `blocked` is transient (another tab still holds an old version): the open completes once it lets go.
  });
}

/** Opens the offline database on first use and again after a schema upgrade elsewhere closed it. */
export function offlineDbProvider(factory: IDBFactory = indexedDB): DbProvider {
  let current: Promise<IDBDatabase> | null = null;
  return () => {
    current ??= open(factory).then(
      (db) => {
        db.onversionchange = () => {
          db.close();
          current = null;
        };
        return db;
      },
      (error: unknown) => {
        current = null;
        throw error;
      },
    );
    return current;
  };
}

export function idbStore<V>(db: DbProvider, name: OfflineStoreName, parse: Parse<V>): KvStore<V> {
  const store = async (mode: IDBTransactionMode) => {
    const tx = (await db()).transaction(name, mode);
    return { tx, objects: tx.objectStore(name) };
  };
  return {
    async get(key) {
      const { objects } = await store('readonly');
      const raw: unknown = await request(objects.get(key));
      return raw === undefined ? undefined : parse(raw);
    },
    async set(key, value) {
      const { tx, objects } = await store('readwrite');
      objects.put(value, key);
      await done(tx);
    },
    async delete(key) {
      const { tx, objects } = await store('readwrite');
      objects.delete(key);
      await done(tx);
    },
    async update(key, change) {
      const { tx, objects } = await store('readwrite');
      const reading = objects.get(key);
      reading.onsuccess = () => {
        const current = reading.result === undefined ? undefined : parse(reading.result);
        const next = change(current);
        if (next !== undefined) objects.put(next, key);
      };
      await done(tx);
    },
    async deleteIf(key, condition) {
      const { tx, objects } = await store('readwrite');
      let deleted = false;
      const reading = objects.get(key);
      reading.onsuccess = () => {
        const current = reading.result === undefined ? undefined : parse(reading.result);
        if (current !== undefined && condition(current)) {
          objects.delete(key);
          deleted = true;
        }
      };
      await done(tx);
      return deleted;
    },
    async entries() {
      const { objects } = await store('readonly');
      const [keys, values] = await Promise.all([
        request<IDBValidKey[]>(objects.getAllKeys()),
        request<unknown[]>(objects.getAll()),
      ]);
      const out: [string, V][] = [];
      keys.forEach((key, index) => {
        const value = parse(values[index]);
        if (typeof key === 'string' && value !== undefined) out.push([key, value]);
      });
      return out;
    },
  };
}
