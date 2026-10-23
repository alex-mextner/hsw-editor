import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-react';
import type { OmpSessionStatus } from '@hsw-editor/omp-protocol';
import { Button } from '@/components/ui/button.tsx';
import { IconButton } from '@/components/IconButton.tsx';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import type { Notice, RetryInfo } from './conversation.ts';
import type { ConnectionPhase } from './render-types.ts';

function Banner({ tone, children }: { tone: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const className = cn(
    'flex items-start gap-2 border-b px-3 py-1.5 text-xs',
    tone === 'error' && 'border-destructive/40 bg-destructive/10 text-destructive',
    tone === 'warn' && 'border-border bg-muted/60',
    tone === 'info' && 'border-border bg-muted/30 text-muted-foreground',
  );
  return tone === 'error' ? (
    <div role="alert" className={className}>
      {children}
    </div>
  ) : (
    <output className={className}>{children}</output>
  );
}

/** Whole seconds until `deadline` (epoch ms); re-renders twice a second while one is pending. */
function useCountdown(deadline: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === undefined ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function ConnectionBanner({
  phase,
  server,
  loaded,
  onRestart,
}: {
  phase: ConnectionPhase;
  server: OmpSessionStatus | null;
  loaded: boolean;
  onRestart: () => void;
}) {
  const t = useT();
  const countdown = useCountdown(server?.phase === 'restarting' ? server.restartAt : undefined);
  if (phase === 'connecting') {
    return (
      <Banner tone="info">
        <Loader2 className="mt-0.5 size-3.5 animate-spin" />
        {t('omp.status.connecting')}
      </Banner>
    );
  }
  if (phase === 'reconnecting' || phase === 'closed') {
    return (
      <Banner tone="warn">
        <Loader2 className="mt-0.5 size-3.5 animate-spin" />
        {phase === 'closed' ? t('omp.status.closed') : t('omp.status.reconnecting')}
      </Banner>
    );
  }
  if (server === null) return null;
  switch (server.phase) {
    case 'starting':
    case 'idle':
      return (
        <Banner tone="info">
          <Loader2 className="mt-0.5 size-3.5 animate-spin" />
          {t('omp.status.starting')}
        </Banner>
      );
    case 'restarting':
      return (
        <Banner tone="warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {t('omp.status.restarting', {
              seconds: countdown ?? 0,
              attempt: server.restartAttempt,
            })}
            {server.error ? (
              <span className="block break-words text-muted-foreground">{server.error}</span>
            ) : null}
          </span>
        </Banner>
      );
    case 'failed':
    case 'stopped':
      return (
        <Banner tone={server.phase === 'failed' ? 'error' : 'warn'}>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {server.phase === 'failed' ? t('omp.status.failed') : t('omp.status.stopped')}
            {server.error ? (
              <span className="block break-words opacity-90">{server.error}</span>
            ) : null}
            {server.stderrTail && server.stderrTail.length > 0 ? (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-1 text-[10px] opacity-90">
                {server.stderrTail.join('\n')}
              </pre>
            ) : null}
          </span>
          <Button size="xs" variant="outline" onClick={onRestart}>
            <RefreshCw />
            {t('omp.restart')}
          </Button>
        </Banner>
      );
    case 'ready':
      return loaded ? null : (
        <Banner tone="info">
          <Loader2 className="mt-0.5 size-3.5 animate-spin" />
          {t('omp.status.loading')}
        </Banner>
      );
  }
}

export function ActivityBanners({
  retry,
  compacting,
}: {
  retry: RetryInfo | null;
  compacting: boolean;
}) {
  const t = useT();
  const countdown = useCountdown(retry?.until);
  return (
    <>
      {retry !== null && (
        <Banner tone="warn">
          <RefreshCw className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {t('omp.retry', {
              attempt: retry.attempt,
              max: retry.maxAttempts,
              seconds: countdown ?? 0,
              error: retry.errorMessage,
            })}
          </span>
        </Banner>
      )}
      {compacting && (
        <Banner tone="info">
          <Loader2 className="mt-0.5 size-3.5 animate-spin" />
          {t('omp.compacting')}
        </Banner>
      )}
    </>
  );
}

export function NoticeList({
  notices,
  dismissed,
  onDismiss,
}: {
  notices: readonly Notice[];
  dismissed: ReadonlySet<number>;
  onDismiss: (id: number) => void;
}) {
  const t = useT();
  const visible = notices
    .filter((notice) => !dismissed.has(notice.id) && notice.level !== 'info')
    .slice(-3);
  return (
    <>
      {visible.map((notice) => (
        <Banner key={notice.id} tone={notice.level === 'error' ? 'error' : 'warn'}>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          <IconButton
            label={t('omp.notice.dismiss')}
            size="icon-xs"
            onClick={() => onDismiss(notice.id)}
          >
            <X />
          </IconButton>
        </Banner>
      ))}
    </>
  );
}
