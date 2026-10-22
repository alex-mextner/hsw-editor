import { describe, expect, test } from 'bun:test';
import { formatLength, formatNumber, parseLength, parseNumber, type LengthUnit } from './units.ts';

describe('formatting', () => {
  test('trims trailing zeros and uses the unit precision', () => {
    expect(formatNumber(12.5, 'mm')).toBe('12.5');
    expect(formatNumber(120, 'mm')).toBe('120');
    expect(formatNumber(120, 'cm')).toBe('12');
    expect(formatNumber(25.4, 'in')).toBe('1');
    expect(formatNumber(5, 'in')).toBe('0.197');
    expect(formatNumber(-0.01, 'mm')).toBe('0');
  });

  test('formatLength appends the unit', () => {
    expect(formatLength(12.5, 'mm')).toBe('12.5 mm');
    expect(formatLength(254, 'in')).toBe('10 in');
  });
});

describe('parseLength', () => {
  test('accepts dot and comma decimals', () => {
    expect(parseLength('12.5', 'mm')).toBe(12.5);
    expect(parseLength('12,5', 'mm')).toBe(12.5);
    expect(parseLength(' ,5 ', 'mm')).toBe(0.5);
    expect(parseLength('-3', 'mm')).toBe(-3);
  });

  test('converts from the active unit and lets a typed suffix override it', () => {
    expect(parseLength('2', 'cm')).toBe(20);
    expect(parseLength('1', 'in')).toBeCloseTo(25.4, 10);
    expect(parseLength('1,5 cm', 'mm')).toBe(15);
    expect(parseLength('2см', 'mm')).toBe(20);
    expect(parseLength('1"', 'mm')).toBeCloseTo(25.4, 10);
    expect(parseLength('7 MM', 'in')).toBe(7);
  });

  test('rejects junk', () => {
    for (const text of ['', ' ', 'abc', '1,2,3', '1.2.3', '--1', '12 kg', '1e3', 'Infinity', '.']) {
      expect(parseLength(text, 'mm')).toBeNull();
    }
  });

  test('round-trips through every unit', () => {
    const units: readonly LengthUnit[] = ['mm', 'cm', 'in'];
    for (const unit of units) {
      for (const mm of [0, 3.5, 12.7, 160, 245.4]) {
        const shown = formatNumber(mm, unit);
        const back = parseLength(shown, unit);
        expect(back).not.toBeNull();
        // The display rounds, so the round trip is exact only up to half a display step.
        expect(Math.abs((back ?? Infinity) - mm)).toBeLessThan(unit === 'in' ? 0.02 : 0.06);
      }
    }
  });
});

describe('parseNumber', () => {
  test('is for unitless params: a suffix is not allowed', () => {
    expect(parseNumber('3')).toBe(3);
    expect(parseNumber('2,5')).toBe(2.5);
    expect(parseNumber('3 mm')).toBeNull();
    expect(parseNumber('x')).toBeNull();
  });
});
