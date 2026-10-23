import { describe, expect, test } from 'bun:test';
import type { HistoryEntry } from '@hsw-editor/core';
import { planUndoTo, undoStack, undoTargets, UNDO_WINDOW, windowStart } from './historyUndo.ts';

const ACTOR = { kind: 'human', name: 'test' } as const;
const NOOP = { type: 'lock', id: 'i1', locked: true } as const;

function entry(kind: 'op' | 'undo' | 'redo', rev: number): HistoryEntry {
  return { kind, rev, ts: '2026-10-23T00:00:00Z', actor: ACTOR, op: NOOP, inverse: NOOP };
}

describe('undo stack replay', () => {
  test('ops push, undo pops, redo pushes again', () => {
    const history = [entry('op', 1), entry('op', 2), entry('op', 3), entry('undo', 4)];
    expect(undoStack(history)).toEqual([1, 2]);
    expect(undoStack([...history, entry('redo', 5)])).toEqual([1, 2, 5]);
  });

  test('a new op after an undo drops the redo branch', () => {
    const history = [entry('op', 1), entry('op', 2), entry('undo', 3), entry('op', 4)];
    expect(undoStack(history)).toEqual([1, 4]);
  });

  test('entries are replayed in revision order whatever the input order', () => {
    expect(undoStack([entry('undo', 3), entry('op', 2), entry('op', 1)])).toEqual([1]);
  });

  test('the create entry is ignored', () => {
    const create: HistoryEntry = {
      kind: 'create',
      rev: 0,
      ts: '2026-10-23T00:00:00Z',
      actor: ACTOR,
      wall: {} as never,
    };
    expect(undoStack([create, entry('op', 1)])).toEqual([1]);
  });
});

describe('planUndoTo', () => {
  const history = [entry('op', 1), entry('op', 2), entry('op', 3)];

  test('counts the edits above the target', () => {
    expect(planUndoTo(history, 3, 0)).toEqual({ ok: true, steps: 0 });
    expect(planUndoTo(history, 2, 0)).toEqual({ ok: true, steps: 1 });
    expect(planUndoTo(history, 1, 0)).toEqual({ ok: true, steps: 2 });
  });

  test('an edit that was already undone is not a target', () => {
    expect(planUndoTo([...history, entry('undo', 4)], 3, 0)).toEqual({
      ok: false,
      reason: 'unreachable',
    });
    expect(planUndoTo(history, 99, 0)).toEqual({ ok: false, reason: 'unreachable' });
  });

  test('unconfirmed edits of this tab make the count unreliable, so it is refused', () => {
    expect(planUndoTo(history, 2, 1)).toEqual({ ok: false, reason: 'pending' });
  });

  test('a window that starts part-way still counts exactly from edits inside it', () => {
    // Full history: ops 1..6, undo (7) of 6, op 8. The window starts after rev 3.
    const full = [
      entry('op', 1),
      entry('op', 2),
      entry('op', 3),
      entry('op', 4),
      entry('op', 5),
      entry('op', 6),
      entry('undo', 7),
      entry('op', 8),
    ];
    const window = full.filter((e) => e.rev > 3);
    expect(planUndoTo(window, 5, 0)).toEqual(planUndoTo(full, 5, 0));
    expect(planUndoTo(window, 4, 0)).toEqual({ ok: true, steps: 2 });
  });

  test('a target older than the window is unreachable instead of miscounted', () => {
    const window = [entry('op', 5), entry('op', 6)];
    expect(planUndoTo(window, 2, 0)).toEqual({ ok: false, reason: 'unreachable' });
  });

  test('an undo inside the window of an edit below it does not disturb the steps above', () => {
    // Edit 2 (below the window) is undone at rev 5; ops 4 and 6 are the window's own.
    const window = [entry('op', 4), entry('undo', 5), entry('undo', 6), entry('op', 7)];
    expect(undoStack(window)).toEqual([7]);
    expect(planUndoTo(window, 7, 0)).toEqual({ ok: true, steps: 0 });
  });
});

describe('window', () => {
  test('ends at the current revision and never goes below zero', () => {
    expect(windowStart(10)).toBe(0);
    expect(windowStart(UNDO_WINDOW + 50)).toBe(50);
  });
});

describe('undoTargets', () => {
  test('newest first and limited', () => {
    const history = [entry('op', 1), entry('op', 2), entry('op', 3)];
    expect(undoTargets(history, 2)).toEqual([3, 2]);
  });
});
