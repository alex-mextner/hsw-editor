import MiniSearch from 'minisearch';
import { BANK_CATEGORIES } from './categories.ts';
import { getToolClass } from './toolClasses.ts';
import type { BankElement } from './schema.ts';
import { stemTerm, tokenize } from './text.ts';

/** Bumped whenever the document shape or tokenisation changes; stored in the serialised index. */
export const SEARCH_INDEX_VERSION = 2;

interface SearchDoc {
  id: string;
  nameRu: string;
  nameEn: string;
  tags: string;
  tools: string;
  category: string;
  extra: string;
}

const FIELDS: (keyof SearchDoc)[] = ['nameRu', 'nameEn', 'tags', 'tools', 'category', 'extra'];
const BOOST: Record<string, number> = {
  nameRu: 3,
  nameEn: 3,
  tags: 2,
  tools: 2,
  category: 1.2,
  extra: 0.6,
};

const CATEGORY_NAMES = new Map(BANK_CATEGORIES.map((c) => [c.id, `${c.name.ru} ${c.name.en}`]));

function toDoc(element: BankElement): SearchDoc {
  const tools = element.toolClasses
    .map((id) => {
      const cls = getToolClass(id);
      return cls
        ? [cls.name.ru, cls.name.en, ...cls.synonyms.ru, ...cls.synonyms.en].join(' ')
        : id;
    })
    .join(' ');
  return {
    id: element.id,
    nameRu: element.name.ru,
    nameEn: element.name.en,
    tags: [...element.tags.ru, ...element.tags.en].join(' '),
    tools,
    category: CATEGORY_NAMES.get(element.category) ?? element.category,
    extra: [
      element.description?.ru,
      element.description?.en,
      element.variantLabel?.ru,
      element.variantLabel?.en,
    ]
      .filter((s): s is string => typeof s === 'string')
      .join(' '),
  };
}

const SEARCH_OPTIONS = {
  fields: FIELDS,
  storeFields: [] as string[],
  tokenize,
  processTerm: (term: string): string | null => stemTerm(term),
};

export function buildSearchIndex(elements: readonly BankElement[]): MiniSearch<SearchDoc> {
  const index = new MiniSearch<SearchDoc>(SEARCH_OPTIONS);
  index.addAll(elements.map(toDoc));
  return index;
}

/** `contentHash` ties the serialised index to the BankIndex it was built from. */
export function serializeSearchIndex(index: MiniSearch<SearchDoc>, contentHash: string): string {
  return JSON.stringify({ searchIndexVersion: SEARCH_INDEX_VERSION, contentHash, index });
}

/** Loads a serialised index; returns null when it is corrupt, of another version, or built for another bank. */
export function loadSearchIndex(json: string, contentHash: string): MiniSearch<SearchDoc> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as {
      searchIndexVersion?: unknown;
      contentHash?: unknown;
      index?: unknown;
    };
    if (record.searchIndexVersion !== SEARCH_INDEX_VERSION || record.contentHash !== contentHash)
      return null;
    if (record.index === undefined) return null;
    return MiniSearch.loadJS<SearchDoc>(
      record.index as Parameters<typeof MiniSearch.loadJS>[0],
      SEARCH_OPTIONS,
    );
  } catch {
    return null;
  }
}

export interface SearchHit {
  id: string;
  score: number;
}

/** AND over all query words first; when that finds nothing, any word (OR) with fuzzy matching. */
export function runSearch(
  index: MiniSearch<SearchDoc>,
  query: string,
  allowed: ReadonlySet<string> | null,
): SearchHit[] {
  if (tokenize(query).every((t) => stemTerm(t) === null)) return [];
  const filter = allowed === null ? undefined : (r: { id: string }): boolean => allowed.has(r.id);
  const strict = index.search(query, {
    combineWith: 'AND',
    prefix: true,
    boost: BOOST,
    ...(filter ? { filter } : {}),
  });
  const results =
    strict.length > 0
      ? strict
      : index.search(query, {
          combineWith: 'OR',
          prefix: true,
          fuzzy: 0.2,
          boost: BOOST,
          ...(filter ? { filter } : {}),
        });
  return results.map((r) => ({ id: String(r.id), score: r.score }));
}
