import { describe, expect, test } from 'bun:test';
import { toolInterfaceFromHolding } from './toolInterface.ts';

const holding = {
  lengthMm: 180,
  hang: null,
  maxSection: { w: 24, t: 24, r: 12 },
  dims: { shaftDiameter: 6, width: 30 },
};

describe('toolInterfaceFromHolding', () => {
  test('takes what the model measures and the item params win, except the box sizes', () => {
    const result = toolInterfaceFromHolding('screwdriver', ['hand-tool'], holding, {
      shaftDiameter: 7,
      width: 99,
      length: 400,
    });
    expect(result).toEqual({
      toolClass: 'screwdriver',
      broader: ['hand-tool'],
      lengthMm: 180,
      hang: null,
      maxSection: { w: 24, t: 24, r: 12 },
      // `width` stays the roll the model measured: the param of that name is the box
      dims: { shaftDiameter: 7, width: 30 },
    });
  });
});
