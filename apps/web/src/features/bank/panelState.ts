import { createValueStore } from '#state-backend';
import { NO_FILTERS, type BankFilters } from './filters.ts';

/**
 * Search/filter/navigation state of the bank panel. Lives at module level so it survives the panel
 * being unmounted when the user switches left-panel tabs; deliberately not persisted to storage.
 */
export interface BankPanelState {
  readonly query: string;
  readonly filters: BankFilters;
  readonly filtersOpen: boolean;
  /** Category ids whose children are shown in the tree. */
  readonly expanded: readonly string[];
  /** Element shown in the detail view, or null for the grid. */
  readonly detailId: string | null;
}

export const bankPanelStore = createValueStore<BankPanelState>({
  query: '',
  filters: NO_FILTERS,
  filtersOpen: false,
  expanded: [],
  detailId: null,
});

export function patchBankPanel(patch: Partial<BankPanelState>): void {
  // A different result list starts at the top; remounting the grid must not restore the old offset.
  if (patch.query !== undefined || patch.filters !== undefined) gridScrollMemory.top = 0;
  bankPanelStore.set({ ...bankPanelStore.get(), ...patch });
}

export function patchBankFilters(patch: Partial<BankFilters>): void {
  patchBankPanel({ filters: { ...bankPanelStore.get().filters, ...patch } });
}

/** Scroll offset of the grid; read once on mount, so it needs no subscribers. */
export const gridScrollMemory = { top: 0 };
