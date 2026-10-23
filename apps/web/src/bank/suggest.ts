/**
 * Pure helper behind the variant picker: which bank elements are size/variant siblings of one another
 * (holder suggestions for a tool live in `holderSuggestions.ts`).
 */
import type { BankElement, BankIndex } from '@hsw-editor/bank';

export type ElementPool = Pick<BankIndex, 'elements'>;

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The element and its siblings (same `family`), ordered by variant label (numeric-aware, so "6 slots"
 * precedes "12 slots") and then by dimensions. An element without a family is its own family.
 */
export function familyOf(index: ElementPool, element: BankElement): BankElement[] {
  const family = element.family;
  if (family === undefined) return [element];
  const members = index.elements.filter((candidate) => candidate.family === family);
  if (!members.some((member) => member.id === element.id)) members.push(element);
  return members.sort((a, b) => {
    const labelA = a.variantLabel?.en;
    const labelB = b.variantLabel?.en;
    if (labelA !== undefined && labelB === undefined) return -1;
    if (labelA === undefined && labelB !== undefined) return 1;
    const byLabel =
      labelA !== undefined && labelB !== undefined
        ? labelA.localeCompare(labelB, 'en', { numeric: true })
        : 0;
    return (
      byLabel ||
      a.dimsMm.x - b.dimsMm.x ||
      a.dimsMm.y - b.dimsMm.y ||
      a.dimsMm.z - b.dimsMm.z ||
      compareIds(a.id, b.id)
    );
  });
}
