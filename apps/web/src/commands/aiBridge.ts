/**
 * The palette's seam to the embedded agent. Until the omp panel bridge exists the bridge is an
 * honest "unavailable" one: the palette says so instead of pretending to ask somebody.
 */
import { createValueStore } from '#state-backend';
import type { PaletteAiBridge } from '@hsw-editor/commands';
import type { ValueStore } from '@/state/types.ts';

export const UNAVAILABLE_AI_BRIDGE: PaletteAiBridge = {
  status: () => 'unavailable',
  onStatus: () => () => undefined,
  ask: (_request, onEvent) => {
    onEvent({ t: 'error', message: 'the agent bridge is not available in this build' });
    return { cancel: () => undefined };
  },
  setAppCommandHandler: () => () => undefined,
};

/** Replace the value with the real bridge adapter when the omp panel bridge lands. */
export const aiBridgeStore: ValueStore<PaletteAiBridge> =
  createValueStore<PaletteAiBridge>(UNAVAILABLE_AI_BRIDGE);
