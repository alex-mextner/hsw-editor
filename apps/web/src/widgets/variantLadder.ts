/**
 * A typed size on a holder that only comes in fixed rungs (bank family siblings, no generator): the number is
 * resolved to the nearest rung with `nearestVariant` of `packages/overlay`, and the rungs next to it are offered
 * as chips. Pure; the dimension widget renders and commits the result.
 */
import type { BankElement } from '@hsw-editor/bank';
import type { Op, WallItem } from '@hsw-editor/core';
import type { MessageKey } from '@/i18n/index.ts';
import { nearestVariant, type VariantReason, type VariantSnap } from '@hsw-editor/overlay';

/** The element dimensions a user can type: width x, height y, depth z. */
export type LadderKey = 'x' | 'y' | 'z';
export const LADDER_KEYS: readonly LadderKey[] = ['x', 'y', 'z'];

/** The i18n name of each axis of an element's bounding box, shared by the fixed-size table and the ladder. */
export const AXIS_LABEL_KEY: Readonly<Record<LadderKey, MessageKey>> = {
  x: 'widgets.dimensions.width',
  y: 'widgets.dimensions.height',
  z: 'widgets.dimensions.depth',
};

export interface Rung {
  readonly element: BankElement;
  /** The rung's size along the typed dimension, mm. */
  readonly valueMm: number;
}

export interface LadderResult {
  readonly key: LadderKey;
  readonly requestedMm: number;
  readonly reason: VariantReason;
  /** The rung the size was snapped to; null when the family has no comparable rung. */
  readonly chosen: Rung | null;
  /** The next smaller and next larger rung along the dimension. */
  readonly below: Rung | null;
  readonly above: Rung | null;
  /** Other axes whose size changes with the switch to `chosen` (a sibling that differs in more than one size). */
  readonly alsoChanged: readonly {
    readonly key: LadderKey;
    readonly fromMm: number;
    readonly toMm: number;
  }[];
}

/** Distance between two elements in the axes other than `key`: a rung should change only the typed size. */
function otherAxesDistance(a: BankElement, b: BankElement, key: LadderKey): number {
  return LADDER_KEYS.filter((axis) => axis !== key).reduce(
    (sum, axis) => sum + Math.abs(a.dimsMm[axis] - b.dimsMm[axis]),
    0,
  );
}

/**
 * The family's distinct rungs along `key`, ascending. Siblings of equal size along `key` are one rung, represented by
 * the one that differs least from `current` in the other axes (the item's own element represents its own size), so
 * typing a height never quietly changes the width.
 */
export function rungsOf(
  family: readonly BankElement[],
  key: LadderKey,
  current: BankElement | undefined,
): Rung[] {
  const bySize = new Map<number, Rung>();
  for (const element of family) {
    const valueMm = element.dimsMm[key];
    const kept = bySize.get(valueMm);
    const better =
      kept === undefined ||
      (current !== undefined &&
        (element.id === current.id ||
          (kept.element.id !== current.id &&
            otherAxesDistance(element, current, key) <
              otherAxesDistance(kept.element, current, key))));
    if (better) bySize.set(valueMm, { element, valueMm });
  }
  return [...bySize.values()].sort((a, b) => a.valueMm - b.valueMm);
}

/** Resolves a typed size along `key` to a rung of the family. Throws on a non-finite size (callers parse first). */
export function snapToLadder(
  family: readonly BankElement[],
  key: LadderKey,
  requestedMm: number,
  current: BankElement | undefined,
): LadderResult {
  const rungs = rungsOf(family, key, current);
  const snap: VariantSnap = nearestVariant(
    { [key]: requestedMm },
    rungs.map((rung) => ({ id: rung.element.id, dimsMm: { [key]: rung.valueMm } })),
  );
  const chosen = rungs.find((rung) => rung.element.id === snap.variant?.id) ?? null;
  const at = chosen === null ? -1 : rungs.indexOf(chosen);
  return {
    key,
    requestedMm,
    reason: snap.reason,
    chosen,
    below: at > 0 ? (rungs[at - 1] ?? null) : null,
    above: at >= 0 ? (rungs[at + 1] ?? null) : null,
    alsoChanged:
      chosen === null || current === undefined
        ? []
        : LADDER_KEYS.filter(
            (axis) => axis !== key && chosen.element.dimsMm[axis] !== current.dimsMm[axis],
          ).map((axis) => ({
            key: axis,
            fromMm: current.dimsMm[axis],
            toMm: chosen.element.dimsMm[axis],
          })),
  };
}

/** True when typing a size can land on more than one rung along some dimension. */
export function hasLadder(family: readonly BankElement[]): boolean {
  return LADDER_KEYS.some((key) => rungsOf(family, key, undefined).length > 1);
}

const REASON_KEY: Readonly<Record<VariantReason['code'], MessageKey>> = {
  exact: 'photo.snap.exact',
  'nearest-variant': 'photo.snap.variant.nearest',
  'smallest-fitting-variant': 'photo.snap.variant.fitting',
  'printable-limit': 'photo.snap.variant.printable',
  'no-comparable-variant': 'photo.snap.variant.none',
  unbuildable: 'photo.snap.variant.unbuildable',
};

export function ladderReasonKey(reason: VariantReason): MessageKey {
  return REASON_KEY[reason.code];
}

/** Ops that make `item` use `candidate`, dropping params the new element does not define. */
export function switchOps(item: WallItem, candidate: BankElement): Op[] {
  const known = new Set((candidate.params ?? []).map((def) => def.key));
  const stale = Object.keys(item.params).filter((key) => !known.has(key));
  const ops: Op[] = [
    { type: 'setVariant', id: item.id, variantId: candidate.id, bankId: candidate.id },
  ];
  if (stale.length > 0) ops.push({ type: 'setParams', id: item.id, unset: stale });
  return ops;
}
