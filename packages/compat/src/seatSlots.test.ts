import { describe, expect, test } from 'bun:test';
import type { Pose } from '@hsw-editor/core';
import { bankHolder, holder, TOOLS, toolItem, wallWith } from './fixtures/testing.ts';
import { isUpright, slotHalfWidthMm, slotsOf, wallSlot } from './seatSlots.ts';
import { compatibility } from './compatibility.ts';

const POSE: Pose = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 };

describe('isUpright', () => {
  test('only an unrotated holder is seated', () => {
    expect(isUpright(POSE)).toBe(true);
    expect(isUpright({ ...POSE, rotZ: 360 })).toBe(true);
    expect(isUpright({ ...POSE, rotZ: -0.2 })).toBe(true);
    expect(isUpright({ ...POSE, rotZ: 90 })).toBe(false);
    expect(isUpright({ ...POSE, rotX: 5 })).toBe(false);
  });
});

describe('slotHalfWidthMm', () => {
  const rail = bankHolder('refit-screwdriver-rail-3');
  const width = rail.bboxMm.max.x - rail.bboxMm.min.x;

  test('is half the slot pitch', () => {
    expect(
      slotHalfWidthMm({ bboxMm: { min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 1, z: 1 } } }, 3),
    ).toBe(10);
  });

  test('is capped, and a holder without slots counts as one', () => {
    expect(slotHalfWidthMm(rail, 1)).toBe(Math.min(width / 2, 14));
    expect(slotHalfWidthMm(rail, 0)).toBe(slotHalfWidthMm(rail, 1));
    expect(
      slotHalfWidthMm({ bboxMm: { min: { x: 0, y: 0, z: 0 }, max: { x: 400, y: 1, z: 1 } } }, 1),
    ).toBe(14);
  });
});

describe('wallSlot', () => {
  const rail = bankHolder('refit-screwdriver-rail-3');
  const hung = holder('h', rail.id, 4, 4);
  const driver = TOOLS['screwdriver'];

  test('takes the first slot nobody uses unless one is asked for', () => {
    const a = toolItem('a', 'screwdriver', { parentId: 'h', slot: 0 });
    const b = toolItem('b', 'screwdriver', { parentId: 'h' });
    const wall = wallWith([hung, a, b]);
    if (driver === undefined) throw new Error('no interface');
    expect(wallSlot(wall, b, hung, rail, driver)?.slot.index).toBe(1);
    expect(wallSlot(wall, b, hung, rail, driver, 2)?.slot.index).toBe(2);
    expect(wallSlot(wall, b, hung, rail, driver, 9)).toBeNull();
  });

  test('no slot when the holder does not take the tool', () => {
    const wall = wallWith([hung]);
    const hammer = TOOLS['hammer'];
    const item = toolItem('t', 'hammer', { parentId: 'h' });
    if (hammer === undefined) throw new Error('no interface');
    expect(wallSlot(wall, item, hung, rail, hammer)).toBeNull();
  });

  test('slotsOf lists the slots of the matched entry', () => {
    if (driver === undefined) throw new Error('no interface');
    const compat = compatibility(driver, rail);
    expect(slotsOf(rail, compat).count).toBe(3);
  });
});
