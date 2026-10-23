/**
 * The pieces the service worker and the settings panel share: the asset registry, the settings store and the
 * effective media budget, all backed by the one offline IndexedDB. Both sides call this and get the same view.
 */
import { idbStore, offlineDbProvider } from '../offline/idb.ts';
import type { KvStore } from '../offline/kv.ts';
import { parseMetaNumber, readBudgetSetting } from './budget.ts';
import { effectiveBudget } from './cachePolicy.ts';
import { AssetRegistry, parseAssetEntry } from './registry.ts';

export interface OfflineServices {
  readonly registry: AssetRegistry;
  readonly meta: KvStore<number>;
  /** Byte budget of the media cache right now (user setting capped by the origin's quota). */
  readonly budget: () => Promise<number>;
}

export async function openOfflineServices(): Promise<OfflineServices> {
  const db = offlineDbProvider();
  const meta = idbStore<number>(db, 'meta', parseMetaNumber);
  return {
    registry: new AssetRegistry(idbStore(db, 'assets', parseAssetEntry)),
    meta,
    budget: async () =>
      effectiveBudget(await readBudgetSetting(meta), (await navigator.storage.estimate()).quota),
  };
}
