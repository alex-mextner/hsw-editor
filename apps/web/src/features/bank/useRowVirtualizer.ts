import { useCallback, useLayoutEffect, useReducer, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualizerOptions,
} from '@tanstack/react-virtual';
import { GRID_PADDING } from './filters.ts';

export interface VirtualRow {
  readonly index: number;
  readonly start: number;
}

export interface RowVirtualizer {
  readonly rows: readonly VirtualRow[];
  readonly totalSize: number;
  readonly scrollToRow: (row: number) => void;
}

type Options = VirtualizerOptions<HTMLElement, Element>;

/**
 * Row virtualiser built on the library's framework-agnostic `Virtualizer` class. The library's own
 * React hook returns functions that are unsafe to memoise, which the React Compiler lint rejects;
 * the class lets us do the same wiring (mount, per-render options, re-render on change) and hand
 * callers only plain data: the visible rows, the total height and a scroll command.
 */
export function useRowVirtualizer(
  scroller: HTMLElement | null,
  rowCount: number,
  rowSize: number,
): RowVirtualizer {
  const [, rerender] = useReducer((tick: number) => tick + 1, 0);
  const options: Options = {
    count: rowCount,
    getScrollElement: () => scroller,
    estimateSize: () => rowSize,
    overscan: 4,
    paddingStart: GRID_PADDING,
    paddingEnd: GRID_PADDING,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: (_instance, sync) => {
      // Scrolling must paint the new rows in the same frame, or fast flings show blank gaps.
      if (sync) flushSync(rerender);
      else rerender();
    },
  };
  const [virtualizer] = useState(() => new Virtualizer<HTMLElement, Element>(options));
  virtualizer.setOptions(options);
  useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
  useLayoutEffect(() => virtualizer._willUpdate());
  // Row stride changed without a count change (card width at a breakpoint): cached offsets are stale.
  useLayoutEffect(() => virtualizer.measure(), [virtualizer, rowSize]);
  // Stable identity (the instance never changes), so callers can depend on it in memoised callbacks.
  const scrollToRow = useCallback(
    (row: number) => virtualizer.scrollToIndex(row, { align: 'auto' }),
    [virtualizer],
  );
  return {
    rows: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    scrollToRow,
  };
}
