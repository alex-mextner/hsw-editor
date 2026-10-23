import { describe, expect, test } from 'bun:test';
import { initialText, parseDimensionInput } from './requestsDimension.ts';

const FIELDS = [
  { key: 'length', min: 10, max: 200, fitted: 41.2345 },
  { key: 'diameter', suggested: 6.5 },
  { key: 'depth' },
] as const;

describe('initialText', () => {
  test('current value wins over fitted over suggested; nothing gives an empty field', () => {
    expect(initialText(FIELDS[0], 50)).toBe('50');
    expect(initialText(FIELDS[0], undefined)).toBe('41.235');
    expect(initialText(FIELDS[1], undefined)).toBe('6.5');
    expect(initialText(FIELDS[2], undefined)).toBe('');
  });
});

describe('parseDimensionInput', () => {
  test('collects valid values, skips empty fields', () => {
    const { values, errors } = parseDimensionInput(
      FIELDS,
      new Map([
        ['length', '45,5'],
        ['diameter', '  '],
      ]),
    );
    expect(values).toEqual({ length: 45.5 });
    expect(errors.size).toBe(0);
  });

  test('flags junk and out-of-range entries per field and keeps them out of the values', () => {
    const { values, errors } = parseDimensionInput(
      FIELDS,
      new Map([
        ['length', '5'],
        ['diameter', 'abc'],
        ['depth', '3'],
      ]),
    );
    expect(values).toEqual({ depth: 3 });
    expect(errors.get('length')).toBe('min');
    expect(errors.get('diameter')).toBe('invalid');
    expect(parseDimensionInput(FIELDS, new Map([['length', '250']])).errors.get('length')).toBe(
      'max',
    );
  });
});

describe('limits without a minimum', () => {
  const plain = [{ key: 'angle' }] as unknown as Parameters<typeof parseDimensionInput>[0];
  const signed = [{ key: 'angle', min: -45, max: 45 }] as unknown as Parameters<
    typeof parseDimensionInput
  >[0];

  test('zero and negatives are invalid unless the field allows them', () => {
    expect(parseDimensionInput(plain, new Map([['angle', '-5']])).errors.get('angle')).toBe(
      'invalid',
    );
    expect(parseDimensionInput(plain, new Map([['angle', '0']])).errors.get('angle')).toBe(
      'invalid',
    );
  });

  test('a signed field accepts zero and negatives and reports its own limits', () => {
    expect(parseDimensionInput(signed, new Map([['angle', '-10']])).values).toEqual({ angle: -10 });
    expect(parseDimensionInput(signed, new Map([['angle', '0']])).values).toEqual({ angle: 0 });
    expect(parseDimensionInput(signed, new Map([['angle', '-60']])).errors.get('angle')).toBe(
      'min',
    );
  });
});
