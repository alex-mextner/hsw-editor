import { describe, expect, test } from 'bun:test';
import { placeToolAt } from './placeTool.ts';

describe('placeToolAt without a wall', () => {
  test('adds nothing and says so when no wall is open', () => {
    expect(
      placeToolAt({
        toolClass: 'screwdriver',
        label: 'Screwdriver',
        dimsMm: { x: 28, y: 210, z: 28 },
        at: { x: 100, y: 100 },
      }),
    ).toBe('no-wall');
  });
});
