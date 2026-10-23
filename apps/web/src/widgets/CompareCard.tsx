import { useMemo, type ReactNode } from 'react';
import { CheckIcon, ExternalLinkIcon, XIcon } from 'lucide-react';
import type { ModelRef } from '@hsw-editor/core';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import {
  AXES,
  deltaTone,
  dimensionDelta,
  safeExternalUrl,
  type DeltaTone,
  type Reference,
} from './compareMath.ts';
import { ScoreBar } from './ScoreBar.tsx';

interface CompareCardProps {
  readonly model: ModelRef;
  readonly color: string;
  readonly reference: Reference | null;
  /** The item is locked: accepting still marks the model, but cannot switch the item to it. */
  readonly itemLocked: boolean;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onReject: () => void;
  /** The 3D tile (side-by-side mode); the shared overlay/ghost views render it elsewhere. */
  readonly viewport?: ReactNode;
}

const TONE_CLASS: Readonly<Record<DeltaTone, string>> = {
  same: 'text-muted-foreground',
  minor: 'text-warn',
  major: 'text-destructive font-medium',
};

export function CompareCard({
  model,
  color,
  reference,
  itemLocked,
  busy,
  onAccept,
  onReject,
  viewport,
}: CompareCardProps) {
  const { t, locale } = useI18n();
  const number = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const signed = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: 'exceptZero' }),
    [locale],
  );
  const url = safeExternalUrl(model.source.url);
  const rejected = model.status === 'rejected';
  const dims = model.dimensionsMm;
  const delta = dims && reference ? dimensionDelta(dims, reference.dims) : null;

  return (
    <article
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-2 text-card-foreground',
        model.status === 'chosen' ? 'border-ok/60' : 'border-border',
        rejected && 'opacity-60',
      )}
      aria-label={model.label}
    >
      {viewport}
      <header className="relative z-10 flex items-center gap-2">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={model.label}>
          {model.label}
        </h3>
        {model.status === 'chosen' ? (
          <Badge className="bg-ok/15 text-ok">{t('compare.status.chosen')}</Badge>
        ) : (
          <Badge variant={rejected ? 'destructive' : 'secondary'}>
            {t(`compare.status.${model.status}`)}
          </Badge>
        )}
      </header>

      {model.score === undefined ? null : (
        <div className="relative z-10 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('compare.score')}</span>
          <ScoreBar score={model.score} />
          <span className="w-9 text-right tabular-nums">{Math.round(model.score * 100)}%</span>
        </div>
      )}

      <div className="relative z-10">
        {dims ? (
          <dl className="grid grid-cols-3 gap-1 text-xs tabular-nums">
            {AXES.map((axis) => {
              const change = delta?.[axis];
              const refValue = reference?.dims[axis];
              return (
                <div key={axis} className="flex flex-col rounded bg-muted/50 px-1.5 py-1">
                  <dt className="text-[0.65rem] text-muted-foreground uppercase">{axis}</dt>
                  <dd>
                    {number.format(dims[axis])}{' '}
                    <span className="text-muted-foreground">{t('compare.mm')}</span>
                    {change === undefined || refValue === undefined ? null : (
                      <span className={cn('ml-1', TONE_CLASS[deltaTone(change, refValue)])}>
                        {signed.format(change)}
                      </span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">{t('compare.noDims')}</p>
        )}
        {delta && reference ? (
          <p className="mt-1 text-[0.7rem] text-muted-foreground">
            {t(reference.source === 'item' ? 'compare.delta.vsItem' : 'compare.delta.vsOthers')}
          </p>
        ) : null}
      </div>

      {model.notes ? (
        <p className="relative z-10 line-clamp-2 text-xs text-muted-foreground">{model.notes}</p>
      ) : null}

      <p className="relative z-10 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span>{t(`compare.source.${model.source.type}`)}</span>
        {model.source.by ? <span>· {t('compare.by', { name: model.source.by })}</span> : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-0.5 text-primary hover:underline"
          >
            <span className="truncate">{t('compare.openSource')}</span>
            <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
          </a>
        ) : null}
      </p>

      <footer className="relative z-10 mt-auto flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={onAccept} disabled={busy}>
          <CheckIcon aria-hidden />
          {t('compare.accept')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onReject} disabled={busy || rejected}>
          <XIcon aria-hidden />
          {t('compare.reject')}
        </Button>
        {itemLocked && model.bankId !== undefined ? (
          <span className="text-[0.7rem] text-warn">{t('compare.itemLocked')}</span>
        ) : null}
      </footer>
    </article>
  );
}
