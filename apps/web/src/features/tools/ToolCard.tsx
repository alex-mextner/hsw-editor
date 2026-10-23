import { memo, type DragEvent, type KeyboardEvent } from 'react';
import { InfoIcon, PlusIcon, UserIcon } from 'lucide-react';
import { useI18n, type Locale } from '@/i18n/index.ts';
import { entryName, type LibraryEntry } from './model.ts';
import { ToolThumb } from './ToolThumb.tsx';

interface ToolCardProps {
  readonly entry: LibraryEntry;
  readonly locale: Locale;
  readonly onAdd: (entry: LibraryEntry) => void;
  readonly onOpen: (entry: LibraryEntry) => void;
  readonly onDragStart: (event: DragEvent<HTMLElement>, entry: LibraryEntry) => void;
  readonly onDragEnd: () => void;
}

const MM_FORMAT = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

/**
 * One tool of the library: generated thumbnail, name, size, "mine" badge for the user's own tools.
 * Click or Enter puts it on the wall, the info button opens the detail page, dragging starts the
 * wall drop (the wrapper is the drag source because Firefox does not start drags on buttons).
 */
export const ToolCard = memo(function ToolCard({
  entry,
  locale,
  onAdd,
  onOpen,
  onDragStart,
  onDragEnd,
}: ToolCardProps) {
  const { t, tn } = useI18n();
  const name = entryName(entry, locale);
  const { x, y, z } = entry.dimsMm;
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'i' || event.key === 'I') {
      event.preventDefault();
      onOpen(entry);
    }
  };
  return (
    <div
      draggable
      data-testid="tool-card"
      data-tool-key={entry.key}
      onDragStart={(event) => onDragStart(event, entry)}
      onDragEnd={onDragEnd}
      className="group/card relative h-full overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/60"
    >
      <button
        type="button"
        onClick={() => onAdd(entry)}
        onKeyDown={handleKeyDown}
        draggable={false}
        aria-label={t('toolLib.card.add', { name })}
        className="flex size-full cursor-pointer flex-col text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <span className="relative block aspect-square w-full">
          <ToolThumb key={entry.thumbUrl} id={entry.key} url={entry.thumbUrl} />
        </span>
        <span className="flex min-h-14 flex-col gap-0.5 px-2 py-1.5">
          <span className="line-clamp-2 text-xs leading-4 font-medium">{name}</span>
          <span className="truncate font-mono text-[10px] leading-4 text-muted-foreground">
            {t('toolLib.card.size', {
              length: MM_FORMAT.format(y),
              width: MM_FORMAT.format(x),
              thickness: MM_FORMAT.format(z),
            })}
          </span>
          <span className="mt-auto flex flex-wrap gap-1">
            {entry.kind === 'tool' ? (
              <span
                data-testid="tool-card-mine-badge"
                title={t('toolLib.mineTitle')}
                className="inline-flex h-4 max-w-full items-center gap-1 rounded bg-primary/15 px-1 text-[10px] leading-none text-primary"
              >
                <UserIcon className="size-2.5 shrink-0" aria-hidden />
                <span className="truncate">{t('toolLib.mine')}</span>
              </span>
            ) : (
              <span className="inline-flex h-4 items-center rounded bg-muted px-1 text-[10px] leading-none text-muted-foreground">
                {tn('toolLib.card.presets', entry.presets)}
              </span>
            )}
          </span>
        </span>
      </button>
      <span className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-focus-within/card:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100">
        <button
          type="button"
          aria-label={t('toolLib.card.details', { name })}
          title={t('toolLib.card.details', { name })}
          onClick={() => onOpen(entry)}
          className="flex size-7 items-center justify-center rounded-md bg-background/90 text-foreground shadow-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          <InfoIcon className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('toolLib.card.add', { name })}
          title={t('toolLib.card.add', { name })}
          onClick={() => onAdd(entry)}
          className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          <PlusIcon className="size-4" aria-hidden />
        </button>
      </span>
    </div>
  );
});
