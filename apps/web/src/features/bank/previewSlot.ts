import { createValueStore } from '#state-backend';

/**
 * Owner of the single live 3D preview canvas. Every WebGL context costs GPU memory and browsers cap
 * them at ~16, so hover previews and the detail view take turns: whoever holds the slot may mount a
 * canvas, everyone else keeps showing the thumbnail.
 */
export const previewSlotStore = createValueStore<string | null>(null);

const HOVER_PREFIX = 'hover:';
const HOVER_DELAY_MS = 250;

export const hoverSlotKey = (elementId: string): string => `${HOVER_PREFIX}${elementId}`;
export const detailSlotKey = (elementId: string): string => `detail:${elementId}`;

export function claimPreviewSlot(key: string): void {
  previewSlotStore.set(key);
}

export function releasePreviewSlot(key: string): void {
  if (previewSlotStore.get() === key) previewSlotStore.set(null);
}

let hoverTimer: number | undefined;
let hoverTimerElement: string | undefined;

/** Claims the slot for `elementId` once the pointer has rested on its card for a moment. */
export function scheduleHoverPreview(elementId: string): void {
  window.clearTimeout(hoverTimer);
  hoverTimerElement = elementId;
  hoverTimer = window.setTimeout(() => {
    hoverTimer = undefined;
    hoverTimerElement = undefined;
    claimPreviewSlot(hoverSlotKey(elementId));
  }, HOVER_DELAY_MS);
}

/**
 * Drops a pending or active hover preview (pointer left, drag, unmount). With `elementId` only that
 * card's preview is affected; without it any hover preview goes (scroll). Never the detail one.
 */
export function cancelHoverPreview(elementId?: string): void {
  if (elementId === undefined || hoverTimerElement === elementId) {
    window.clearTimeout(hoverTimer);
    hoverTimer = undefined;
    hoverTimerElement = undefined;
  }
  const owner = previewSlotStore.get();
  if (
    owner?.startsWith(HOVER_PREFIX) &&
    (elementId === undefined || owner === hoverSlotKey(elementId))
  ) {
    previewSlotStore.set(null);
  }
}
