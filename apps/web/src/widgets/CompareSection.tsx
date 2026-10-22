import { useMemo, useState } from 'react';
import { GitCompareIcon } from 'lucide-react';
import type { WallItem } from '@hsw-editor/core';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { CompareWidget } from './CompareWidget.tsx';
import { pickCompareIds } from './compareMath.ts';

/**
 * Inspector section: the reference-model candidates collected for `item`, with a button that opens
 * the compare widget on them. Hidden when the item has none.
 */
export function CompareSection({ item }: { readonly item: WallItem }) {
  const { t, tn } = useI18n();
  const wall = useStore(sessionStore)?.wall ?? null;
  const [open, setOpen] = useState(false);
  const models = useMemo(
    () => (wall ? wall.models.filter((model) => model.forItemId === item.id) : []),
    [wall, item.id],
  );
  const compareIds = useMemo(() => pickCompareIds(models), [models]);
  if (models.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" aria-label={t('compare.section')}>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t('compare.section')}
      </h3>
      <ul className="flex flex-col gap-1">
        {models.map((model) => (
          <li key={model.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate" title={model.label}>
              {model.label}
            </span>
            {model.score === undefined ? null : (
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(model.score * 100)}%
              </span>
            )}
            <Badge
              variant={model.status === 'rejected' ? 'destructive' : 'secondary'}
              className={model.status === 'chosen' ? 'bg-ok/15 text-ok' : undefined}
            >
              {t(`compare.status.${model.status}`)}
            </Badge>
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <GitCompareIcon aria-hidden />
        {t('compare.open')}
        <span className="text-muted-foreground">({compareIds.length})</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{t('compare.title')}</DialogTitle>
            <DialogDescription>{tn('compare.candidates', compareIds.length)}</DialogDescription>
          </DialogHeader>
          <CompareWidget modelRefIds={compareIds} itemId={item.id} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </section>
  );
}
