/** Message ids and parameters for the invalid-zone reasons (catalogue entries: `i18n/catalog/invalidZones.ts`). */
import type { BoundsSide, InvalidReason } from '@hsw-editor/core';
import type { RegionMesh } from './engine.ts';

export type InvalidMessageKey =
  | 'invalid.overlap'
  | 'invalid.out.left'
  | 'invalid.out.right'
  | 'invalid.out.bottom'
  | 'invalid.out.top'
  | 'invalid.out.behindWall';

export interface InvalidMessage {
  readonly key: InvalidMessageKey;
  readonly params: Readonly<Record<string, string>>;
}

const SIDE_KEY: Record<BoundsSide, InvalidMessageKey> = {
  left: 'invalid.out.left',
  right: 'invalid.out.right',
  bottom: 'invalid.out.bottom',
  top: 'invalid.out.top',
  'behind-wall': 'invalid.out.behindWall',
};

/** Millimetres for people: 2 decimals below 1 mm (shallow overlaps matter), 1 decimal above. */
export function formatMm(value: number): string {
  return value < 1 ? value.toFixed(2) : value.toFixed(1);
}

/** `nameOf` resolves an item id to a display name such as "Holder 3". */
export function describeReason(
  reason: InvalidReason,
  nameOf: (id: string) => string,
): InvalidMessage {
  if (reason.kind === 'overlap') {
    return {
      key: 'invalid.overlap',
      params: { other: nameOf(reason.otherId), depth: formatMm(reason.depthMm) },
    };
  }
  return { key: SIDE_KEY[reason.side], params: { extent: formatMm(reason.extentMm) } };
}

/** Reasons grouped by item id, in the engine's (sorted) order. */
export function reasonsByItem(reasons: readonly InvalidReason[]): Map<string, InvalidReason[]> {
  const grouped = new Map<string, InvalidReason[]>();
  for (const reason of reasons) {
    const list = grouped.get(reason.itemId);
    if (list) list.push(reason);
    else grouped.set(reason.itemId, [reason]);
  }
  return grouped;
}

/** The reasons a region stands for: both sides of an overlap pair, or the one (item, side) of a protrusion. */
export function regionReasons(
  region: Pick<RegionMesh, 'key' | 'kind' | 'itemIds'>,
  reasons: readonly InvalidReason[],
): InvalidReason[] {
  return reasons.filter((reason) =>
    region.kind === 'overlap'
      ? reason.kind === 'overlap' &&
        region.itemIds.includes(reason.itemId) &&
        region.itemIds.includes(reason.otherId)
      : reason.kind === 'out-of-board' && region.key === `bounds:${reason.itemId}:${reason.side}`,
  );
}

export type LegendState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'none' }
  | { readonly kind: 'count'; readonly items: number };

/** What the legend says: still checking while some model is loading (an unchecked item is not a valid one). */
export function legendState(result: {
  readonly reasons: readonly InvalidReason[];
  readonly pending: readonly string[];
}): LegendState {
  const items = new Set(result.reasons.map((reason) => reason.itemId)).size;
  if (items > 0) return { kind: 'count', items };
  return result.pending.length > 0 ? { kind: 'checking' } : { kind: 'none' };
}
