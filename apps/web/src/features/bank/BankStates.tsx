import type { ReactNode } from 'react';
import { CheckIcon, CircleAlertIcon, PackageOpenIcon, SearchXIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { CARD_GAP, GRID_PADDING } from './filters.ts';

const SKELETON_CARDS = 8;

/** Placeholder grid while the index loads; two columns like the real panel. */
export function BankSkeleton() {
  const t = useT();
  return (
    <output aria-label={t('bank.state.loading')} className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex gap-2 px-2 pt-2" aria-hidden>
        <div className="h-8 flex-1 animate-pulse rounded-lg bg-muted" />
        <div className="size-8 animate-pulse rounded-lg bg-muted" />
      </div>
      <div
        className="grid grid-cols-2 overflow-hidden"
        style={{ gap: CARD_GAP, padding: GRID_PADDING }}
        aria-hidden
      >
        {Array.from({ length: SKELETON_CARDS }, (_, position) => (
          <div key={position} className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="aspect-square animate-pulse bg-muted" />
            <div className="flex flex-col gap-1.5 p-2">
              <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
              <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    </output>
  );
}

interface StateMessageProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}

function StateMessage({ icon, title, body, action }: StateMessageProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-64 text-xs text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}

export function BankError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  const t = useT();
  return (
    <StateMessage
      icon={<CircleAlertIcon className="size-8 text-destructive" aria-hidden />}
      title={t('bank.error.title')}
      body={message}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('bank.error.retry')}
        </Button>
      }
    />
  );
}

/** The index loaded but holds no elements: the ingestion pipeline has not run yet. */
export function BankEmpty() {
  const t = useT();
  return (
    <StateMessage
      icon={<PackageOpenIcon className="size-8" aria-hidden />}
      title={t('bank.empty.title')}
      body={t('bank.empty.body')}
    />
  );
}

export function BankNoResults({ onReset }: { readonly onReset: () => void }) {
  const t = useT();
  return (
    <StateMessage
      icon={<SearchXIcon className="size-8" aria-hidden />}
      title={t('bank.noResults.title')}
      body={t('bank.noResults.body')}
      action={
        <Button variant="outline" size="sm" onClick={onReset}>
          {t('bank.noResults.reset')}
        </Button>
      }
    />
  );
}

export interface BankNotice {
  readonly tone: 'ok' | 'error';
  readonly text: string;
}

/** Toast-like line pinned to the bottom of the panel (polite live region). */
export function NoticeLine({
  notice,
  onDismiss,
}: {
  readonly notice: BankNotice | null;
  readonly onDismiss: () => void;
}) {
  const t = useT();
  // The live region stays mounted so screen readers announce text that appears inside it.
  return (
    <output className="block">
      {notice ? (
        <div
          className={cn(
            'flex items-center gap-2 border-t px-3 py-2 text-xs',
            notice.tone === 'ok'
              ? 'border-ok/30 bg-ok/10 text-ok'
              : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          {notice.tone === 'ok' ? (
            <CheckIcon className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate">{notice.text}</span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('bank.notice.dismiss')}
            className="flex size-5 shrink-0 items-center justify-center rounded outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <XIcon className="size-3" aria-hidden />
          </button>
        </div>
      ) : null}
    </output>
  );
}
