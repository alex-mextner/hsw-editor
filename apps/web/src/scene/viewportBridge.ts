import type { Vec2 } from '@/state/editor.ts';

/** Lets code outside the R3F tree (DOM drag-and-drop, window listeners) ask where the cursor is on the wall. */
export interface ViewportBridge {
  /** Wall-plane point (mm) under a client position, or null when the ray misses the plane. */
  readonly toWall: (clientX: number, clientY: number) => Vec2 | null;
  readonly invalidate: () => void;
}

let current: ViewportBridge | null = null;

export function setViewportBridge(bridge: ViewportBridge | null): void {
  current = bridge;
}

export function wallPointAt(clientX: number, clientY: number): Vec2 | null {
  return current?.toWall(clientX, clientY) ?? null;
}
