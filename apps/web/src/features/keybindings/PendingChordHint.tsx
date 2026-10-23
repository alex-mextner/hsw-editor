import { useMemo } from 'react';
import { pendingChordStore, useKeymapState } from '@/commands/app.ts';
import { Kbd } from '@/components/Kbd.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { pendingChordView } from './cheatSheetModel.ts';

const MAX_OPTIONS = 6;

/** Floating hint while a multi-stroke chord waits for its next key (e.g. after Ctrl+K). */
export function PendingChordHint() {
  const pending = useStore(pendingChordStore);
  const { commands, platform } = useKeymapState();
  const { t, locale } = useI18n();
  const view = useMemo(
    () => (pending === null ? null : pendingChordView(pending, commands, platform, locale)),
    [pending, commands, platform, locale],
  );
  if (view === null) return null;

  return (
    <output className="pointer-events-none fixed bottom-16 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-1.5 rounded-xl bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10">
      <span>{t('keys.pendingChord', { keys: view.typed })}</span>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
        {view.options.slice(0, MAX_OPTIONS).map((option) => (
          <li key={`${option.next}:${option.title}`} className="flex items-center gap-2">
            <Kbd className="ml-0">{option.next}</Kbd>
            <span className="truncate">{option.title}</span>
          </li>
        ))}
        {view.options.length > MAX_OPTIONS ? <li aria-hidden>…</li> : null}
      </ul>
    </output>
  );
}
