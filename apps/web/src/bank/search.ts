import MiniSearch from 'minisearch';
import {
  finerToolClasses,
  toolClassVocabulary,
  toolClassWords,
  type BankElement,
  type BankIndex,
  type ToolClass,
} from '@hsw-editor/bank';

/** Lowercase, ё -> е, strip combining marks: "Отвёртка" and "отвертка" are the same word. */
export function normalizeTerm(term: string): string {
  return term
    .toLowerCase()
    .replaceAll('ё', 'е')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

interface SearchDocument {
  readonly id: string;
  readonly nameRu: string;
  readonly nameEn: string;
  readonly tags: string;
  readonly category: string;
  readonly toolClasses: string;
  readonly variant: string;
}

function toDocument(
  element: BankElement,
  index: BankIndex,
  toolClassById: ReadonlyMap<string, ToolClass>,
  finerByBroader: ReadonlyMap<string, readonly ToolClass[]>,
): SearchDocument {
  const categoryNames = element.category
    .split('/')
    .map((_, depth, parts) => parts.slice(0, depth + 1).join('/'))
    .map((id) => index.categories.find((category) => category.id === id))
    .flatMap((category) => (category ? [category.name.ru, category.name.en] : []));
  // A holder of a coarse class also holds the finer ones, so their words match it too.
  const classNames = element.toolClasses.flatMap((id) => {
    const own = toolClassById.get(id);
    return [
      ...(own === undefined ? [] : toolClassWords(own)),
      ...(finerByBroader.get(id) ?? []).flatMap(toolClassWords),
    ];
  });
  return {
    id: element.id,
    nameRu: element.name.ru,
    nameEn: element.name.en,
    tags: [...element.tags.ru, ...element.tags.en].join(' '),
    category: categoryNames.join(' '),
    toolClasses: classNames.join(' '),
    variant: element.variantLabel ? `${element.variantLabel.ru} ${element.variantLabel.en}` : '',
  };
}

export interface BankSearch {
  /** Ranked element ids for a free-text query (names weigh most, then tags, tool classes, categories). */
  readonly search: (query: string) => string[];
}

export function createBankSearch(index: BankIndex): BankSearch {
  const engine = new MiniSearch<SearchDocument>({
    fields: ['nameRu', 'nameEn', 'tags', 'toolClasses', 'category', 'variant', 'id'],
    idField: 'id',
    processTerm: (term) => normalizeTerm(term),
    tokenize: (text) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
    searchOptions: {
      boost: { nameRu: 4, nameEn: 4, tags: 2, toolClasses: 2, variant: 1.5 },
      prefix: true,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      combineWith: 'AND',
    },
  });
  const toolClassById = new Map(toolClassVocabulary(index.toolClasses).map((t) => [t.id, t]));
  const finerByBroader = finerToolClasses(index.toolClasses);
  engine.addAll(
    index.elements.map((element) => toDocument(element, index, toolClassById, finerByBroader)),
  );
  return {
    search(query) {
      const trimmed = query.trim();
      if (trimmed === '') return index.elements.map((element) => element.id);
      return engine.search(trimmed).map((result) => String(result.id));
    },
  };
}

/** Splits `text` into plain and matched segments for highlighting `query` terms (prefix match, ё-insensitive). */
export function highlightSegments(
  text: string,
  query: string,
): readonly { readonly text: string; readonly match: boolean }[] {
  const terms = normalizeTerm(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [{ text, match: false }];
  const lowered = normalizeTerm(text);
  // normalizeTerm preserves length for the scripts we use (single code unit per letter), keeping indices aligned.
  const aligned = lowered.length === text.length;
  if (!aligned) return [{ text, match: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = lowered.indexOf(term, from);
      if (at < 0) break;
      // Only highlight at a word start so "or" does not light up inside "keyboard".
      if (at === 0 || !/[\p{L}\p{N}]/u.test(lowered.charAt(at - 1))) {
        for (let i = at; i < at + term.length; i += 1) marks[i] = true;
      }
      from = at + term.length;
    }
  }
  const segments: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const match = marks[i] === true;
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += text.charAt(i);
    else segments.push({ text: text.charAt(i), match });
  }
  return segments;
}
