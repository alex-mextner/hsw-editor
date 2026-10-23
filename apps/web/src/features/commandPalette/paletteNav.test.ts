import { describe, expect, test } from 'bun:test';
import { cycleMode, isNavKey, moveActive, PAGE_ROWS } from './paletteNav.ts';

describe('moveActive', () => {
  test('the arrows wrap around', () => {
    expect(moveActive(2, 3, 'ArrowDown')).toBe(0);
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2);
    expect(moveActive(0, 3, 'ArrowDown')).toBe(1);
  });

  test('paging and Home/End stop at the ends', () => {
    expect(moveActive(0, 30, 'PageDown')).toBe(PAGE_ROWS);
    expect(moveActive(28, 30, 'PageDown')).toBe(29);
    expect(moveActive(3, 30, 'PageUp')).toBe(0);
    expect(moveActive(10, 30, 'Home')).toBe(0);
    expect(moveActive(10, 30, 'End')).toBe(29);
  });

  test('no rows keeps the highlight at zero', () => {
    expect(moveActive(0, 0, 'ArrowDown')).toBe(0);
    expect(moveActive(0, 0, 'End')).toBe(0);
  });
});

describe('cycleMode', () => {
  test('walks the prefixes and keeps the typed text', () => {
    expect(cycleMode('', false)).toBe('>');
    expect(cycleMode('>theme', false)).toBe('@theme');
    expect(cycleMode('?ask', false)).toBe('ask');
  });

  test('Shift+Tab goes back, wrapping to the AI prefix', () => {
    expect(cycleMode('>theme', true)).toBe('theme');
    expect(cycleMode('theme', true)).toBe('?theme');
  });
});

test('isNavKey only accepts navigation keys', () => {
  expect(isNavKey('PageUp')).toBe(true);
  expect(isNavKey('Enter')).toBe(false);
});
