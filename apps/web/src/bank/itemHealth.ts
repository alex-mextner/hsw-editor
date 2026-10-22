import type { WallItem } from '@hsw-editor/core';
import type { AssetFailure, AssetGoneReason } from './assetHealth.ts';
import { unavailableElements, type BankState } from './client.ts';

/**
 * Wall items whose 3D model cannot be shown. Such items are never removed or rewritten by the
 * client (the wall belongs to the server and its op history); they are drawn as a labelled box and
 * flagged, so the user can keep editing around them and decide what to do.
 */

export type ItemModelIssue =
  /** The element id is not in the (current, loaded) bank index. */
  | { readonly kind: 'missing'; readonly bankId: string; readonly gone: AssetGoneReason }
  /** The element exists but one of its files failed to load. */
  | { readonly kind: 'failed'; readonly bankId: string; readonly failure: AssetFailure };

/**
 * Items that reference a bank element the loaded index does not have. Judged only against a ready
 * bank: while the index is loading (or failed to load) nothing can be called missing.
 */
export function missingBankItems(items: readonly WallItem[], bank: BankState): readonly WallItem[] {
  if (bank.status !== 'ready') return [];
  return items.filter(
    (item) => item.kind !== 'photo-ref' && item.bankId !== undefined && !bank.byId.has(item.bankId),
  );
}

export function itemModelIssue(
  item: WallItem,
  bank: BankState,
  failures: ReadonlyMap<string, AssetFailure>,
): ItemModelIssue | null {
  const { bankId } = item;
  if (bank.status !== 'ready' || bankId === undefined || item.kind === 'photo-ref') return null;
  if (!bank.byId.has(bankId)) {
    const listed = unavailableElements(bank.index).find((entry) => entry.id === bankId);
    const gone: AssetGoneReason = listed
      ? { kind: 'unavailable', detail: listed.reason }
      : { kind: 'removed' };
    return { kind: 'missing', bankId, gone };
  }
  for (const failure of failures.values()) {
    if (failure.bankId === bankId && failure.state !== 'recovered') {
      return { kind: 'failed', bankId, failure };
    }
  }
  return null;
}
