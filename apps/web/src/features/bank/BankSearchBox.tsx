import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { SearchIcon, XIcon } from 'lucide-react';
import { isTypingTarget } from '@/commands/registry.ts';
import { Input } from '@/components/ui/input.tsx';
import { Kbd } from '@/components/Kbd.tsx';
import { useT } from '@/i18n/index.ts';

const DEBOUNCE_MS = 120;

interface BankSearchBoxProps {
  /** Committed (debounced) query held in the panel state. */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}

/**
 * Search field with a debounced commit, `/` to focus from anywhere in the app and Esc to clear.
 * Typing stays instant because only the committed value drives the (comparatively heavy) search.
 */
export function BankSearchBox({ query, onQueryChange }: BankSearchBoxProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(query);
  // What this component last reported upward: a different `query` prop means an external reset.
  const committed = useRef(query);

  useEffect(() => {
    if (query !== committed.current) {
      committed.current = query;
      setDraft(query);
    }
  }, [query]);

  useEffect(() => {
    if (draft === committed.current) return;
    const timer = window.setTimeout(() => {
      committed.current = draft;
      onQueryChange(draft);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, onQueryChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const clear = (): void => {
    committed.current = '';
    setDraft('');
    onQueryChange('');
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (draft === '') inputRef.current?.blur();
    else clear();
  };

  return (
    <div className="relative min-w-0 flex-1">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        ref={inputRef}
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('bank.search.placeholder')}
        aria-label={t('bank.search.label')}
        autoComplete="off"
        spellCheck={false}
        className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {draft === '' ? (
        <Kbd className="pointer-events-none absolute top-1/2 right-2 ml-0 -translate-y-1/2">/</Kbd>
      ) : (
        <button
          type="button"
          onClick={() => {
            clear();
            inputRef.current?.focus();
          }}
          aria-label={t('bank.search.clear')}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
