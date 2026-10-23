/**
 * The served bank view = the built bank + the user elements. Done in memory per snapshot (the user tree is
 * its own root, see store.ts), so `bank:ingest` / `bank:verify` never see user data and a rebuilt bank keeps
 * the user's elements.
 */
import type { BankElement, BankIndex, UnavailableElement } from '../../schema.ts';
import { indexContentHash } from '../hash.ts';
import { firstProblemByElement, verifyBank } from '../verify.ts';

export interface UserRootState {
  /** The user elements that are intact and merged into the view. */
  elements: BankElement[];
  /** Elements of the user tree left out because their files are damaged. */
  withheld: UnavailableElement[];
  /** The user index is unreadable: nothing of it is served (listed in health). */
  problems: string[];
  /** Asset path -> recorded bytes, for `locate`. */
  sizes: ReadonlyMap<string, number> | null;
}

/** Quick verification of the user tree; a missing tree is simply empty. */
export async function readUserRoot(root: string): Promise<UserRootState> {
  const check = await verifyBank(root, { quick: true });
  const indexProblem = check.issues.find((i) => i.kind === 'index');
  if (!check.index || indexProblem) {
    // no index.json at all is the normal "nothing imported yet"
    const empty = check.issues.length === 1 && check.issues[0]?.detail.startsWith('no index.json');
    return { elements: [], withheld: [], problems: empty ? [] : check.problems, sizes: null };
  }
  const broken = firstProblemByElement(check.issues);
  const sizes = new Map<string, number>();
  for (const { assets } of check.index.elements)
    for (const asset of [assets.lod0, assets.lod1, assets.thumbnail])
      sizes.set(asset.path, asset.bytes);
  return {
    elements: check.index.elements.filter((e) => !broken.has(e.id)),
    withheld: check.index.elements.flatMap((e) => {
      const reason = broken.get(e.id);
      return reason === undefined ? [] : [{ id: e.id, name: e.name, reason }];
    }),
    problems: [],
    sizes,
  };
}

/**
 * `base` plus the user elements. Counts and the hash are recomputed (the ETag changes with the user data).
 * Not validated like a published index: a user element may legitimately share its geometry with a bank
 * element, and ids cannot clash (user ids carry the `my-` prefix); a clash would let the bank element win.
 */
export function mergeUserElements(
  base: BankIndex,
  user: readonly BankElement[],
  withheld: readonly UnavailableElement[],
): BankIndex {
  if (user.length === 0 && withheld.length === 0) return base;
  const known = new Set(base.elements.map((e) => e.id));
  const elements = [...base.elements, ...user.filter((e) => !known.has(e.id))];
  const generated = elements.filter((e) => e.generated).length;
  const unavailable = [...(base.unavailable ?? []), ...withheld];
  const merged = {
    version: base.version,
    grid: base.grid,
    counts: {
      total: elements.length,
      fromSources: elements.length - generated,
      generated,
      redistributable: elements.filter((e) => e.license.redistributable).length,
    },
    categories: base.categories,
    toolClasses: base.toolClasses,
    elements,
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };
  return { ...merged, contentHash: indexContentHash(merged) };
}
