import { CloudOff, Loader2, TriangleAlert } from 'lucide-react';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';

/** Save state of the open wall: saved / saving N edits / offline (edits queued) / error. */
export function SyncStatus() {
  const { t, tn } = useI18n();
  const session = useStore(sessionStore);
  if (!session) return null;
  if (session.status === 'offline') {
    return (
      <span className="flex items-center gap-1 text-xs text-warn" title={t('sync.offlineHint')}>
        <CloudOff className="size-3.5" aria-hidden />
        <span className="max-sm:hidden">{t('sync.offline')}</span>
        {session.pending > 0 ? <span>{session.pending}</span> : null}
      </span>
    );
  }
  if (session.status === 'error') {
    return (
      <span
        className="flex items-center gap-1 text-xs text-destructive"
        title={session.errorMessage ?? ''}
      >
        <TriangleAlert className="size-3.5" aria-hidden />
        <span className="max-sm:hidden">{t('sync.error')}</span>
      </span>
    );
  }
  if (session.pending > 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        <span className="max-sm:hidden">{tn('sync.saving', session.pending)}</span>
      </span>
    );
  }
  if (session.status === 'ready') {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        title={t('sync.rev', { rev: session.confirmedRev })}
      >
        <span className="size-1.5 rounded-full bg-ok" aria-hidden />
        <span className="max-sm:hidden">{t('sync.saved')}</span>
      </span>
    );
  }
  return null;
}
