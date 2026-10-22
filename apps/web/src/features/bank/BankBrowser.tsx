import { useMemo } from 'react';
import { SlidersHorizontalIcon } from 'lucide-react';
import type { BankElement, BankIndex } from '@hsw-editor/bank';
import { createBankSearch, type BankSearch } from '@/bank/search.ts';
import { IconButton } from '@/components/IconButton.tsx';
import { useI18n } from '@/i18n/index.ts';
import { BankGrid } from './BankGrid.tsx';
import { BankSearchBox } from './BankSearchBox.tsx';
import { BankNoResults } from './BankStates.tsx';
import { FilterChips } from './FilterChips.tsx';
import { FilterPanel } from './FilterPanel.tsx';
import {
  activeFilterCount,
  applyFilters,
  candidateElements,
  countByCategory,
  NO_FILTERS,
  usedToolClasses,
} from './filters.ts';
import { patchBankPanel, type BankPanelState } from './panelState.ts';

/** Building the index costs a few ms per hundred elements; the panel remounts on every tab switch. */
const searchCache = new WeakMap<BankIndex, BankSearch>();

function searchFor(index: BankIndex): BankSearch {
  let search = searchCache.get(index);
  if (!search) {
    search = createBankSearch(index);
    searchCache.set(index, search);
  }
  return search;
}

function setQuery(query: string): void {
  patchBankPanel({ query });
}

interface BankBrowserProps {
  readonly index: BankIndex;
  readonly byId: ReadonlyMap<string, BankElement>;
  readonly panel: BankPanelState;
  readonly onOpen: (element: BankElement) => void;
  readonly onAdd: (element: BankElement) => void;
}

/** Search + filters + virtual card grid of the loaded bank. */
export function BankBrowser({ index, byId, panel, onOpen, onAdd }: BankBrowserProps) {
  const { t, tn, locale } = useI18n();
  const { query, filters } = panel;

  const candidates = useMemo(() => {
    const ranked = query.trim() === '' ? null : searchFor(index).search(query);
    return candidateElements(index.elements, byId, ranked);
  }, [index, byId, query]);
  // Everything except the category: the tree shows what each category would yield from here.
  const scoped = useMemo(
    () => applyFilters(candidates, filters, { ignoreCategory: true }),
    [candidates, filters],
  );
  const categoryCounts = useMemo(() => countByCategory(scoped), [scoped]);
  const results = useMemo(() => applyFilters(scoped, filters), [scoped, filters]);
  const toolClassIds = useMemo(() => usedToolClasses(index.elements), [index.elements]);

  const activeFilters = activeFilterCount(filters);
  const reset = (): void => patchBankPanel({ query: '', filters: NO_FILTERS });

  return (
    <>
      <div className="flex items-center gap-1.5 p-2">
        <BankSearchBox query={query} onQueryChange={setQuery} />
        <IconButton
          label={t('bank.filters.toggle')}
          pressed={panel.filtersOpen}
          size="icon"
          className="relative shrink-0"
          onClick={() => patchBankPanel({ filtersOpen: !panel.filtersOpen })}
        >
          <SlidersHorizontalIcon aria-hidden />
          {activeFilters > 0 ? (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
              {activeFilters}
            </span>
          ) : null}
        </IconButton>
      </div>
      {panel.filtersOpen ? (
        <div className="max-h-[50vh] shrink-0 overflow-y-auto border-t border-border">
          <FilterPanel
            index={index}
            filters={filters}
            categoryCounts={categoryCounts}
            total={scoped.length}
            toolClassIds={toolClassIds}
            expanded={panel.expanded}
          />
        </div>
      ) : null}
      {activeFilters > 0 ? (
        <div className="px-2 pb-1.5">
          <FilterChips index={index} filters={filters} onReset={reset} />
        </div>
      ) : null}
      <p className="px-3 pb-1 text-[11px] text-muted-foreground" aria-live="polite">
        {tn('bank.results', results.length)}
      </p>
      {results.length === 0 ? (
        <BankNoResults onReset={reset} />
      ) : (
        <BankGrid
          elements={results}
          locale={locale}
          query={query}
          resetKey={`${query}|${JSON.stringify(filters)}`}
          onOpen={onOpen}
          onAdd={onAdd}
        />
      )}
    </>
  );
}
