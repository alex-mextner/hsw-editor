/**
 * Pure composition of a bank index: counts and `contentHash` are derived from the content, never
 * supplied, so they cannot drift from it; broken elements move to `unavailable`. Used by every writer
 * (ingest, `bank:adopt`, seed export) and by the server to serve a damaged root minus its broken elements.
 */
import {
  BANK_SCHEMA_VERSION,
  type BankElement,
  type BankIndex,
  type UnavailableElement,
} from '../schema.ts';
import { validateBankIndex } from '../validate.ts';
import { indexContentHash } from './hash.ts';

export interface IndexParts {
  grid: BankIndex['grid'];
  categories: BankIndex['categories'];
  toolClasses: BankIndex['toolClasses'];
  elements: BankElement[];
  unavailable?: UnavailableElement[];
}

/** Counts and `contentHash` are derived here, never supplied, so they cannot drift from the content. */
export function composeIndex(parts: IndexParts): BankIndex {
  const generated = parts.elements.filter((e) => e.generated).length;
  const withheld = parts.unavailable ?? [];
  const base = {
    version: BANK_SCHEMA_VERSION,
    grid: parts.grid,
    counts: {
      total: parts.elements.length,
      fromSources: parts.elements.length - generated,
      generated,
      redistributable: parts.elements.filter((e) => e.license.redistributable).length,
    },
    categories: parts.categories,
    toolClasses: parts.toolClasses,
    elements: parts.elements,
    ...(withheld.length > 0 ? { unavailable: withheld } : {}),
  };
  // One definition of the hash (see indexContentHash): the serialised index without the field itself.
  const index: BankIndex = { ...base, contentHash: indexContentHash(base) };
  const validation = validateBankIndex(index);
  if (!validation.ok)
    throw new Error(`generated index is invalid:\n${validation.errors.slice(0, 30).join('\n')}`);
  return index;
}

/** `parts` without the elements in `broken`, which move to `unavailable` with their reason. */
export function withholdBroken(parts: IndexParts, broken: ReadonlyMap<string, string>): IndexParts {
  return {
    ...parts,
    elements: parts.elements.filter((e) => !broken.has(e.id)),
    unavailable: [
      ...(parts.unavailable ?? []),
      ...parts.elements.flatMap((e) => {
        const reason = broken.get(e.id);
        return reason === undefined ? [] : [{ id: e.id, name: e.name, reason }];
      }),
    ],
  };
}
