/**
 * In-progress dimension edit, shown in the scene before any op is sent. Leaf module on purpose:
 * `bank/models.ts` reads it from `resolveModel`, so it must not import anything from the scene.
 */
import { createValueStore } from '#state-backend';

export interface ParamsDraft {
  readonly itemId: string;
  /** Complete override set the item would have if the edit were committed. */
  readonly params: Readonly<Record<string, number>>;
}

export const paramsDraftStore = createValueStore<ParamsDraft | null>(null);

/** Keep-proportions toggle of the dimension widget; shared so the inspector and inline copies agree. */
export const aspectLockStore = createValueStore<boolean>(false);

/** Draft params for `itemId`, or undefined when that item has no edit in flight. */
export function paramsDraftFor(itemId: string): Readonly<Record<string, number>> | undefined {
  const draft = paramsDraftStore.get();
  return draft?.itemId === itemId ? draft.params : undefined;
}

export function setParamsDraft(itemId: string, params: Readonly<Record<string, number>>): void {
  paramsDraftStore.set({ itemId, params });
}

/** Drops the draft of `itemId` (any draft when omitted). A draft of another item is left alone. */
export function clearParamsDraft(itemId?: string): void {
  const draft = paramsDraftStore.get();
  if (draft && (itemId === undefined || draft.itemId === itemId)) paramsDraftStore.set(null);
}
