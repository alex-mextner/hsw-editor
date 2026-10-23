import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { resolveConflict, sessionStore } from '@/wall/session.ts';

/**
 * Shown when edits made offline clash with what changed on the daemon meanwhile (same field, an item removed or locked, or a
 * daemon older than this device). Nothing is sent until the user picks: rebase (mine on top of theirs), keep mine (also
 * restores what the other side removed) or keep theirs (drop my clashing edits).
 */
export function ConflictDialog() {
  const { t, tn } = useI18n();
  const conflict = useStore(sessionStore)?.conflict ?? null;
  return (
    <Dialog open={conflict !== null}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        {conflict ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('conflict.title')}</DialogTitle>
              <DialogDescription>
                {conflict.plan.diverged
                  ? t('conflict.diverged')
                  : tn('conflict.count', conflict.plan.conflicts.length)}
              </DialogDescription>
            </DialogHeader>
            <ul className="max-h-40 list-disc overflow-auto pl-5 text-sm text-muted-foreground">
              {conflict.plan.conflicts.map((entry) => (
                <li key={entry.edit.id}>
                  {entry.status === 'overlap'
                    ? t('conflict.overlap', { what: entry.overlapping.join(', ') })
                    : t('conflict.refused', { reason: entry.message ?? entry.code ?? '' })}
                </li>
              ))}
            </ul>
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button onClick={() => resolveConflict('rebase')}>{t('conflict.rebase')}</Button>
              <Button variant="outline" onClick={() => resolveConflict('keepMine')}>
                {t('conflict.keepMine')}
              </Button>
              <Button variant="outline" onClick={() => resolveConflict('keepTheirs')}>
                {t('conflict.keepTheirs')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
