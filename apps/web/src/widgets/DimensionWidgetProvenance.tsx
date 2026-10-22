import { useId } from 'react';
import { Bot, Lock, LockOpen, ScanSearch } from 'lucide-react';
import type { WallItem } from '@hsw-editor/core';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { submitOps } from '@/wall/session.ts';

function confidenceTone(confidence: number): string {
  if (confidence >= 0.8) return 'text-ok';
  return confidence >= 0.5 ? 'text-warn' : 'text-destructive';
}

function setLocked(item: WallItem, locked: boolean): void {
  submitOps([{ type: 'lock', id: item.id, locked }], locked ? 'lock-items' : 'unlock-items');
}

/**
 * Where the values came from (photo fit or agent) and the "keep my values" switch. Locking is the
 * mechanism that makes a user's numbers win: the reducer refuses later edits to a locked item, so
 * re-fits and agent runs cannot override them.
 */
export function DimensionWidgetProvenance({ item }: { readonly item: WallItem }) {
  const t = useT();
  const keepId = useId();
  const { type, confidence, by } = item.source;
  const fitted = type !== 'manual';

  return (
    <div className="grid gap-1.5" data-slot="dimension-provenance">
      {fitted ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="gap-1">
              {type === 'vision' ? <ScanSearch /> : <Bot />}
              {type === 'vision' ? t('widgets.provenance.vision') : t('widgets.provenance.agent')}
            </Badge>
            {confidence !== undefined ? (
              <span className={cn('font-mono text-[11px]', confidenceTone(confidence))}>
                {t('widgets.provenance.confidence', { percent: Math.round(confidence * 100) })}
              </span>
            ) : null}
            {by !== undefined ? (
              <span className="truncate text-[11px] text-muted-foreground">
                {t('widgets.provenance.by', { by })}
              </span>
            ) : null}
          </div>
          <Tooltip>
            <TooltipTrigger
              render={<div className="flex w-fit items-center gap-2 text-xs select-none" />}
            >
              <Switch
                id={keepId}
                size="sm"
                checked={item.locked}
                onCheckedChange={(next) => setLocked(item, next)}
              />
              <Label htmlFor={keepId} className="cursor-pointer text-xs font-normal">
                {t('widgets.provenance.keep')}
              </Label>
            </TooltipTrigger>
            <TooltipContent className="max-w-60 whitespace-normal">
              {t('widgets.provenance.keepHint')}
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
      {item.locked ? (
        <div className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
          <Lock className="size-3 shrink-0" />
          <span className="min-w-0 flex-1">{t('widgets.dimensions.lockedHint')}</span>
          {fitted ? null : (
            <Button variant="ghost" size="xs" onClick={() => setLocked(item, false)}>
              <LockOpen />
              {t('widgets.dimensions.unlock')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
