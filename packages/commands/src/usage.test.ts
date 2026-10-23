import { describe, expect, test } from 'bun:test';
import { matchQuery } from './fuzzy.ts';
import {
  EMPTY_USAGE,
  frecencyBoost,
  MAX_BOOST,
  MAX_USAGE_ENTRIES,
  parseUsage,
  recentIds,
  recordUse,
} from './usage.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 10 * DAY;

describe('frecency', () => {
  test('more uses and fresher uses score higher; unknown scores zero', () => {
    expect(frecencyBoost(undefined, NOW)).toBe(0);
    const once = frecencyBoost({ count: 1, lastUsed: NOW }, NOW);
    const often = frecencyBoost({ count: 20, lastUsed: NOW }, NOW);
    const stale = frecencyBoost({ count: 20, lastUsed: NOW - 60 * DAY }, NOW);
    expect(often).toBeGreaterThan(once);
    expect(often).toBeGreaterThan(stale);
    expect(once).toBeGreaterThan(0);
  });

  test('the boost is capped so recents cannot bury a clearly better text match', () => {
    expect(frecencyBoost({ count: 1_000_000, lastUsed: NOW }, NOW)).toBe(MAX_BOOST);
  });

  test('even a hot history entry cannot outrank an exact title match', () => {
    const exact = matchQuery('undo', [{ text: 'Undo', weight: 1 }]);
    const longer = matchQuery('undo', [{ text: 'Undo last wall operation', weight: 1 }]);
    const hot = frecencyBoost({ count: 1_000_000, lastUsed: NOW }, NOW);
    expect((longer?.score ?? 0) + hot).toBeLessThan(exact?.score ?? 0);
  });

  test('recordUse counts and stamps', () => {
    const first = recordUse(EMPTY_USAGE, 'cmd:edit.undo', 100);
    const second = recordUse(first, 'cmd:edit.undo', 200);
    expect(second['cmd:edit.undo']).toEqual({ count: 2, lastUsed: 200 });
    expect(first['cmd:edit.undo']).toEqual({ count: 1, lastUsed: 100 });
  });

  test('the record is pruned to the least valuable entries', () => {
    let usage = EMPTY_USAGE;
    for (let i = 0; i < MAX_USAGE_ENTRIES + 20; i += 1)
      usage = recordUse(usage, `cmd:a.${i}`, NOW - (MAX_USAGE_ENTRIES + 20 - i) * 1000);
    expect(Object.keys(usage).length).toBe(MAX_USAGE_ENTRIES);
    expect(usage['cmd:a.0']).toBeUndefined();
    expect(usage[`cmd:a.${MAX_USAGE_ENTRIES + 19}`]).toBeDefined();
  });

  test('a first use is never pruned the moment it is recorded', () => {
    let usage = EMPTY_USAGE;
    for (let i = 0; i < MAX_USAGE_ENTRIES; i += 1) {
      usage = recordUse(
        recordUse(recordUse(usage, `cmd:a.${i}`, NOW - i), `cmd:a.${i}`, NOW - i),
        `cmd:a.${i}`,
        NOW - i,
      );
    }
    usage = recordUse(usage, 'cmd:brand.new', NOW);
    expect(usage['cmd:brand.new']).toEqual({ count: 1, lastUsed: NOW });
    expect(Object.keys(usage).length).toBe(MAX_USAGE_ENTRIES);
  });

  test('recentIds orders by frecency', () => {
    let usage = recordUse(EMPTY_USAGE, 'a', NOW - 30 * DAY);
    usage = recordUse(usage, 'b', NOW);
    usage = recordUse(usage, 'b', NOW);
    usage = recordUse(usage, 'c', NOW - DAY);
    expect(recentIds(usage, NOW, 2)).toEqual(['b', 'c']);
  });

  test('parseUsage keeps valid data and discards the rest', () => {
    const valid = { x: { count: 2, lastUsed: 5 } };
    expect(parseUsage(valid)).toEqual(valid);
    expect(parseUsage({ x: { count: -1, lastUsed: 5 } })).toEqual({});
    expect(parseUsage('junk')).toEqual({});
    expect(parseUsage(undefined)).toEqual({});
  });

  test('parseUsage drops only the bad entries and keeps the good ones', () => {
    const good = { count: 2, lastUsed: 5 };
    expect(
      parseUsage({
        good,
        negative: { count: -1, lastUsed: 5 },
        fractional: { count: 1.5, lastUsed: 5 },
        missing: { count: 1 },
        text: 'junk',
        nothing: null,
      }),
    ).toEqual({ good });
  });

  test('parseUsage rejects non-object documents', () => {
    expect(parseUsage(['x'])).toEqual({});
    expect(parseUsage(null)).toEqual({});
    expect(parseUsage(7)).toEqual({});
  });
});
