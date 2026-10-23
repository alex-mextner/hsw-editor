import { describe, expect, test } from 'bun:test';
import {
  createStripeMaterial,
  setStripeDpr,
  STRIPE_FRAGMENT,
} from '../invalid-zones/stripeMaterial.ts';

describe('physics stripe variant', () => {
  test('amber "/" stripes with a wider period than the red "\\" invalid zones', () => {
    const invalid = createStripeMaterial({ theme: 'dark', xray: false });
    const physics = createStripeMaterial({ theme: 'dark', xray: false, variant: 'physics' });
    expect(invalid.color.getHexString()).toBe('ff3b3b');
    expect(physics.color.getHexString()).toBe('f5a524');
    expect(invalid.userData.stripe.uDirection.value).toBe(1);
    expect(physics.userData.stripe.uDirection.value).toBe(-1);
    expect(physics.userData.stripe.uPeriodPx.value).toBeGreaterThan(
      invalid.userData.stripe.uPeriodPx.value,
    );
    // The neutral differs too: white over red, a dark neutral over amber.
    expect(invalid.userData.stripe.uGapColor.value.getHexString()).toBe('ffffff');
    expect(physics.userData.stripe.uGapColor.value.getHexString()).toBe('1b1b22');
  });

  test('one shader serves both: the direction is a uniform', () => {
    expect(STRIPE_FRAGMENT).toContain('uDirection * gl_FragCoord.y');
  });

  test('the device pixel ratio scales each look from its own base period', () => {
    const invalid = createStripeMaterial({ theme: 'light', xray: true });
    const physics = createStripeMaterial({ theme: 'light', xray: true, variant: 'physics' });
    setStripeDpr(invalid, 2);
    setStripeDpr(physics, 2);
    expect(invalid.userData.stripe.uPeriodPx.value).toBe(12);
    expect(physics.userData.stripe.uPeriodPx.value).toBe(18);
  });
});
