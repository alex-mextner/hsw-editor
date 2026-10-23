/**
 * Pure logic of the bank browser: filtering, category counts/tree, grid geometry and keyboard
 * navigation. Kept free of React so the rules can be tested without a DOM.
 */
import { isInCategory, type BankCategory } from '@hsw-editor/bank';

export const SIZE_BUCKETS = ['s1', 's2', 's3to4', 's5plus'] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number];

export const ORIGIN_FILTERS = ['all', 'generated', 'sources', 'mine'] as const;
export type OriginFilter = (typeof ORIGIN_FILTERS)[number];

export interface BankFilters {
  /** Category id; selecting a node includes its whole subtree. */
  readonly category: string | null;
  /** Elements must be about at least one of these tool classes; empty = any. Fed by the tool filter store. */
  readonly toolClasses: readonly string[];
  readonly size: SizeBucket | null;
  readonly redistributableOnly: boolean;
  readonly origin: OriginFilter;
}

export const NO_FILTERS: BankFilters = {
  category: null,
  toolClasses: [],
  size: null,
  redistributableOnly: false,
  origin: 'all',
};

/** The slice of a bank element the filters read; `BankElement` satisfies it structurally. */
export interface FilterTarget {
  readonly category: string;
  readonly toolClasses: readonly string[];
  readonly footprint: { readonly cells: readonly unknown[] };
  readonly generated: boolean;
  /** `user` on elements the user imported. */
  readonly source?: 'user' | undefined;
  readonly license: { readonly redistributable: boolean };
}

export function sizeBucket(cellCount: number): SizeBucket {
  if (cellCount <= 1) return 's1';
  if (cellCount === 2) return 's2';
  if (cellCount <= 4) return 's3to4';
  return 's5plus';
}

export function activeFilterCount(filters: BankFilters): number {
  return (
    Number(filters.category !== null) +
    Number(filters.toolClasses.length > 0) +
    Number(filters.size !== null) +
    Number(filters.redistributableOnly) +
    Number(filters.origin !== 'all')
  );
}

export interface FilterOptions {
  /** Skip the category test: used to count elements per category under all the other filters. */
  readonly ignoreCategory?: boolean;
}

export function matchesFilters(
  element: FilterTarget,
  filters: BankFilters,
  options: FilterOptions = {},
): boolean {
  if (
    !options.ignoreCategory &&
    filters.category !== null &&
    !isInCategory(element.category, filters.category)
  ) {
    return false;
  }
  if (
    filters.toolClasses.length > 0 &&
    !filters.toolClasses.some((id) => element.toolClasses.includes(id))
  ) {
    return false;
  }
  if (filters.size !== null && sizeBucket(element.footprint.cells.length) !== filters.size) {
    return false;
  }
  if (filters.redistributableOnly && !element.license.redistributable) return false;
  if (filters.origin === 'generated' && !element.generated) return false;
  // The user's own uploads are neither generated nor from the downloaded sources.
  if (filters.origin === 'sources' && (element.generated || element.source === 'user'))
    return false;
  if (filters.origin === 'mine' && element.source !== 'user') return false;
  return true;
}

export function applyFilters<E extends FilterTarget>(
  elements: readonly E[],
  filters: BankFilters,
  options: FilterOptions = {},
): E[] {
  return elements.filter((element) => matchesFilters(element, filters, options));
}

/**
 * Elements a search produced, in rank order. `rankedIds` is null for an empty query, which keeps the
 * index order; ids that no longer exist in the index are dropped.
 */
export function candidateElements<E extends { readonly id: string }>(
  elements: readonly E[],
  byId: ReadonlyMap<string, E>,
  rankedIds: readonly string[] | null,
): readonly E[] {
  if (rankedIds === null) return elements;
  const found: E[] = [];
  for (const id of rankedIds) {
    const element = byId.get(id);
    if (element) found.push(element);
  }
  return found;
}

/** Elements per category id; every element also counts for each ancestor of its category. */
export function countByCategory(
  elements: readonly { readonly category: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { category } of elements) {
    const parts = category.split('/');
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const id = parts.slice(0, depth).join('/');
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}

export function usedToolClasses(elements: readonly FilterTarget[]): Set<string> {
  const used = new Set<string>();
  for (const element of elements) for (const id of element.toolClasses) used.add(id);
  return used;
}

export interface CategoryNode {
  readonly category: BankCategory;
  readonly children: readonly CategoryNode[];
}

/** Two-level tree ordered by `order`; categories whose parent is unknown are shown at the top level. */
export function buildCategoryTree(categories: readonly BankCategory[]): CategoryNode[] {
  const ids = new Set(categories.map((category) => category.id));
  const sorted = [...categories].sort((a, b) => a.order - b.order);
  const childrenOf = (parent: string): CategoryNode[] =>
    sorted
      .filter((category) => category.parent === parent)
      .map((category) => ({ category, children: [] }));
  return sorted
    .filter((category) => category.parent === undefined || !ids.has(category.parent))
    .map((category) => ({ category, children: childrenOf(category.id) }));
}

/** Ancestor chain of a category id, root first: `a/b` -> [`a`, `a/b`]. */
export function categoryChain(id: string): string[] {
  const parts = id.split('/');
  return parts.map((_, depth) => parts.slice(0, depth + 1).join('/'));
}

// --- grid geometry -----------------------------------------------------------------------------

export const CARD_MIN_WIDTH = 120;
export const CARD_GAP = 8;
export const GRID_PADDING = 8;
/** Fixed height of the text block under the square thumbnail, so virtual rows need no measuring. */
export const CARD_INFO_HEIGHT = 84;

export function gridColumns(containerWidth: number): number {
  const usable = containerWidth - 2 * GRID_PADDING;
  return Math.max(1, Math.floor((usable + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
}

export function cardWidth(containerWidth: number, columns: number): number {
  const usable = containerWidth - 2 * GRID_PADDING;
  return Math.max(0, (usable - CARD_GAP * (columns - 1)) / columns);
}

export function cardHeight(width: number): number {
  return width + CARD_INFO_HEIGHT;
}

/** Distance between the tops of two consecutive rows. */
export function rowStride(width: number): number {
  return cardHeight(width) + CARD_GAP;
}

export type NavigationKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export function isNavigationKey(key: string): key is NavigationKey {
  return (
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'Home' ||
    key === 'End'
  );
}

/** Index the keyboard focus moves to inside a row-major grid; stays put at the edges. */
export function moveIndex(
  index: number,
  key: NavigationKey,
  columns: number,
  count: number,
): number {
  const last = count - 1;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, index - 1);
    case 'ArrowRight':
      return Math.min(last, index + 1);
    case 'ArrowUp':
      return index - columns >= 0 ? index - columns : index;
    case 'ArrowDown': {
      if (index + columns <= last) return index + columns;
      // A short last row: step to its final card instead of doing nothing.
      return Math.floor(index / columns) < Math.floor(last / columns) ? last : index;
    }
    case 'Home':
      return 0;
    case 'End':
      return Math.max(0, last);
  }
}
