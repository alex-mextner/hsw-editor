import { useEffect, useRef, useState } from 'react';
import { Bot, Redo2, Terminal, Undo2, User } from 'lucide-react';
import type { ChangeEntry } from '@/api/schemas.ts';
import { useShortcutLabel } from '@/commands/app.ts';
import { IconButton } from '@/components/IconButton.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { redoEdit, sessionStore, undoEdit, wallHistory } from '@/wall/session.ts';
import { describeOp } from './describeOp.ts';
import { horizontalWheelDelta } from './wheelScroll.ts';

const WINDOW = 60;

/** Bottom strip: the latest history entries (who changed what) with undo/redo; newest on the right. */
export function Timeline() {
  const { t } = useI18n();
  const session = useStore(sessionStore);
  const [entries, setEntries] = useState<readonly ChangeEntry[]>([]);
  const list = useRef<HTMLOListElement>(null);
  const wallId = session?.wallId;
  const undoKey = useShortcutLabel('edit.undo');
  const redoKey = useShortcutLabel('edit.redo');
  const rev = session?.confirmedRev ?? 0;

  useEffect(() => {
    if (!wallId) return;
    let cancelled = false;
    // Debounced: a burst of edits triggers one refresh once the revision settles.
    const timer = setTimeout(() => {
      wallHistory(wallId, Math.max(0, rev - WINDOW), WINDOW)
        .then((loaded) => {
          if (!cancelled) setEntries(loaded);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wallId, rev]);

  useEffect(() => {
    list.current?.scrollTo({ left: list.current.scrollWidth, behavior: 'smooth' });
  }, [entries]);

  // The strip scrolls horizontally, so a plain mouse wheel (vertical deltas) did nothing without Shift.
  // React's onWheel is passive and cannot cancel the page scroll; a native non-passive listener can.
  const hasEntries = entries.length > 0;
  useEffect(() => {
    const strip = list.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent): void => {
      const delta = horizontalWheelDelta(event, strip);
      if (delta === null) return;
      event.preventDefault();
      strip.scrollLeft += delta;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, [hasEntries]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton
          label={t('action.undo')}
          shortcut={undoKey}
          disabled={!session?.canUndo}
          onClick={undoEdit}
        >
          <Undo2 />
        </IconButton>
        <IconButton
          label={t('action.redo')}
          shortcut={redoKey}
          disabled={!session?.canRedo}
          onClick={redoEdit}
        >
          <Redo2 />
        </IconButton>
        <h2 className="ml-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t('panel.history')}
        </h2>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">rev {rev}</span>
      </div>
      {entries.length === 0 ? (
        <p className="p-3 text-xs text-muted-foreground">{t('history.empty')}</p>
      ) : (
        <ol ref={list} className="flex min-h-0 flex-1 items-stretch gap-2 overflow-x-auto p-2">
          {entries.map((entry) => (
            <HistoryChip key={entry.rev} entry={entry} current={entry.rev === rev} />
          ))}
        </ol>
      )}
    </div>
  );
}

function HistoryChip({
  entry,
  current,
}: {
  readonly entry: ChangeEntry;
  readonly current: boolean;
}) {
  const { t } = useI18n();
  const description = describeOp(entry.op);
  const Icon = entry.actor.kind === 'agent' ? Bot : entry.actor.kind === 'cli' ? Terminal : User;
  const verb =
    entry.kind === 'undo'
      ? t('history.undone')
      : entry.kind === 'redo'
        ? t('history.redone')
        : null;
  return (
    <li
      className={cn(
        'flex w-40 shrink-0 flex-col justify-between rounded-lg border px-2.5 py-1.5 text-xs',
        current ? 'border-primary bg-accent' : 'border-border bg-card',
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-primary" aria-hidden />
        <span className="truncate font-medium">
          {entry.actor.name ?? t(`actor.${entry.actor.kind}`)}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">#{entry.rev}</span>
      </div>
      <div className="truncate text-muted-foreground">
        {verb ? `${verb}: ` : ''}
        {entry.label ?? t(description.key)}
        {description.count && description.count > 1 ? ` ×${description.count}` : ''}
      </div>
    </li>
  );
}
