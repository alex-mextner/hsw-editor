import { describe, expect, test } from 'bun:test';
import type { ParamDef } from '@hsw-editor/bank';
import { snapParam, snapReasonKey, snapReasonParams } from './sizeSnap.ts';

const width = {
  key: 'width',
  label: { ru: 'Ширина', en: 'Width' },
  unit: 'mm',
  min: 20,
  max: 400,
  step: 0.5,
  default: 40,
} as unknown as ParamDef;

describe('snapParam', () => {
  test('a typed size on the step is exact', () => {
    const snap = snapParam(width, 45);
    expect(snap).toMatchObject({ requested: 45, snapped: 45, changed: false });
    expect(snapReasonKey(snap.reason)).toBe('photo.snap.exact');
  });

  test('a size between steps goes to the nearest step and says so', () => {
    const snap = snapParam(width, 45.3);
    expect(snap.snapped).toBe(45.5);
    expect(snapReasonKey(snap.reason)).toBe('photo.snap.step');
    expect(snapReasonParams(snap.reason)).toEqual({ step: 0.5 });
  });

  test('below the minimum it is raised, above the printer bed it is cut back', () => {
    expect(snapParam(width, 5)).toMatchObject({ snapped: 20, changed: true });
    const big = snapParam(width, 380);
    expect(big.snapped).toBeLessThanOrEqual(256);
    expect(snapReasonKey(big.reason)).toBe('photo.snap.printable');
    expect(snapReasonParams(big.reason)).toEqual({ limit: 256 });
  });
});
