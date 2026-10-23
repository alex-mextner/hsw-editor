import { describe, expect, test } from 'bun:test';
import { itemIdOfHit, itemUserData } from './itemHit.ts';

describe('item hit lookup', () => {
  const userData = itemUserData([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

  test('an instance index resolves to the placement drawn there', () => {
    expect(itemIdOfHit(userData, 0)).toBe('a');
    expect(itemIdOfHit(userData, 2)).toBe('c');
  });

  test('a stale or missing instance index is not an item', () => {
    expect(itemIdOfHit(userData, 3)).toBeNull();
    expect(itemIdOfHit(userData, undefined)).toBeNull();
  });

  test('meshes that are not item instances (plate, overlay) are not items', () => {
    expect(itemIdOfHit({}, 0)).toBeNull();
    expect(itemIdOfHit({ itemIds: 'a' }, 0)).toBeNull();
  });
});
