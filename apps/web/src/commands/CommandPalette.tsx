import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx';
import { Kbd } from '@/components/Kbd.tsx';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { commandsStore, paletteOpenStore, type Command } from './registry.ts';

export function CommandPalette() {
  const t = useT();
  const open = useStore(paletteOpenStore);
  const commands = useStore(commandsStore);
  return (
    <Dialog open={open} onOpenChange={(next) => paletteOpenStore.set(next)}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('palette.hint')}</DialogDescription>
        {open ? <PaletteBody commands={commands} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({ commands }: { readonly commands: readonly Command[] }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return commands
      .filter((command) => !command.enabled || command.enabled())
      .map((command) => ({ command, label: t(command.label) }))
      .filter(({ label }) => needle === '' || label.toLowerCase().includes(needle));
  }, [commands, query, t]);

  const run = (command: Command): void => {
    paletteOpenStore.set(false);
    command.run();
  };

  return (
    <div>
      <input
        value={query}
        placeholder={t('palette.placeholder')}
        aria-label={t('palette.placeholder')}
        className="h-12 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, visible.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            const entry = visible[active];
            if (entry) run(entry.command);
          }
        }}
      />
      <ul className="max-h-72 overflow-y-auto p-1">
        {visible.length === 0 ? (
          <li className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t('palette.empty')}
          </li>
        ) : (
          visible.map(({ command, label }, index) => (
            <li key={command.id}>
              <button
                type="button"
                aria-current={index === active}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm',
                  index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
                onMouseMove={() => setActive(index)}
                onClick={() => run(command)}
              >
                <span>{label}</span>
                {command.shortcut ? <Kbd>{command.shortcut}</Kbd> : null}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
