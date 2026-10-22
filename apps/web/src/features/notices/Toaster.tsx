import { useEffect, useRef } from 'react';
import { CircleAlert, Info, X } from 'lucide-react';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { dismiss, notify, toastStore } from './notices.ts';

/** Bottom-centre toast stack; also turns sync notices (refused edits, conflicts) into toasts. */
export function Toaster() {
  const { t } = useI18n();
  const toasts = useStore(toastStore);
  const notice = useStore(sessionStore)?.notice ?? null;
  // Notice ids restart per WallSync, so identity (not id) tells a new notice from a repeat render.
  const shown = useRef<typeof notice>(null);

  useEffect(() => {
    if (!notice || notice === shown.current) return;
    shown.current = notice;
    notify('error', t('sync.rejected', { reason: notice.message }));
  }, [notice, t]);

  return (
    <output
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg',
            toast.kind === 'error' ? 'border-destructive/50' : 'border-border',
          )}
        >
          {toast.kind === 'error' ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="break-words">{toast.text}</span>
            {toast.actions.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {toast.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="rounded-md border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted"
                    onClick={action.run}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label={t('action.close')}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => dismiss(toast.id)}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </output>
  );
}
