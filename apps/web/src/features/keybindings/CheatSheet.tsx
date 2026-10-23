import { useMemo, useState } from 'react';
import { COMMAND_GROUPS } from '@hsw-editor/commands';
import { KeyboardIcon } from 'lucide-react';
import {
  cheatSheetStore,
  commandRegistry,
  keybindingEditorStore,
  useCommandContext,
  useKeymapState,
} from '@/commands/app.ts';
import { Kbd } from '@/components/Kbd.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { buildCheatSheet } from './cheatSheetModel.ts';

/** Dialog bound to `cheatSheetStore`: every shortcut that works in the context it was opened from. */
export function CheatSheet() {
  const open = useStore(cheatSheetStore);
  return (
    <Dialog open={open} onOpenChange={(next) => cheatSheetStore.set(next)}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-2xl">
        {open ? <SheetBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SheetBody() {
  // The command context already ignores the overlays themselves, so `!dialog` commands are listed.
  const context = useCommandContext();
  const { t, locale } = useI18n();
  const { keymap } = useKeymapState();
  const [filter, setFilter] = useState('');
  const groups = useMemo(
    () => buildCheatSheet(commandRegistry.available(context), keymap, locale, filter),
    [context, keymap, locale, filter],
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('cheat.title')}</DialogTitle>
        <DialogDescription>{t('cheat.description')}</DialogDescription>
      </DialogHeader>
      <Input
        value={filter}
        placeholder={t('cheat.filter')}
        aria-label={t('cheat.filter')}
        type="search"
        autoComplete="off"
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          // The filter has focus on open, so the key that opened the sheet would otherwise be typed into it.
          if (event.key === '?' && filter === '') {
            event.preventDefault();
            cheatSheetStore.set(false);
          }
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('cheat.empty')}</p>
        ) : (
          groups.map((group) => (
            <section key={group.group} className="mb-3">
              <h3 className="pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {COMMAND_GROUPS[group.group][locale]}
              </h3>
              <ul className="grid gap-x-6 sm:grid-cols-2">
                {group.entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between gap-3 border-b border-border/50 py-1.5 text-sm"
                  >
                    <span className="min-w-0 truncate">{entry.title}</span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1">
                      {entry.labels.map((label) => (
                        <Kbd key={label} className="ml-0 h-5 px-1.5 text-xs">
                          {label}
                        </Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-muted-foreground">{t('cheat.footer')}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            cheatSheetStore.set(false);
            keybindingEditorStore.set(true);
          }}
        >
          <KeyboardIcon data-icon="inline-start" />
          {t('cheat.customise')}
        </Button>
      </div>
    </>
  );
}
