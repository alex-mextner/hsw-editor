import { describe, expect, test } from 'bun:test';
import { createEmptyWall, validateWall, WALL_SCHEMA_VERSION, type Wall } from './wall.ts';

describe('wall schema', () => {
  test('an empty wall is valid and versioned', () => {
    const wall = createEmptyWall('w1', 'Garage');
    expect(wall.schemaVersion).toBe(WALL_SCHEMA_VERSION);
    expect(validateWall(wall)).toEqual([]);
  });

  test('reports duplicate ids and elements outside the wall', () => {
    const base = createEmptyWall('w1', 'Garage', 100, 100);
    const element = {
      id: 'a',
      bankId: 'hsw-hook',
      position: { x: 50, y: 0, z: 50 },
      rotationDeg: 0,
    };
    const wall: Wall = {
      ...base,
      elements: [element, { ...element, position: { x: 500, y: 0, z: 50 } }],
    };
    expect(validateWall(wall)).toEqual([
      'duplicate element id a',
      'element a is outside the wall horizontally',
    ]);
  });

  test('NaN coordinates and sizes are rejected', () => {
    const base = createEmptyWall('w1', 'Garage');
    const element = {
      id: 'a',
      bankId: 'hsw-hook',
      position: { x: NaN, y: 0, z: 10 },
      rotationDeg: 0,
    };
    expect(validateWall({ ...base, elements: [element] })).toEqual([
      'element a is outside the wall horizontally',
    ]);
    expect(validateWall({ ...base, widthMm: NaN })).toEqual(['wall size must be positive']);
  });
});
