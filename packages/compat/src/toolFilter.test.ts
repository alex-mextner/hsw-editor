import { describe, expect, test } from 'bun:test';
import { BANK_HOLDERS, TOOLS } from './fixtures/testing.ts';
import {
  effectiveToolFilter,
  holdersForClasses,
  initialToolFilter,
  persistToolFilter,
  rankHoldersForTools,
  reduceToolFilter,
  restoreToolFilter,
  type ToolFilterAction,
  type ToolFilterState,
} from './toolFilter.ts';

function run(state: ToolFilterState, ...actions: ToolFilterAction[]): ToolFilterState {
  return actions.reduce(reduceToolFilter, state);
}

const pick = (itemIds: string[], classes: string[]): ToolFilterAction => ({
  type: 'selectionChanged',
  selection: { itemIds, classes },
});

describe('tool filter state machine', () => {
  test('the explicit filter applies while no tool is selected', () => {
    const state = run(initialToolFilter(), { type: 'setExplicit', classes: ['pliers', 'wrench'] });
    expect(effectiveToolFilter(state)).toEqual({
      source: 'explicit',
      classes: ['pliers', 'wrench'],
      resettable: false,
    });
  });

  test('selecting tools overrides the explicit filter at once and offers the cross', () => {
    const state = run(initialToolFilter(['pliers']), pick(['t1', 't2'], ['screwdriver', 'hammer']));
    expect(effectiveToolFilter(state)).toEqual({
      source: 'selection',
      classes: ['screwdriver', 'hammer'],
      resettable: true,
    });
    expect(state.explicit).toEqual(['pliers']);
  });

  test('X drops the override but keeps the earlier explicit filter, which comes back', () => {
    const state = run(initialToolFilter(['pliers']), pick(['t1'], ['screwdriver']), {
      type: 'dismissOverride',
    });
    expect(effectiveToolFilter(state)).toMatchObject({
      source: 'explicit',
      classes: ['pliers'],
      resettable: false,
    });
    expect(state.selection.itemIds).toEqual(['t1']);
  });

  test('a dismissed override stays dismissed while the same items are selected, even if classes re-resolve', () => {
    const state = run(
      initialToolFilter(['pliers']),
      pick(['t1'], ['screwdriver']),
      { type: 'dismissOverride' },
      pick(['t1'], ['screwdriver']),
    );
    expect(effectiveToolFilter(state).source).toBe('explicit');
  });

  test('selecting different tools after X re-arms the override', () => {
    const state = run(
      initialToolFilter(['pliers']),
      pick(['t1'], ['screwdriver']),
      { type: 'dismissOverride' },
      pick(['t2'], ['hammer']),
    );
    expect(effectiveToolFilter(state)).toMatchObject({ source: 'selection', classes: ['hammer'] });
  });

  test('deselecting everything restores the explicit filter, and a later selection overrides again', () => {
    let state = run(initialToolFilter(['pliers']), pick(['t1'], ['screwdriver']));
    state = run(state, pick([], []));
    expect(effectiveToolFilter(state)).toMatchObject({ source: 'explicit', classes: ['pliers'] });
    state = run(state, pick(['t1'], ['screwdriver']));
    expect(effectiveToolFilter(state).source).toBe('selection');
  });

  test('deselect after X also re-arms, so the same tool selected again overrides again', () => {
    const state = run(
      initialToolFilter(['pliers']),
      pick(['t1'], ['screwdriver']),
      { type: 'dismissOverride' },
      pick([], []),
      pick(['t1'], ['screwdriver']),
    );
    expect(effectiveToolFilter(state).source).toBe('selection');
  });

  test('editing the explicit filter while an override is active changes only what X restores to', () => {
    const state = run(initialToolFilter(['pliers']), pick(['t1'], ['screwdriver']), {
      type: 'setExplicit',
      classes: ['wrench'],
    });
    expect(effectiveToolFilter(state).classes).toEqual(['screwdriver']);
    expect(effectiveToolFilter(run(state, { type: 'dismissOverride' })).classes).toEqual([
      'wrench',
    ]);
  });

  test('re-sending the same selection returns the same state object (no store churn per frame)', () => {
    const state = run(initialToolFilter(['pliers']), pick(['t1'], ['screwdriver']));
    expect(run(state, pick(['t1'], ['screwdriver']))).toBe(state);
  });

  test('X with no selection and selections of unclassified items are no-ops', () => {
    const idle = initialToolFilter(['pliers']);
    expect(run(idle, { type: 'dismissOverride' })).toEqual(idle);
    expect(effectiveToolFilter(run(idle, pick(['t9'], []))).source).toBe('explicit');
  });

  test('duplicates are collapsed and the reducer does not mutate its input', () => {
    const before = initialToolFilter(['a', 'a']);
    const frozen = Object.freeze({ ...before, explicit: Object.freeze([...before.explicit]) });
    const after = run(frozen, pick(['t1', 't1'], ['x', 'x']));
    expect(before.explicit).toEqual(['a']);
    expect(after.selection).toEqual({ itemIds: ['t1'], classes: ['x'] });
  });

  test('only the explicit filter is persisted; garbage restores to an empty filter', () => {
    const state = run(initialToolFilter(['pliers']), pick(['t1'], ['screwdriver']), {
      type: 'dismissOverride',
    });
    const stored = JSON.parse(JSON.stringify(persistToolFilter(state)));
    expect(stored).toEqual({ explicit: ['pliers'] });
    const restored = restoreToolFilter(stored);
    expect(restored).toEqual(initialToolFilter(['pliers']));
    expect(restoreToolFilter(null)).toEqual(initialToolFilter());
    expect(restoreToolFilter({ explicit: 'pliers' })).toEqual(initialToolFilter());
    expect(restoreToolFilter({ explicit: ['a', 3, null, 'b'] })).toEqual(
      initialToolFilter(['a', 'b']),
    );
  });
});

describe('bank results ranked by fit for the selected tools', () => {
  test('screwdriver holders only, the one whose range centres on the shaft first', () => {
    const thick = TOOLS['screwdriver-thick'];
    if (thick === undefined) throw new Error('no tool');
    const ranked = rankHoldersForTools(BANK_HOLDERS, [thick]);
    expect(ranked.length).toBeGreaterThan(0);
    expect(
      ranked.every((entry) => entry.holder.fitsTool.some((f) => f.toolClass === 'screwdriver')),
    ).toBe(true);
    const ids = ranked.map((entry) => entry.holder.id);
    expect(ids.indexOf('screwdriver-rail-slots2-holediameter10')).toBeLessThan(
      ids.indexOf('refit-screwdriver-rail-3'),
    );
    expect(ids).not.toContain('screwdriver-rail-slots3-holediameter5'); // 2-4.6 mm holes refuse an 8.3 mm shaft
    const scores = ranked.map((entry) => entry.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test('two selected tools: holders serving both come before holders serving one', () => {
    const cable = TOOLS['cable'];
    const saw = TOOLS['saw'];
    const drv = TOOLS['screwdriver'];
    if (cable === undefined || saw === undefined || drv === undefined) throw new Error('no tool');
    const ranked = rankHoldersForTools(BANK_HOLDERS, [cable, saw, drv]);
    const fits = ranked.map((entry) => entry.fits);
    expect(fits).toEqual([...fits].sort((a, b) => b - a));
    expect(fits[0]).toBeGreaterThanOrEqual(2);
    expect(rankHoldersForTools(BANK_HOLDERS, [cable, saw, drv])).toEqual(ranked);
  });

  test('no tools selected ranks nothing; the class filter keeps elements naming any chosen class', () => {
    expect(rankHoldersForTools(BANK_HOLDERS, [])).toEqual([]);
    const byClass = holdersForClasses(BANK_HOLDERS, ['screwdriver']);
    expect(byClass.length).toBeGreaterThan(0);
    expect(
      byClass.every((holder) => holder.fitsTool.some((f) => f.toolClass === 'screwdriver')),
    ).toBe(true);
    expect(holdersForClasses(BANK_HOLDERS, [])).toHaveLength(BANK_HOLDERS.length);
  });
});
