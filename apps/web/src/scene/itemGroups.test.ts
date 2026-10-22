import { afterEach, describe, expect, test } from 'bun:test';
import { createEmptyWall, WallItemSchema, type WallItem } from '@hsw-editor/core';
import { bankStore, refreshBank } from '@/bank/client.ts';
import { installFetch, restoreFetch } from '@/test/fetchStub.ts';
import { bankElement, bankIndex } from '@/test/fixtures.ts';
import { groupItems } from './itemGroups.ts';
import { itemBounds } from './itemBounds.ts';

const GONE_ID = 'caliper-cradle-slots1-beamwidth20';

afterEach(() => {
  restoreFetch();
  bankStore.set({ status: 'loading' });
});

function holder(id: string, bankId: string): WallItem {
  return WallItemSchema.parse({ id, kind: 'holder', bankId });
}

function wallWith(...items: WallItem[]) {
  return { ...createEmptyWall('w-1', 'Wall'), items };
}

describe('groupItems', () => {
  test('keeps an item whose element is gone from the bank, in its own flagged group', () => {
    const present = bankElement('present');
    const wall = wallWith(holder('i-1', 'present'), holder('i-2', GONE_ID), holder('i-3', GONE_ID));
    const bank = new Map([[present.id, present]]);

    const groups = groupItems(wall, bank, true);

    const ids = groups.flatMap(([, group]) => group.items.map((item) => item.id)).sort();
    expect(ids).toEqual(['i-1', 'i-2', 'i-3']);
    const missing = groups.filter(([, group]) => group.missing !== null);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.[1].missing).toEqual({ bankId: GONE_ID, name: GONE_ID });
    expect(missing[0]?.[1].items.map((item) => item.id)).toEqual(['i-2', 'i-3']);
    expect(missing[0]?.[1].source).toBeNull();
    // The wall itself is untouched.
    expect(wall.items.map((item) => item.bankId)).toEqual(['present', GONE_ID, GONE_ID]);
  });

  test('nothing is called missing while the bank is not loaded', () => {
    const wall = wallWith(holder('i-2', GONE_ID));
    const groups = groupItems(wall, new Map(), false);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.[1].missing).toBeNull();
  });

  test('the placeholder keeps the element label as its name when the bank never knew the element', () => {
    const labelled = WallItemSchema.parse({
      id: 'i-9',
      kind: 'holder',
      bankId: GONE_ID,
      label: 'My cradle',
    });
    const groups = groupItems(wallWith(labelled), new Map(), true);
    expect(groups[0]?.[1].missing?.name).toBe('My cradle');
  });

  test('an element trimmed from the index is still drawn at the size it had when last seen', async () => {
    const big = bankElement(GONE_ID, { dimsMm: { x: 77, y: 88, z: 99 } });
    installFetch(() => Response.json(bankIndex([big], { hash: 'a'.repeat(64) })));
    await refreshBank({ force: true });
    installFetch(() => Response.json(bankIndex([], { hash: 'b'.repeat(64) })));
    await refreshBank({ force: true });

    const state = bankStore.get();
    expect(state.status === 'ready' && state.byId.has(GONE_ID)).toBe(false);
    const wall = wallWith(holder('i-2', GONE_ID));
    const groups = groupItems(wall, new Map(), true);
    expect(groups[0]?.[1].boxMm).toEqual({ x: 77, y: 88, z: 99 });
    // ...and it has a selection frame, so the item stays editable.
    expect(itemBounds(holder('i-2', GONE_ID), wall, new Map())?.dims).toEqual({
      x: 77,
      y: 88,
      z: 99,
    });
  });
});
