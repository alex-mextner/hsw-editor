import { createValueStore } from '#state-backend';
import { createPersistedStore } from '@/state/persisted.ts';
import type { SolveResult } from './engine.ts';

/** Top-bar toggle. Persisted; on by default (the marks are advisory, nothing is blocked either way). */
export const invalidZonesEnabledStore = createPersistedStore<boolean>(
  'hsw-editor.invalid-zones',
  true,
  (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
  (value) => String(value),
);

/** Latest engine answer for the open wall, published by the viewport for the inspector and the legend. */
export const invalidZonesResultStore = createValueStore<SolveResult | null>(null);
