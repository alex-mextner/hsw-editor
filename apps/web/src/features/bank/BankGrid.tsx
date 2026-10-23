import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BankElement } from '@hsw-editor/bank';
import { useI18n, type Locale } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { BankCard } from './BankCard.tsx';
import {
  cardHeight,
  cardWidth,
  CARD_GAP,
  GRID_PADDING,
  gridColumns,
  isNavigationKey,
  moveIndex,
  rowStride,
  type NavigationKey,
} from './filters.ts';
import { gridScrollMemory } from './panelState.ts';
import { cancelHoverPreview, hoverSlotKey, previewSlotStore } from './previewSlot.ts';
import { useRowVirtualizer } from './useRowVirtualizer.ts';

/** Content width of the scroll container, kept current by a ResizeObserver. */
function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

interface BankGridProps {
  readonly elements: readonly BankElement[];
  readonly locale: Locale;
  readonly query: string;
  /** Changes whenever the result list is a different one: scroll and focus return to the top. */
  readonly resetKey: string;
  readonly onOpen: (element: BankElement) => void;
  readonly onAdd: (element: BankElement) => void;
}

/**
 * Virtualised card grid: only the rows in (or just around) the viewport exist in the DOM. Card and row
 * heights are computed from the container width instead of measured, so scrolling never reflows.
 * Arrow keys, Home and End move focus between cards (roving tab stop).
 */
export function BankGrid({ elements, locale, query, resetKey, onOpen, onAdd }: BankGridProps) {
  const { t } = useI18n();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(scroller);
  const columns = gridColumns(width);
  const itemWidth = cardWidth(width, columns);
  const rowTotal = Math.ceil(elements.length / columns);
  const previewSlot = useStore(previewSlotStore);
  const [focusIndex, setFocusIndex] = useState(0);
  const pendingFocus = useRef(false);
  const lastResetKey = useRef(resetKey);

  const { rows, totalSize, scrollToRow } = useRowVirtualizer(
    scroller,
    rowTotal,
    rowStride(itemWidth),
  );

  // The side panel is display:none while closed (width 0) and browsers drop the scroll offset then.
  const visible = width > 0;
  useLayoutEffect(() => {
    if (visible && scroller) scroller.scrollTo({ top: gridScrollMemory.top });
  }, [visible, scroller]);

  useLayoutEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    scroller?.scrollTo({ top: 0 });
    setFocusIndex(0);
  }, [resetKey, scroller]);

  // After a keyboard move the target card may not exist yet (scrollToRow brings its row into the
  // window), so focusing retries after every render until the card is there.
  useEffect(() => {
    if (!pendingFocus.current) return;
    const target = scroller?.querySelector<HTMLElement>(`[data-card-main="${focusIndex}"]`);
    if (!target) return;
    pendingFocus.current = false;
    target.focus({ preventScroll: true });
  });

  const navigate = (from: number, key: NavigationKey): void => {
    const next = moveIndex(from, key, columns, elements.length);
    // At the grid edge there is no move, so no re-render would ever consume the flag.
    if (next === from) return;
    setFocusIndex(next);
    pendingFocus.current = true;
    scrollToRow(Math.floor(next / columns));
  };

  const firstCard = (rows[0]?.index ?? 0) * columns;
  const lastCard = Math.min(elements.length - 1, ((rows.at(-1)?.index ?? 0) + 1) * columns - 1);
  // The remembered card may have been virtualised away; keep one rendered card tabbable regardless.
  const tabStop = Math.min(Math.max(focusIndex, firstCard), lastCard);

  return (
    <div
      ref={setScroller}
      role="presentation"
      // Arrow/Home/End keys bubble up from the focused card: one handler here instead of a new
      // callback per card keeps memo(BankCard) effective across scroll-frame re-renders.
      onKeyDown={(event) => {
        const card =
          event.target instanceof HTMLElement ? event.target.dataset['cardMain'] : undefined;
        if (card === undefined || !isNavigationKey(event.key)) return;
        event.preventDefault();
        navigate(Number(card), event.key);
      }}
      onScroll={(event) => {
        if (event.currentTarget.clientWidth > 0)
          gridScrollMemory.top = event.currentTarget.scrollTop;
        cancelHoverPreview();
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <ul
        aria-label={t('bank.grid.label')}
        className="relative w-full"
        style={{ height: totalSize }}
      >
        {visible
          ? rows.map((row) => (
              <li
                key={row.index}
                className="absolute grid"
                style={{
                  top: 0,
                  left: GRID_PADDING,
                  right: GRID_PADDING,
                  height: cardHeight(itemWidth),
                  gap: CARD_GAP,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  transform: `translateY(${row.start}px)`,
                }}
              >
                {elements
                  .slice(row.index * columns, (row.index + 1) * columns)
                  .map((element, i) => {
                    const position = row.index * columns + i;
                    return (
                      <BankCard
                        key={element.id}
                        element={element}
                        locale={locale}
                        query={query}
                        position={position}
                        tabStop={position === tabStop}
                        previewing={previewSlot === hoverSlotKey(element.id)}
                        onOpen={onOpen}
                        onAdd={onAdd}
                        onFocusCard={setFocusIndex}
                      />
                    );
                  })}
              </li>
            ))
          : null}
      </ul>
    </div>
  );
}
