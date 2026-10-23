import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SearchIcon, XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input.tsx';
import { useT } from '@/i18n/index.ts';

const DEBOUNCE_MS = 120;

interface ToolSearchBoxProps {
  /** Committed (debounced) query held in the panel state. */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
}

/** Search field of the tool library: debounced commit, Esc clears. */
export function ToolSearchBox({ query, onQueryChange }: ToolSearchBoxProps) {
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

  const clear = (): void => {
    committed.current = '';
    setDraft('');
    onQueryChange('');
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
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
        placeholder={t('toolLib.search.placeholder')}
        aria-label={t('toolLib.search.label')}
        autoComplete="off"
        spellCheck={false}
        className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
      />
      {draft === '' ? null : (
        <button
          type="button"
          onClick={() => {
            clear();
            inputRef.current?.focus();
          }}
          aria-label={t('toolLib.search.clear')}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}
