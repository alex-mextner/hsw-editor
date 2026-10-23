import { describe, expect, test } from 'bun:test';
import { defaultLoadCapacityG } from './load.ts';

describe('defaultLoadCapacityG', () => {
  test('hooks and pegs', () => {
    expect(defaultLoadCapacityG('hooks/hooks')).toBe(1500);
    expect(defaultLoadCapacityG('accessories/cables')).toBe(1500);
  });
  test('slot and rack holders', () => {
    expect(defaultLoadCapacityG('holders/screwdrivers')).toBe(1000);
    expect(defaultLoadCapacityG('holders/hammers')).toBe(1000);
  });
  test('cups are weaker than racks', () => {
    expect(defaultLoadCapacityG('bins/cups')).toBe(800);
  });
  test('trays, bins and shelves', () => {
    expect(defaultLoadCapacityG('holders/tape')).toBe(3000);
    expect(defaultLoadCapacityG('bins/boxes')).toBe(3000);
    expect(defaultLoadCapacityG('shelves')).toBe(3000);
  });
});
