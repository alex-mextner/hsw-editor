/**
 * Instanced item meshes carry the ids of their placements in `userData`, so a raycast hit
 * (`object` + `instanceId`) can be turned back into a wall item without going through R3F events.
 */
const ITEM_IDS_KEY = 'itemIds';

/** `userData` for an instanced mesh whose instance `i` draws `placements[i]`. */
export function itemUserData(
  placements: readonly { readonly id: string }[],
): Record<string, string[]> {
  return { [ITEM_IDS_KEY]: placements.map((placement) => placement.id) };
}

/** The item a raycast hit belongs to, or null for anything that is not an item instance. */
export function itemIdOfHit(
  userData: Readonly<Record<string, unknown>>,
  instanceId: number | undefined,
): string | null {
  const ids = userData[ITEM_IDS_KEY];
  if (instanceId === undefined || !Array.isArray(ids)) return null;
  const id: unknown = ids[instanceId];
  return typeof id === 'string' ? id : null;
}
