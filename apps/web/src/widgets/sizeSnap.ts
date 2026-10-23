/**
 * Typed sizes always become something that can be built: the requested number is snapped to the parameter's
 * step and range and to the printer bed, and the widget reports `{requested, snapped, reason}` instead of
 * silently changing it. The arithmetic is `snapSize` of `packages/overlay`.
 */
import type { ParamDef } from '@hsw-editor/bank';
import { rangeFromParam, snapSize, type SizeSnap, type SnapReason } from '@hsw-editor/overlay';
import { createValueStore } from '#state-backend';
import type { MessageKey } from '@/i18n/index.ts';

/** Bambu Lab A1 bed: nothing longer than this can be printed in one piece. */
export const PRINT_MAX_MM = 256;

export function snapParam(def: ParamDef, requested: number): SizeSnap {
  const constraint = rangeFromParam(def);
  return def.unit === 'mm'
    ? snapSize(requested, constraint, { printMaxMm: PRINT_MAX_MM })
    : snapSize(requested, constraint);
}

const REASON_KEY: Readonly<Record<SnapReason['code'], MessageKey>> = {
  exact: 'photo.snap.exact',
  'rounded-to-step': 'photo.snap.step',
  'nearest-rung': 'photo.snap.rung',
  'whole-cells': 'photo.snap.cells',
  'min-limit': 'photo.snap.min',
  'max-limit': 'photo.snap.max',
  'printable-limit': 'photo.snap.printable',
  unbuildable: 'photo.snap.unbuildable',
};

export function snapReasonKey(reason: SnapReason): MessageKey {
  return REASON_KEY[reason.code];
}

/** Numbers the reason's sentence mentions. */
export function snapReasonParams(reason: SnapReason): Record<string, number> {
  switch (reason.code) {
    case 'rounded-to-step':
      return { step: reason.stepMm };
    case 'whole-cells':
      return { cells: reason.cells };
    case 'min-limit':
    case 'max-limit':
    case 'printable-limit':
    case 'unbuildable':
      return { limit: reason.limitMm };
    default:
      return {};
  }
}

/**
 * The last typed size of each field and what it was snapped to. Kept outside the widget: committing the size
 * edits the wall, which can remount the inspector, and the explanation must outlive that.
 */
export const snapNoteStore = createValueStore<Readonly<Record<string, SizeSnap>>>({});

export function noteKey(itemId: string, paramKey: string): string {
  return `${itemId}:${paramKey}`;
}

export function rememberSnap(itemId: string, paramKey: string, snap: SizeSnap): void {
  snapNoteStore.set({ ...snapNoteStore.get(), [noteKey(itemId, paramKey)]: snap });
}
