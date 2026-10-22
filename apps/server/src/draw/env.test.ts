import { expect, test } from 'bun:test';
import { createDrawRuntime } from './runtime.ts';
import { envInt } from './env.ts';

test('a malformed cap fails loudly instead of becoming NaN and disabling the guard', () => {
  expect(envInt({}, 'X', 30, 1)).toBe(30);
  expect(envInt({ X: '5' }, 'X', 30, 1)).toBe(5);
  for (const bad of ['abc', '0', '-3', '2.5']) {
    expect(() => envInt({ X: bad }, 'X', 30, 1)).toThrow('X must be an integer >= 1');
  }
  expect(() => createDrawRuntime({ env: { HSW_DRAW_DAILY_CAP: 'lots' } })).toThrow(
    'HSW_DRAW_DAILY_CAP',
  );
});
