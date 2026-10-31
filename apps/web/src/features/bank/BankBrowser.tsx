import { useMemo } from 'react';
import { effectiveToolFilter, rankHoldersForTools } from '@hsw-editor/compat';
import { PlusIcon, SlidersHorizontalIcon } from 'lucide-react';
import {
  expandToolClasses,
  finerToolClasses,
  type BankElement,
  type BankIndex,
} from '@hsw-editor/bank';
import { createBankSearch, type BankSearch } from '@/bank/search.ts';
import { IconButton } from '@/components/IconButton.tsx';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { toolInterfaceOf } from '@/wall/toolInterface.ts';
import { useI18n } from '@/i18n/index.ts';
import { BankGrid } from './BankGrid.tsx';
import { BankSearchBox } from './BankSearchBox.tsx';
import { BankNoResults } from './BankStates.tsx';
import { FilterChips } from './FilterChips.tsx';
import { FilterPanel } from './FilterPanel.tsx';
import { SelectionFilterChip } from './SelectionFilterChip.tsx';
import { dispatchToolFilter, toolFilterStore } from './toolFilterStore.ts';
import {
  activeFilterCount,
  applyFilters,
  candidateElements,
  countByCategory,
  NO_FILTERS,
  selectableToolClasses,
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
  /** Opens the "Add element" dialog. */
  readonly onAddElement: () => void;
}

/** Search + filters + virtual card grid of the loaded bank. */
export function BankBrowser({ index, byId, panel, onOpen, onAdd, onAddElement }: BankBrowserProps) {
  const { t, tn, locale } = useI18n();
  const { query } = panel;
  const toolFilter = useStore(toolFilterStore);
  const wall = useStore(sessionStore)?.wall ?? null;
  const effective = effectiveToolFilter(toolFilter);
  const filters = useMemo(
    () => ({ ...panel.filters, toolClasses: effective.classes }),
    [panel.filters, effective.classes],
  );

  const toolClassScope = useMemo(
    () => expandToolClasses(effective.classes, index.toolClasses),
    [effective.classes, index.toolClasses],
  );

  const candidates = useMemo(() => {
    const ranked = query.trim() === '' ? null : searchFor(index).search(query);
    return candidateElements(index.elements, byId, ranked);
  }, [index, byId, query]);
  // Everything except the category: the tree shows what each category would yield from here.
  const scoped = useMemo(
    () => applyFilters(candidates, filters, { ignoreCategory: true, toolClassScope }),
    [candidates, filters, toolClassScope],
  );
  const categoryCounts = useMemo(() => countByCategory(scoped), [scoped]);
  const filtered = useMemo(
    () => applyFilters(scoped, filters, { toolClassScope }),
    [scoped, filters, toolClassScope],
  );
  // Selected tools: best fit first (an empty query keeps the index order otherwise).
  const results = useMemo(() => {
    if (!effective.resettable || query.trim() !== '' || wall === null) return filtered;
    const tools = toolFilter.selection.itemIds.flatMap((id) => {
      const item = wall.items.find((candidate) => candidate.id === id);
      const tool = item === undefined ? undefined : toolInterfaceOf(item, wall, index.toolClasses);
      return tool === undefined ? [] : [tool];
    });
    const rank = new Map(
      rankHoldersForTools(filtered, tools).map((entry, position) => [entry.holder.id, position]),
    );
    return [...filtered].sort(
      (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
    );
  }, [
    filtered,
    effective.resettable,
    query,
    wall,
    toolFilter.selection.itemIds,
    index.toolClasses,
  ]);
  const toolClassIds = useMemo(
    () => selectableToolClasses(index.elements, finerToolClasses(index.toolClasses)),
    [index.elements, index.toolClasses],
  );

  const activeFilters = activeFilterCount(filters);
  const reset = (): void => {
    patchBankPanel({ query: '', filters: NO_FILTERS });
    dispatchToolFilter({ type: 'setExplicit', classes: [] });
    dispatchToolFilter({ type: 'dismissOverride' });
  };

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
        <IconButton
          label={t('bank.add')}
          description={t('bank.addTitle')}
          variant="outline"
          size="icon"
          testId="bank-add-element"
          className="shrink-0"
          onClick={onAddElement}
        >
          <PlusIcon aria-hidden />
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
      {effective.resettable ? (
        <div className="px-2 pb-1.5">
          <SelectionFilterChip index={index} classes={effective.classes} />
        </div>
      ) : null}
      {activeFilterCount(panel.filters) + toolFilter.explicit.length > 0 ? (
        <div className="px-2 pb-1.5">
          <FilterChips
            index={index}
            filters={panel.filters}
            explicit={toolFilter.explicit}
            onReset={reset}
          />
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
          resetKey={`${query}|${JSON.stringify(filters)}|${effective.resettable ? toolFilter.selection.itemIds.join(',') : ''}`}
          onOpen={onOpen}
          onAdd={onAdd}
        />
      )}
    </>
  );
}
