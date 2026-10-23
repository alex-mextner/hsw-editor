/** Message ids and parameters for the invalid-zone reasons (catalogue entries: `messages.ts`). */
import type { BoundsSide, InvalidReason } from '@hsw-editor/core';

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
