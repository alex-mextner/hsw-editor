import { expect, test } from 'bun:test';
import { createDrawRuntime } from './runtime.ts';
import { envInt } from './env.ts';
import { resolveDrawPaths } from './paths.ts';

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

test('the draw state lives under the daemon home, so the CLI and the daemon share it', () => {
  const base = { HOME: '/home/u', XDG_DATA_HOME: '/data' };
  expect(resolveDrawPaths(base).dataDir).toBe('/data/hsw-editor');
  expect(resolveDrawPaths({ ...base, HSW_EDITOR_HOME: '/x/home' }).guardFile).toBe(
    '/x/home/draw/guard.json',
  );
  expect(resolveDrawPaths({ ...base, HSW_EDITOR_HOME: '/x/home', HSW_EDITOR_DATA_DIR: '/y' }).dataDir).toBe('/y');
});
