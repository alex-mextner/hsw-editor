import { parsePaletteInput, type RankedItem } from '@hsw-editor/commands';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { aiSession, useAiStatus } from '@/commands/aiSession.ts';
import { closePalette, paletteStore, recordPaletteUse, settingsStore } from '@/commands/app.ts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx';
import { notify } from '@/features/notices/notices.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { AiAnswerPane } from './AiAnswerPane.tsx';
import { ENTER_HINT_KEYS, cycleMode, isNavKey, moveActive } from './paletteNav.ts';
import { PaletteInput } from './PaletteInput.tsx';
import { LIST_ID, PaletteList, rowDomId } from './PaletteList.tsx';
import { PalettePreview } from './PalettePreview.tsx';
import { usePaletteSearch } from './usePaletteSearch.ts';

/** Provider ids as the user knows the source, for the "unavailable offline" notice. */
const SOURCE_KEYS = {
  walls: 'palette.section.wall',
  items: 'palette.section.item',
  bank: 'palette.section.bank',
  history: 'palette.section.history',
  'history-goto': 'palette.section.history',
} as const;

function isSourceId(id: string): id is keyof typeof SOURCE_KEYS {
  return id in SOURCE_KEYS;
}

// Full-width sheet from the top on a phone, a centred dialog from `sm` up.
const SHEET_CLASS =
  'top-0 left-0 w-full max-w-full translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none p-0 sm:top-[12%] sm:left-1/2 sm:max-w-3xl sm:-translate-x-1/2 sm:rounded-xl';

export function CommandPalette() {
  const { t } = useI18n();
  const { open } = useStore(paletteStore);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closePalette();
      }}
    >
      <DialogContent showCloseButton={false} className={SHEET_CLASS}>
        <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('palette.hint')}</DialogDescription>
        {open ? <PaletteBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody() {
  const { t } = useI18n();
  const { input } = useStore(paletteStore);
  const aiStatus = useAiStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  /** The question whose answer is on screen; null while the result list is. */
  const [asked, setAsked] = useState<string | null>(null);
  const parsed = parsePaletteInput(input);
  const results = usePaletteSearch(input);
  const rows = results?.rows ?? [];
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  const activeRow = rows[activeIndex];

  // Closing the palette abandons the conversation: the stopped run refuses pending approvals.
  useEffect(() => () => aiSession.reset(), []);
  useEffect(() => {
    globalThis.document
      ?.getElementById(rowDomId(activeIndex))
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, results]);

  const setInput = (next: string): void => {
    if (asked !== null) {
      aiSession.cancel();
      setAsked(null);
    }
    setActive(0);
    paletteStore.set({ open: true, input: next });
  };

  const run = (row: RankedItem): void => {
    const { item } = row;
    if (item.kind === 'ai') {
      void item.run?.();
      setAsked(parsed.text);
      return;
    }
    if (item.run === undefined) {
      // A number setting has no Enter action: Enter moves into its field.
      globalThis.document
        ?.getElementById(rowDomId(rows.indexOf(row)))
        ?.querySelector<HTMLElement>('input, select, button')
        ?.focus();
      return;
    }
    recordPaletteUse(item.id);
    // A setting changes in place so several can be adjusted in a row; everything else leaves.
    if (item.kind !== 'setting') closePalette();
    Promise.resolve(item.run()).catch((error: unknown) =>
      notify('error', error instanceof Error ? error.message : String(error)),
    );
  };

  const showAnswer = asked !== null || (parsed.mode === 'ai' && aiStatus === 'unavailable');

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Composition keys belong to the input method; Enter there confirms a candidate.
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    // The answer pane has its own controls (Tab reaches them); the list keys have no target there.
    if (showAnswer) return;
    if (isNavKey(event.key)) {
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (!plain) return;
      event.preventDefault();
      setActive(moveActive(activeIndex, rows.length, event.key));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeRow !== undefined) run(activeRow);
    } else if (event.key === 'Tab' && activeRow?.item.control === undefined) {
      event.preventDefault();
      setInput(cycleMode(input, event.shiftKey));
    }
  };
  const failed = (results?.failedProviders ?? []).filter(isSourceId);
  return (
    <div className="flex min-h-0 flex-col">
      <PaletteInput
        input={input}
        mode={parsed.mode}
        inputRef={inputRef}
        listId={LIST_ID}
        activeDomId={showAnswer || rows.length === 0 ? undefined : rowDomId(activeIndex)}
        expanded={!showAnswer && rows.length > 0}
        onInput={setInput}
        onKeyDown={onKeyDown}
      />
      <div className="flex min-h-0">
        <div className="min-w-0 flex-1">
          {showAnswer ? (
            <AiAnswerPane
              question={asked ?? parsed.text}
              onNewQuestion={() => {
                aiSession.reset();
                setAsked(null);
                setInput('?');
                inputRef.current?.focus();
              }}
            />
          ) : results === null ? null : results.rows.length === 0 ? (
            parsed.text === '' ? null : (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {t('palette.noResults', { query: parsed.text })}
              </p>
            )
          ) : (
            <PaletteList
              results={results}
              active={activeIndex}
              onHover={setActive}
              onRun={run}
              onSetting={(settingId, value) => void settingsStore.set(settingId, value)}
            />
          )}
        </div>
        {showAnswer ? null : (
          <aside
            aria-label={t('palette.preview.empty')}
            className="hidden w-64 shrink-0 border-l border-border bg-muted/20 sm:block"
          >
            <PalettePreview row={activeRow} />
          </aside>
        )}
      </div>
      {failed.length === 0 ? null : (
        <output className="block border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          {t('palette.providerFailed', {
            sources: [...new Set(failed.map((id) => t(SOURCE_KEYS[id])))].join(', '),
          })}
        </output>
      )}
      <footer className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="truncate">{t('palette.modeHint')}</span>
        <span className="shrink-0 max-sm:hidden">
          {activeRow === undefined
            ? t('palette.keysHint')
            : t(ENTER_HINT_KEYS[activeRow.item.kind])}
        </span>
      </footer>
    </div>
  );
}
