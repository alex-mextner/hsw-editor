/**
 * The media cache byte budget: a user setting kept in the offline database (`meta` store, key
 * `mediaBudget`) and capped by what the browser grants this origin (`effectiveBudget`). The worker and the
 * settings panel read it from the same place, so a change in the panel applies to the worker's next eviction.
 */
import type { KvStore } from '../offline/kv.ts';
import { MIN_MEDIA_BUDGET_BYTES } from './cachePolicy.ts';

export const BUDGET_KEY = 'mediaBudget';

export function parseMetaNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** The user's chosen byte budget, if any and sane. */
export async function readBudgetSetting(meta: KvStore<number>): Promise<number | undefined> {
  const value = await meta.get(BUDGET_KEY);
  return value !== undefined && value >= MIN_MEDIA_BUDGET_BYTES ? value : undefined;
}

/** `undefined` restores the default. */
export async function writeBudgetSetting(
  meta: KvStore<number>,
  bytes: number | undefined,
): Promise<void> {
  if (bytes === undefined) await meta.delete(BUDGET_KEY);
  else await meta.set(BUDGET_KEY, Math.max(MIN_MEDIA_BUDGET_BYTES, Math.floor(bytes)));
}
