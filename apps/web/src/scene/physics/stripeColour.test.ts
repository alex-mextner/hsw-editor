import { describe, expect, test } from 'bun:test';
import { BoxGeometry } from 'three';
import { withStripeColour } from './stripeColour.ts';

describe('withStripeColour', () => {
  test('gives the geometry a colour attribute of ones and leaves the source alone', () => {
    const source = new BoxGeometry(10, 20, 30);
    const coloured = withStripeColour(source);
    const colour = coloured.getAttribute('color');
    expect(colour.count).toBe(source.getAttribute('position').count);
    expect(colour.itemSize).toBe(3);
    expect(Array.from(colour.array).every((v) => v === 1)).toBe(true);
    expect(source.getAttribute('color')).toBeUndefined();
  });
});
