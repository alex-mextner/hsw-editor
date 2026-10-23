import { type PaletteMode, parsePaletteInput } from '@hsw-editor/commands';
import { Search } from 'lucide-react';
import type { KeyboardEvent, RefObject } from 'react';
import { useI18n } from '@/i18n/index.ts';
import { MODE_LABEL_KEYS, PLACEHOLDER_KEYS } from './paletteNav.ts';

interface PaletteInputProps {
  readonly input: string;
  readonly mode: PaletteMode;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly listId: string;
  readonly activeDomId: string | undefined;
  readonly expanded: boolean;
  readonly onInput: (next: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * The search field. A mode prefix (`>`, `@`, `#`, `:`, `?`) is shown as a chip and kept out of the
 * text box; Backspace on an empty box drops the chip.
 */
export function PaletteInput({
  input,
  mode,
  inputRef,
  listId,
  activeDomId,
  expanded,
  onInput,
  onKeyDown,
}: PaletteInputProps) {
  const { t } = useI18n();
  const { prefix } = parsePaletteInput(input);
  const text = input.slice(prefix.length);
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {prefix === '' ? null : (
        <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-xs text-primary">
          {prefix} {t(MODE_LABEL_KEYS[mode])}
        </span>
      )}
      <input
        ref={inputRef}
        // The palette is a modal whose whole purpose is this field.
        // oxlint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={activeDomId}
        aria-autocomplete="list"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={text}
        placeholder={t(PLACEHOLDER_KEYS[mode])}
        aria-label={t(PLACEHOLDER_KEYS[mode])}
        className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        onChange={(event) => onInput(`${prefix}${event.target.value}`)}
        onKeyDown={(event) => {
          if (event.key === 'Backspace' && text === '' && prefix !== '') {
            event.preventDefault();
            onInput('');
            return;
          }
          onKeyDown(event);
        }}
      />
    </div>
  );
}
