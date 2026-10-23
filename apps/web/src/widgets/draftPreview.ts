import { useEffect } from 'react';
import { variantFor, variantVersion } from '@/bank/models.ts';
import { clearParamsDraft, paramsDraftFor, setParamsDraft, type ParamsDraft } from './draft.ts';

/** Pause after the last keystroke / slider tick before a regenerated model is requested. */
export const PREVIEW_DEBOUNCE_MS = 150;

/**
 * `ItemsLayer` regroups only when `variantVersion` changes, so every draft change nudges it; the
 * regrouping itself is cheap and the model it resolves is already cached at that point.
 */
function announce(): void {
  variantVersion.set(variantVersion.get() + 1);
}

function withdraw(itemId: string): void {
  if (paramsDraftFor(itemId) === undefined) return;
  clearParamsDraft(itemId);
  announce();
}

/**
 * Shows `working` (an item's would-be params) in the scene. The draft is published only once its
 * regenerated variant has arrived, so the old model stays on screen instead of flashing back to the
 * base model while the server rebuilds. `null` withdraws the preview.
 */
export function useDraftPreview(
  itemId: string,
  elementId: string | null,
  working: ParamsDraft['params'] | null,
): void {
  useEffect(() => {
    if (working === null) {
      withdraw(itemId);
      return undefined;
    }
    // No overrides means the base model, which needs no generated variant; items without a bank
    // element (tools drawn as boxes) have nothing to regenerate either.
    const ready = (): boolean =>
      elementId === null ||
      Object.keys(working).length === 0 ||
      variantFor(elementId, working) !== undefined;
    const publish = (): void => {
      setParamsDraft(itemId, working);
      announce();
    };
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (ready()) {
        publish();
        return;
      }
      unsubscribe = variantVersion.subscribe(() => {
        if (!ready()) return;
        // Unsubscribe first: publishing bumps `variantVersion`, which would re-enter this callback.
        unsubscribe?.();
        unsubscribe = null;
        publish();
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [itemId, elementId, working]);

  // Leaving the widget (selection change, unmount) must never leave a stale preview behind.
  useEffect(() => () => withdraw(itemId), [itemId]);
}
