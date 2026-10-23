import { describe, expect, test } from 'bun:test';
import { deepEqual } from './equal.ts';

describe('deepEqual', () => {
  test('ignores object key order at every depth', () => {
    expect(
      deepEqual({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }),
    ).toBe(true);
  });

  test.each([
    ['different values', { a: 1 }, { a: 2 }],
    ['an extra key', { a: 1 }, { a: 1, b: undefined }],
    ['a missing key', { a: 1, b: 2 }, { a: 1 }],
    ['array order', [1, 2], [2, 1]],
    ['array length', [1], [1, 2]],
    ['array vs object', [], {}],
    ['null vs object', null, {}],
    ['undefined vs null', undefined, null],
    ['number vs string', 1, '1'],
  ])('tells %s apart', (_name, a, b) => {
    expect(deepEqual(a, b)).toBe(false);
  });

  test('equal primitives and nested equal structures', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual([{ a: [] }], [{ a: [] }])).toBe(true);
  });
});
