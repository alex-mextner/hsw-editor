import { createPersistedStore } from '@/state/persisted.ts';

/**
 * Settings toggle "physics checks". Persisted; on by default (the verdicts are advisory, nothing is blocked either way).
 * Off: no worker is started, no report is shown and a hung tool keeps the pose the compatibility maths gave it.
 */
export const physicsEnabledStore = createPersistedStore<boolean>(
  'hsw-editor.physics',
  true,
  (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
  (value) => String(value),
);
