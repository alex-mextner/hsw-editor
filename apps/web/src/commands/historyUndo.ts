/**
 * "Undo back to this edit": the server undoes the top of a stack that an op pushes, an undo pops
 * and a redo pushes again (apps/server wall-store `advanceStacks`). Replaying the history the same
 * way tells how many undo steps lead to the state right after a chosen edit.
 *
 * The replay may start part-way through the history: the part of the stack below the window is
 * unknown, but everything above any edit inside the window is exact, which is all a step count needs.
 */
import type { HistoryEntry } from '@hsw-editor/core';

/** How far back from the current revision the palette looks for edits to undo back to. */
export const UNDO_WINDOW = 2000;

/** First history revision to request so the window ends at `currentRev`. */
export function windowStart(currentRev: number): number {
  return Math.max(0, currentRev - UNDO_WINDOW);
}

/** Revisions of the edits an undo would take back, oldest first. */
export function undoStack(entries: readonly HistoryEntry[]): readonly number[] {
  const stack: number[] = [];
  for (const entry of [...entries].sort((a, b) => a.rev - b.rev)) {
    if (entry.kind === 'op' || entry.kind === 'redo') stack.push(entry.rev);
    else if (entry.kind === 'undo') stack.pop();
  }
  return stack;
}

export type UndoPlan =
  | { readonly ok: true; readonly steps: number }
  | { readonly ok: false; readonly reason: 'pending' | 'unreachable' };

/**
 * Undo steps from now to the wall as it was right after revision `rev`. Refused while edits are
 * still unconfirmed (the server has not seen them, so the count would be off by those) and when
 * `rev` is not an edit that can still be undone back to inside the history window.
 */
export function planUndoTo(
  entries: readonly HistoryEntry[],
  rev: number,
  pendingEdits: number,
): UndoPlan {
  if (pendingEdits > 0) return { ok: false, reason: 'pending' };
  const stack = undoStack(entries);
  const index = stack.indexOf(rev);
  return index < 0
    ? { ok: false, reason: 'unreachable' }
    : { ok: true, steps: stack.length - 1 - index };
}

/** The newest `limit` edits that can be undone back to, newest first. */
export function undoTargets(entries: readonly HistoryEntry[], limit: number): readonly number[] {
  return undoStack(entries).slice(-limit).reverse();
}
