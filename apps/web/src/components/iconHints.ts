/**
 * First-use hints of icon buttons: the first time a person presses an icon, its label (the tooltip text) is shown for a moment, so a
 * phone (no hover, so no tooltip ever) explains every icon once. Remembered per hint key on this device.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPersistedStore } from '@/state/persisted.ts';

/** How long the hint stays on screen. */
export const FIRST_USE_HINT_MS = 2600;

/** The device-wide set of hint keys already shown. Keys are fixed ids (or fixed labels), so the cap is never reached by names. */
const MAX_REMEMBERED = 400;

const STORAGE_KEY = 'hsw.iconHintsSeen';

function parseKeys(raw: string): readonly string[] | null {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
    ? parsed
    : null;
}

export const seenHintsStore = createPersistedStore<readonly string[]>(STORAGE_KEY, [], parseKeys);

export const hintSeen = (key: string): boolean => seenHintsStore.get().includes(key);

/** True the first time `key` is used on this device (and remembers it). */
export function takeFirstUse(key: string): boolean {
  if (hintSeen(key)) return false;
  // Another tab may have remembered hints since this one loaded: keep them.
  const others = storedKeys().filter((other) => !seenHintsStore.get().includes(other));
  seenHintsStore.set([...others, ...seenHintsStore.get(), key].slice(-MAX_REMEMBERED));
  return true;
}

function storedKeys(): readonly string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw == null ? [] : (parseKeys(raw) ?? []);
  } catch {
    return [];
  }
}

export interface FirstUseHint {
  /** The label the pressed button had when it was pressed (a toggle's label changes with the press), or null when no hint shows. */
  readonly showing: string | null;
  /**
   * Call on every press with the button's current label. `onScreen`: the tooltip is already open (hovered, focused), so its label
   * has been seen and there is nothing to hold open.
   */
  readonly press: (label: string, onScreen: boolean) => void;
  /** Call when the tooltip closes for any reason (Escape, outside tap, another tooltip): ends the hint. */
  readonly dismiss: () => void;
}

/**
 * The hint of one button. It is remembered as shown only once it is on screen: a press that removes or hides its own button never
 * uses the hint up. `key` is the hint's identity (the label unless the label carries a name), `anchor` the button.
 */
export function useFirstUseHint(key: string, anchor: RefObject<HTMLElement | null>): FirstUseHint {
  const [pending, setPending] = useState<{ readonly label: string; readonly key: string } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setPending(null);
  }, []);
  const press = useCallback(
    (label: string, onScreen: boolean): void => {
      if (hintSeen(key)) return;
      if (onScreen) {
        takeFirstUse(key);
        return;
      }
      // The key of this press: a toggle's label (and so its key) is another one by the time the hint is on screen.
      setPending({ label, key });
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(stop, FIRST_USE_HINT_MS);
    },
    [key, stop],
  );
  useEffect(() => {
    if (pending === null) return undefined;
    // After the press has rendered: a button that is gone or hidden by then has nothing to explain.
    const frame = globalThis.requestAnimationFrame(() => {
      const button = anchor.current;
      if (button === null || !button.isConnected || button.getClientRects().length === 0) stop();
      else takeFirstUse(pending.key);
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [pending, anchor, stop]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return { showing: pending?.label ?? null, press, dismiss: stop };
}
