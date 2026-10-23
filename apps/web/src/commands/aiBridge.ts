/**
 * The palette's seam to the embedded agent: the omp panel's bridge (one WebSocket shared with the panel).
 * Its status is honest: `unavailable` while no wall is open or the omp child failed, `connecting` while the
 * connection or omp is coming up. The store stays swappable so a test can install a fake.
 */
import { createValueStore } from '#state-backend';
import type { PaletteAiBridge } from '@hsw-editor/commands';
import { ompPaletteBridge } from '@/features/omp/store.ts';
import type { ValueStore } from '@/state/types.ts';

export const aiBridgeStore: ValueStore<PaletteAiBridge> =
  createValueStore<PaletteAiBridge>(ompPaletteBridge);
