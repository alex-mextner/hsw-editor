import { createValueStore } from '#state-backend';

/**
 * The tool the wall report list is pointing at (row hover/focus), so the viewport can pulse its amber marks. A store
 * rather than a prop: the list lives in the side panel and the zones inside the R3F canvas.
 */
export const physicsHoverStore = createValueStore<string | null>(null);
