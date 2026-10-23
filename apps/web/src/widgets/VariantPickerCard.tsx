import { Check, Plus } from 'lucide-react';
import type { BankElement } from '@hsw-editor/bank';
import { bankRoutes } from '@/bank/client.ts';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';

export interface Candidate {
  readonly element: BankElement;
  /** Fit quality in [0, 1] for a tool's holder suggestions; null for plain family variants. */
  readonly score: number | null;
  /** How many objects the holder takes for the tool's class; null when unknown or not a suggestion. */
  readonly capacity: number | null;
}

function scoreTone(score: number): string {
  if (score >= 0.75) return 'bg-ok';
  return score >= 0.4 ? 'bg-warn' : 'bg-destructive';
}

interface VariantPickerCardProps {
  readonly candidate: Candidate;
  readonly current: boolean;
  readonly disabled: boolean;
  /** Tool mode: picking adds a new holder instead of replacing the current one. */
  readonly adds: boolean;
  readonly onPick: () => void;
}

/** One thumbnail card of the carousel; a single button so keyboard and touch behave the same. */
export function VariantPickerCard({
  candidate,
  current,
  disabled,
  adds,
  onPick,
}: VariantPickerCardProps) {
  const { locale, t, tn } = useI18n();
  const { element, score, capacity } = candidate;
  const inert = disabled || current;
  const percent = score === null ? null : Math.round(score * 100);

  return (
    <button
      type="button"
      data-candidate
      aria-current={current ? 'true' : undefined}
      // aria-disabled instead of `disabled`: the current card must stay reachable by arrow keys.
      aria-disabled={inert}
      onClick={() => {
        if (!inert) onPick();
      }}
      className={cn(
        'group/card relative flex w-28 shrink-0 snap-start flex-col gap-1 rounded-lg border border-border bg-card p-1.5 text-left text-xs transition-colors outline-none',
        'focus-visible:ring-3 focus-visible:ring-ring/50',
        inert ? 'cursor-default' : 'hover:bg-muted',
        current && 'border-primary bg-accent ring-1 ring-primary',
        disabled && !current && 'opacity-50',
      )}
    >
      <span className="relative flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted">
        <img
          src={bankRoutes.asset(element.assets.thumbnail.path)}
          alt=""
          loading="lazy"
          draggable={false}
          className="size-full object-contain"
        />
        {current ? (
          <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3" aria-hidden />
            <span className="sr-only">{t('widgets.variants.current')}</span>
          </span>
        ) : null}
        {adds && !disabled ? (
          <span className="absolute right-1 bottom-1 flex h-5 items-center gap-0.5 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground opacity-90 group-hover/card:opacity-100">
            <Plus className="size-3" aria-hidden />
            {t('widgets.variants.add')}
          </span>
        ) : null}
      </span>
      <span className="line-clamp-2 min-h-8 leading-4 font-medium">{element.name[locale]}</span>
      {element.variantLabel ? (
        <span className="truncate text-[11px] text-muted-foreground">
          {element.variantLabel[locale]}
        </span>
      ) : null}
      {percent !== null && score !== null ? (
        <span className="grid gap-0.5">
          {/* The native meter carries the semantics; the bar below is its visual twin. */}
          <meter
            min={0}
            max={100}
            value={percent}
            aria-label={t('widgets.variants.fit', { percent })}
            className="sr-only"
          />
          <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn('block h-full', scoreTone(score))}
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {t('widgets.variants.fit', { percent })}
            {capacity !== null ? ` · ${tn('widgets.variants.capacity', capacity)}` : ''}
          </span>
        </span>
      ) : null}
    </button>
  );
}
