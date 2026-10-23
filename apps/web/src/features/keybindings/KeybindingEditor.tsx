import { useCallback, useMemo, useRef, useState } from 'react';
import { COMMAND_GROUPS, EMPTY_USER_KEYMAP, resetCommandBindings } from '@hsw-editor/commands';
import { TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { keybindingEditorStore, setUserKeymap, useKeymapState } from '@/commands/app.ts';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import {
  addBinding,
  buildRows,
  groupRows,
  problemList,
  removeBinding,
  searchRows,
  summariseConflicts,
} from './editorModel.ts';
import { KeymapTransfer } from './KeymapTransfer.tsx';
import { KeyRow } from './KeyRow.tsx';

/** Dialog bound to `keybindingEditorStore`; full-screen on a phone. */
export function KeybindingEditor() {
  const open = useStore(keybindingEditorStore);
  const guard = useRef(false);

  // A key the recorder swallowed (Escape) must not also close the dialog: the dialog's own
  // dismissal runs later in the same event dispatch, so a flag cleared on the next task covers it.
  const markKeyHandled = useCallback(() => {
    guard.current = true;
    setTimeout(() => {
      guard.current = false;
    }, 0);
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && guard.current) return;
        keybindingEditorStore.set(next);
      }}
    >
      <DialogContent className="top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-[min(46rem,90dvh)] sm:w-full sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl">
        {open ? <EditorBody onKeyHandled={markKeyHandled} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EditorBody({ onKeyHandled }: { readonly onKeyHandled: () => void }) {
  const { t, tn, locale } = useI18n();
  const state = useKeymapState();
  const phone = useMediaQuery('(max-width: 639px)');
  const [query, setQuery] = useState('');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const { user, keymap, commands, platform } = state;

  const rows = useMemo(
    () => buildRows(commands, keymap, user, locale),
    [commands, keymap, user, locale],
  );
  const groups = useMemo(() => {
    const found = searchRows(rows, commands, query);
    // Search order is by relevance, so groups only apply to the unfiltered list.
    return query.trim() === '' ? groupRows(found) : [{ group: null, rows: found }];
  }, [rows, commands, query]);
  const conflicts = useMemo(() => summariseConflicts(keymap), [keymap]);
  const cancel = useCallback(() => setRecordingId(null), []);
  const hasOverrides = Object.keys(user.overrides).length > 0;

  const commandOf = (id: string) => commands.find((command) => command.id === id);

  return (
    <>
      <DialogHeader className="gap-3 border-b border-border p-4 pr-12">
        <DialogTitle>{t('keys.title')}</DialogTitle>
        <DialogDescription>{t('keys.description')}</DialogDescription>
        <Input
          value={query}
          placeholder={t('keys.search')}
          aria-label={t('keys.search')}
          type="search"
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
        {conflicts.count > 0 ? (
          <output className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            {tn('keys.conflictsBanner', conflicts.count)}
          </output>
        ) : null}
        {keymap.problems.length > 0 ? (
          <p role="alert" className="text-xs text-destructive">
            {t('keys.problems', { list: problemList(keymap.problems) })}
          </p>
        ) : null}
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.every((entry) => entry.rows.length === 0) ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t('keys.noMatches')}
          </p>
        ) : (
          groups.map((entry) => (
            <section key={entry.group ?? 'results'} className="mb-2">
              {entry.group === null ? null : (
                <h3 className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  {COMMAND_GROUPS[entry.group][locale]}
                </h3>
              )}
              <ul aria-label={t('keys.commandList')}>
                {entry.rows.map((row) => (
                  <KeyRow
                    key={row.id}
                    row={row}
                    commands={commands}
                    keymap={keymap}
                    locale={locale}
                    recording={recordingId === row.id}
                    phone={phone}
                    onRecord={setRecordingId}
                    onSave={(id, text) => {
                      const command = commandOf(id);
                      if (command !== undefined) {
                        setUserKeymap(addBinding(user, command, platform, text));
                      }
                      setRecordingId(null);
                    }}
                    onCancel={cancel}
                    onRemove={(id, text) => {
                      const command = commandOf(id);
                      if (command !== undefined) {
                        setUserKeymap(removeBinding(user, command, platform, text));
                      }
                    }}
                    onReset={(id) => setUserKeymap(resetCommandBindings(user, id))}
                    onKeyHandled={onKeyHandled}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <div className="flex flex-col gap-3 border-t border-border bg-muted/50 p-3">
        <KeymapTransfer user={user} commands={commands} onImport={setUserKeymap} />
        {confirmReset ? (
          <div
            role="alertdialog"
            aria-label={t('keys.resetAll')}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span className="flex-1">{t('keys.resetAllConfirm')}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
              {t('keys.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setUserKeymap(EMPTY_USER_KEYMAP);
                setRecordingId(null);
                setConfirmReset(false);
              }}
            >
              {t('keys.resetAll')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={!hasOverrides}
            onClick={() => setConfirmReset(true)}
          >
            {t('keys.resetAll')}
          </Button>
        )}
      </div>
    </>
  );
}
