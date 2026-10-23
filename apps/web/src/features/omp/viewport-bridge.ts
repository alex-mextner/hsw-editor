/**
 * What the agent can do to the 3D viewport. The scene owner (WebEditor) registers an implementation
 * when the canvas is mounted; the omp store calls it for `ui_call` requests from the server
 * (`wall_view`, `wall_select`, selection in `wall_get`).
 */
import type { ViewportCall, ViewportCapture, ViewportResult } from '@hsw-editor/omp-protocol';

export interface ViewportBridge {
  /** Ids of the currently selected wall items. */
  getSelection(): readonly string[];
  /** Replace the selection; returns what ended up selected (unknown ids are dropped). */
  select(ids: readonly string[]): readonly string[];
  /** Render the viewport and return an image no larger than `maxSidePx` on its longer side. */
  capture(options: {
    readonly view: 'current' | 'front' | 'iso';
    readonly maxSidePx: number;
  }): Promise<ViewportCapture>;
}

let current: ViewportBridge | null = null;

/** Returns an unregister function; a later registration replaces an earlier one. */
export function registerViewportBridge(bridge: ViewportBridge): () => void {
  current = bridge;
  return () => {
    if (current === bridge) current = null;
  };
}

export async function runViewportCall(call: ViewportCall): Promise<ViewportResult> {
  const bridge = current;
  if (bridge === null) throw new Error('the 3D viewport is not mounted in this window');
  switch (call.method) {
    case 'get_selection':
      return { selected: bridge.getSelection() };
    case 'select':
      return { selected: bridge.select(call.params.ids) };
    case 'capture':
      return bridge.capture(call.params);
  }
}
