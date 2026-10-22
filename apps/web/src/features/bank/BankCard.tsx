import {
  memo,
  useEffect,
  useRef,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { LockIcon, PlusIcon } from 'lucide-react';
import type { BankElement } from '@hsw-editor/bank';
import { highlightSegments } from '@/bank/search.ts';
import { useI18n, type Locale } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { BANK_DRAG_TYPE, bankDragStore } from '@/scene/bankDrop.ts';
import { CARD_INFO_HEIGHT, isNavigationKey, type NavigationKey } from './filters.ts';
import { HoverPreview } from './HoverPreview.tsx';
import { cancelHoverPreview, scheduleHoverPreview } from './previewSlot.ts';
import { Thumbnail } from './Thumbnail.tsx';

/**
 * A click opens the detail view, but a double-click must add the element instead. The first click
 * therefore waits this long for a second one; keyboard activation is not delayed.
 */
const DOUBLE_CLICK_WINDOW_MS = 350;

function Highlighted({ text, query }: { readonly text: string; readonly query: string }) {
  return (
    <>
      {highlightSegments(text, query).map((segment, position) =>
        segment.match ? (
          <mark key={position} className="rounded-sm bg-primary/30 text-inherit">
            {segment.text}
          </mark>
        ) : (
          <span key={position}>{segment.text}</span>
        ),
      )}
    </>
  );
}

interface BankCardProps {
  readonly element: BankElement;
  readonly locale: Locale;
  readonly query: string;
  readonly position: number;
  /** Roving tab stop: exactly one card in the grid is reachable with Tab. */
  readonly tabStop: boolean;
  readonly previewing: boolean;
  readonly onOpen: (element: BankElement) => void;
  readonly onAdd: (element: BankElement) => void;
  readonly onNavigate: (position: number, key: NavigationKey) => void;
  readonly onFocusCard: (position: number) => void;
}

export const BankCard = memo(function BankCard({
  element,
  locale,
  query,
  position,
  tabStop,
  previewing,
  onOpen,
  onAdd,
  onNavigate,
  onFocusCard,
}: BankCardProps) {
  const { t, tn } = useI18n();
  const clickTimer = useRef<number | undefined>(undefined);
  const name = element.name[locale];
  const { cols, rows } = element.footprint;
  const { spdx, redistributable } = element.license;
  const addLabel = t('bank.card.add', { name });

  useEffect(
    () => () => {
      window.clearTimeout(clickTimer.current);
      // A card scrolled out of the virtual window must not leave its preview canvas alive.
      cancelHoverPreview(element.id);
    },
    [element.id],
  );

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    window.clearTimeout(clickTimer.current);
    // Only the second click adds; a third click of a triple must not add again.
    if (event.detail === 2) onAdd(element);
    else if (event.detail > 2) return;
    // Keyboard activation (detail 0) has no double-click to wait for.
    else if (event.detail === 0) onOpen(element);
    else clickTimer.current = window.setTimeout(() => onOpen(element), DOUBLE_CLICK_WINDOW_MS);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Enter') {
      // Enter would otherwise synthesise a click and open the detail view.
      event.preventDefault();
      if (!event.repeat) onAdd(element);
    } else if (isNavigationKey(event.key)) {
      event.preventDefault();
      onNavigate(position, event.key);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>): void => {
    cancelHoverPreview(element.id);
    event.dataTransfer.setData(BANK_DRAG_TYPE, element.id);
    event.dataTransfer.effectAllowed = 'copy';
    bankDragStore.set(element.id);
    const image = event.currentTarget.querySelector('img');
    if (image) event.dataTransfer.setDragImage(image, image.width / 2, image.height / 2);
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={() => bankDragStore.set(null)}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') scheduleHoverPreview(element.id);
      }}
      onPointerLeave={() => cancelHoverPreview(element.id)}
      className="group/card relative h-full overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/60"
    >
      <button
        type="button"
        data-card-main={position}
        tabIndex={tabStop ? 0 : -1}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onFocus={() => onFocusCard(position)}
        draggable={false}
        className="flex size-full cursor-pointer flex-col text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <span className="relative block aspect-square w-full">
          <Thumbnail element={element} />
          {previewing ? <HoverPreview element={element} /> : null}
          <span
            title={`${t('bank.card.footprint', { cols, rows })}, ${tn('bank.cells', element.footprint.cells.length)}`}
            className="absolute bottom-1 left-1 rounded bg-background/80 px-1 font-mono text-[10px] leading-4 text-muted-foreground backdrop-blur-sm"
          >
            {cols}×{rows}
          </span>
        </span>
        <span className="flex flex-col gap-0.5 px-2 py-1.5" style={{ height: CARD_INFO_HEIGHT }}>
          <span className="line-clamp-2 text-xs leading-4 font-medium">
            <Highlighted text={name} query={query} />
          </span>
          {element.variantLabel ? (
            <span className="truncate text-[11px] leading-4 text-muted-foreground">
              {element.variantLabel[locale]}
            </span>
          ) : null}
          <span className="mt-auto flex">
            <span
              title={redistributable ? spdx : t('bank.license.localOnlyTitle', { spdx })}
              className={cn(
                'inline-flex h-4 max-w-full items-center gap-1 rounded px-1 text-[10px] leading-none',
                redistributable
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {redistributable ? null : <LockIcon className="size-2.5 shrink-0" aria-hidden />}
              <span className="truncate">
                {redistributable ? spdx : t('bank.license.localOnly')}
              </span>
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={addLabel}
        title={addLabel}
        onClick={(event) => {
          if (event.detail <= 1) onAdd(element);
        }}
        className="absolute top-1 right-1 flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground opacity-0 shadow-sm transition-opacity outline-none group-focus-within/card:opacity-100 group-hover/card:opacity-100 focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/60 [@media(hover:none)]:opacity-100"
      >
        <PlusIcon className="size-4" aria-hidden />
      </button>
    </div>
  );
});
