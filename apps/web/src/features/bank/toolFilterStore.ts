/**
 * The bank's tool filter. `explicit` (the Holds select, persisted) is what the user chose; the selected
 * tool items on the wall override it while any is selected (`selectionOverride`), and the X on the
 * "Filter: tools" chip dismisses only the override so the explicit choice returns. The state machine
 * itself lives in `@hsw-editor/compat` (pure, tested); this file adds persistence and the wiring to the
 * editor selection.
 */
import {
  effectiveToolFilter,
  initialToolFilter,
  persistToolFilter,
  reduceToolFilter,
  restoreToolFilter,
  type ToolFilterAction,
  type ToolFilterState,
} from '@hsw-editor/compat';
import { gridScrollMemory } from './panelState.ts';
import { createPersistedStore } from '@/state/persisted.ts';
import { editorStore } from '@/state/editor.ts';
import { sessionStore } from '@/wall/session.ts';
import { toolClassOfItem } from '@/wall/toolInterface.ts';

export const toolFilterStore = createPersistedStore<ToolFilterState>(
  'hsw.bank.toolFilter',
  initialToolFilter(),
  (raw) => {
    try {
      return restoreToolFilter(JSON.parse(raw));
    } catch {
      return null;
    }
  },
  (state) => JSON.stringify(persistToolFilter(state)),
);

export function dispatchToolFilter(action: ToolFilterAction): void {
  const current = toolFilterStore.get();
  const next = reduceToolFilter(current, action);
  if (next === current) return;
  // A different result list starts at the top (the grid restores its offset on remount otherwise).
  if (effectiveToolFilter(next).classes.join() !== effectiveToolFilter(current).classes.join()) {
    gridScrollMemory.top = 0;
  }
  toolFilterStore.set(next);
}

/** Feeds the selected tool items (and their classes) into the filter; call once at startup. */
export function startToolSelectionSync(): () => void {
  const push = (): void => {
    const wall = sessionStore.get()?.wall;
    const selection = editorStore.get().selection;
    const itemIds: string[] = [];
    const classes: string[] = [];
    for (const item of wall?.items ?? []) {
      if (item.kind !== 'tool' || !selection.includes(item.id)) continue;
      itemIds.push(item.id);
      const toolClass = toolClassOfItem(item, wall as NonNullable<typeof wall>);
      if (toolClass !== undefined) classes.push(toolClass);
    }
    dispatchToolFilter({ type: 'selectionChanged', selection: { itemIds, classes } });
  };
  push();
  const stops = [editorStore.subscribe(push), sessionStore.subscribe(push)];
  return () => stops.forEach((stop) => stop());
}
