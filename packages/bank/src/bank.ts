import type MiniSearch from 'minisearch';
import { categoryVocabulary, isInCategory } from './categories.ts';
import type {
  BankCategory,
  BankElement,
  BankIndex,
  FitsTool,
  MOUNTING_KINDS,
  Vec3,
} from './schema.ts';
import { buildSearchIndex, loadSearchIndex, runSearch, type SearchHit } from './search.ts';
import { toolClassVocabulary } from './toolClasses.ts';

export type MountingKind = (typeof MOUNTING_KINDS)[number];

export interface ElementFilter {
  /** Category id; includes everything below it ("holders" matches "holders/pliers"). */
  category?: string;
  toolClass?: string;
  family?: string;
  mounting?: MountingKind;
  /** Upper bound of the element's bbox in mm, per axis (x right, y up, z out). */
  maxDimsMm?: Partial<Vec3>;
  minDimsMm?: Partial<Vec3>;
  /** Upper bound on the number of honeycomb cells the element covers. */
  maxCells?: number;
  generated?: boolean;
  redistributable?: boolean;
  /**
   * Compatibility with a measured object: elements that list `toolClass` in `fitsTool` and whose dim
   * ranges contain every given value (keys the element does not constrain are ignored).
   */
  fits?: { toolClass: string; dims?: Record<string, number> };
}

export type ElementSort = 'name-ru' | 'name-en' | 'size' | 'category';

export interface ListOptions extends ElementFilter {
  sort?: ElementSort;
  offset?: number;
  limit?: number;
}

export interface ListResult {
  total: number;
  items: BankElement[];
}

export interface SearchResult extends SearchHit {
  element: BankElement;
}

export interface Bank {
  readonly index: BankIndex;
  getElement(id: string): BankElement | undefined;
  listElements(options?: ListOptions): ListResult;
  /** Ranked full-text search over ru/en names, tags, tool synonyms and category names. */
  search(query: string, filter?: ElementFilter, limit?: number): SearchResult[];
  /** All elements of a family (size ladder), in index order. */
  familyOf(element: BankElement): BankElement[];
  categories(): readonly BankCategory[];
}

function fitsMatches(fits: FitsTool, wanted: NonNullable<ElementFilter['fits']>): boolean {
  if (fits.toolClass !== wanted.toolClass) return false;
  if (!wanted.dims || !fits.dims) return true;
  for (const [key, value] of Object.entries(wanted.dims)) {
    const range = fits.dims[key];
    if (range && (value < range.min || value > range.max)) return false;
  }
  return true;
}

function matches(e: BankElement, f: ElementFilter): boolean {
  if (f.category !== undefined && !isInCategory(e.category, f.category)) return false;
  if (f.toolClass !== undefined && !e.toolClasses.includes(f.toolClass)) return false;
  if (f.family !== undefined && e.family !== f.family) return false;
  if (f.mounting !== undefined && e.mounting.kind !== f.mounting) return false;
  if (f.generated !== undefined && e.generated !== f.generated) return false;
  if (f.redistributable !== undefined && e.license.redistributable !== f.redistributable)
    return false;
  if (f.maxCells !== undefined && e.footprint.cells.length > f.maxCells) return false;
  for (const axis of ['x', 'y', 'z'] as const) {
    const max = f.maxDimsMm?.[axis];
    const min = f.minDimsMm?.[axis];
    if (max !== undefined && e.dimsMm[axis] > max) return false;
    if (min !== undefined && e.dimsMm[axis] < min) return false;
  }
  if (f.fits !== undefined) {
    const wanted = f.fits;
    if (!e.fitsTool.some((t) => fitsMatches(t, wanted))) return false;
  }
  return true;
}

const SORTERS: Record<ElementSort, (a: BankElement, b: BankElement) => number> = {
  'name-ru': (a, b) => a.name.ru.localeCompare(b.name.ru, 'ru'),
  'name-en': (a, b) => a.name.en.localeCompare(b.name.en, 'en'),
  size: (a, b) => a.dimsMm.x * a.dimsMm.y * a.dimsMm.z - b.dimsMm.x * b.dimsMm.y * b.dimsMm.z,
  category: (a, b) =>
    a.category.localeCompare(b.category) || a.name.en.localeCompare(b.name.en, 'en'),
};

/** `serializedSearch` is the prebuilt search index; it is rebuilt from the elements if unusable. */
export function createBank(index: BankIndex, serializedSearch?: string): Bank {
  const byId = new Map(index.elements.map((e) => [e.id, e]));
  const loaded: MiniSearch | null = serializedSearch
    ? loadSearchIndex(serializedSearch, index.contentHash)
    : null;
  const search =
    loaded ??
    buildSearchIndex(index.elements, {
      categories: categoryVocabulary(index.categories),
      toolClasses: toolClassVocabulary(index.toolClasses),
    });
  const families = new Map<string, BankElement[]>();
  for (const e of index.elements) {
    if (e.family === undefined) continue;
    const list = families.get(e.family) ?? [];
    list.push(e);
    families.set(e.family, list);
  }

  return {
    index,
    getElement: (id) => byId.get(id),
    listElements(options = {}) {
      const { sort, offset: requestedOffset = 0, limit, ...filter } = options;
      const offset = Math.max(0, requestedOffset);
      const all = index.elements.filter((e) => matches(e, filter));
      if (sort) all.sort(SORTERS[sort]);
      return {
        total: all.length,
        items: all.slice(offset, limit === undefined ? undefined : offset + limit),
      };
    },
    search(query, filter = {}, limit = 50) {
      const hasFilter = Object.keys(filter).length > 0;
      const allowed = hasFilter
        ? new Set(index.elements.filter((e) => matches(e, filter)).map((e) => e.id))
        : null;
      const hits = runSearch(search, query, allowed);
      const results: SearchResult[] = [];
      for (const hit of hits) {
        if (results.length >= limit) break;
        const element = byId.get(hit.id);
        if (element) results.push({ ...hit, element });
      }
      return results;
    },
    familyOf: (element) =>
      element.family === undefined ? [element] : (families.get(element.family) ?? [element]),
    categories: () => categoryVocabulary(index.categories),
  };
}
