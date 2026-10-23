/**
 * Pointer bindings of the viewport camera. Left drag on the background orbits, middle drag pans,
 * the wheel zooms, one finger orbits and two fingers pan/zoom; the right button is deliberately
 * unbound because it opens the context menu. A press on an item belongs to the item (move/rotate),
 * so `bindCameraLock` switches the controls off for the duration of that press; the measure and
 * calibrate tools own the left drag too, so the controls stay off while either is active.
 */
import { MOUSE, TOUCH } from 'three';
import type { ToolMode } from '@/state/editor.ts';
import type { Store } from '@/state/types.ts';

export interface NavigationMode {
  /** The front view is orthographic and locked to the wall plane: it can pan and zoom, not orbit. */
  readonly ortho: boolean;
}

export interface MouseBindings {
  readonly LEFT: MOUSE;
  readonly MIDDLE: MOUSE;
}

export interface TouchBindings {
  readonly ONE: TOUCH;
  readonly TWO: TOUCH;
}

/** Shift/Ctrl + left drag also pans: OrbitControls swaps ROTATE for PAN while a modifier is held. */
export function mouseButtonsFor({
  ortho,
  panHeld,
}: NavigationMode & { readonly panHeld: boolean }): MouseBindings {
  return { LEFT: ortho || panHeld ? MOUSE.PAN : MOUSE.ROTATE, MIDDLE: MOUSE.PAN };
}

export function touchesFor({ ortho }: NavigationMode): TouchBindings {
  return { ONE: ortho ? TOUCH.PAN : TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
}

/**
 * Keeps `controls.enabled` equal to "no item is held and the select tool is active"
 * (the other tools own the left drag). The store notifies synchronously, so the
 * controls are already off when the item's pointer-down handler returns, before OrbitControls'
 * own pointer-down listener (or any React render) can start an orbit under the dragged item.
 * Returns the unbind function.
 */
export function bindCameraLock(
  controls: { enabled: boolean },
  store: Store<{ readonly holding: boolean; readonly tool: ToolMode }>,
): () => void {
  const sync = (): void => {
    const { holding, tool } = store.getSnapshot();
    controls.enabled = !holding && tool === 'select';
  };
  sync();
  return store.subscribe(sync);
}
