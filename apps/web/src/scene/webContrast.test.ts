import { describe, expect, test } from 'bun:test';
import { CONTRAST_WEB, PLAIN_WEB, lumaOf, meanLuma, webStyle } from './webContrast.ts';

describe('webStyle', () => {
  test('auto outlines the web on a white wall and leaves it plain on a dark or unknown one', () => {
    expect(webStyle('auto', 0.92)).toBe(CONTRAST_WEB);
    expect(webStyle('auto', 0.5)).toBe(PLAIN_WEB);
    expect(webStyle('auto', null)).toBe(PLAIN_WEB);
  });

  test('the user override wins over the measured wall', () => {
    expect(webStyle('on', 0.1)).toBe(CONTRAST_WEB);
    expect(webStyle('off', 0.99)).toBe(PLAIN_WEB);
  });
});

describe('meanLuma', () => {
  test('averages opaque pixels only', () => {
    const white = [255, 255, 255, 255];
    const black = [0, 0, 0, 255];
    const hidden = [255, 255, 255, 0];
    expect(meanLuma(new Uint8ClampedArray([...white, ...black, ...hidden]))).toBeCloseTo(0.5, 5);
  });

  test('is null when nothing is opaque', () => {
    expect(meanLuma(new Uint8ClampedArray([9, 9, 9, 0]))).toBeNull();
  });

  test('weights green above blue', () => {
    expect(lumaOf(0, 255, 0)).toBeGreaterThan(lumaOf(0, 0, 255));
  });
});
