/**
 * Bank tool-filter state machine. Two sources feed the bank's "fits tool" filter:
 *
 * - `explicit`: the tool classes the user ticked in the filter panel (persisted);
 * - the current wall selection: the classes of the selected tool items (derived, never persisted).
 *
 * A non-empty selection OVERRIDES the explicit filter immediately. The cross on the override chip dismisses
 * the override without touching `explicit`, so the earlier filters come back; changing the selection (or
 * deselecting everything) re-arms the override. Pure reducer: the store layer only wires events in.
 */
import { compatibility } from './compatibility.ts';
import { roundTo } from './rotation.ts';
import { compareIds, type HolderSpec, type ToolInterface } from './types.ts';

export interface ToolSelection {
  /** Ids of the selected tool items; identity decides whether the selection "changed". */
  itemIds: readonly string[];
  /** Distinct bank tool classes of those items, in selection order. */
  classes: readonly string[];
}

export interface ToolFilterState {
  explicit: readonly string[];
  selection: ToolSelection;
  /** The user pressed X on the override chip for the current selection. */
  dismissed: boolean;
}

export type ToolFilterAction =
  | { type: 'setExplicit'; classes: readonly string[] }
  | { type: 'selectionChanged'; selection: ToolSelection }
  | { type: 'dismissOverride' };

const NO_SELECTION: ToolSelection = { itemIds: [], classes: [] };

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function initialToolFilter(explicit: readonly string[] = []): ToolFilterState {
  return { explicit: unique(explicit), selection: NO_SELECTION, dismissed: false };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const known = new Set(a);
  return b.every((id) => known.has(id));
}

export function reduceToolFilter(
  state: ToolFilterState,
  action: ToolFilterAction,
): ToolFilterState {
  switch (action.type) {
    case 'setExplicit':
      return { ...state, explicit: unique(action.classes) };
    case 'selectionChanged': {
      const selection: ToolSelection = {
        itemIds: unique(action.selection.itemIds),
        classes: unique(action.selection.classes),
      };
      if (sameIds(state.selection.itemIds, selection.itemIds)) {
        // Same items: only the classes may have been re-resolved (a model finished loading).
        const sameClasses =
          state.selection.classes.length === selection.classes.length &&
          state.selection.classes.every((id, i) => id === selection.classes[i]);
        return sameClasses ? state : { ...state, selection };
      }
      return { ...state, selection, dismissed: false };
    }
    case 'dismissOverride':
      return state.selection.classes.length === 0 ? state : { ...state, dismissed: true };
  }
}

export interface EffectiveToolFilter {
  /** Where the active classes come from. */
  source: 'selection' | 'explicit';
  classes: readonly string[];
  /** True when the chip with the cross is shown: the selection currently overrides the explicit filter. */
  resettable: boolean;
}

export function effectiveToolFilter(state: ToolFilterState): EffectiveToolFilter {
  if (state.selection.classes.length > 0 && !state.dismissed) {
    return { source: 'selection', classes: state.selection.classes, resettable: true };
  }
  return { source: 'explicit', classes: state.explicit, resettable: false };
}

/** What is stored between sessions: the explicit filter only. */
export function persistToolFilter(state: ToolFilterState): { explicit: string[] } {
  return { explicit: [...state.explicit] };
}

/** Restores from stored JSON; anything malformed yields an empty filter instead of an error. */
export function restoreToolFilter(stored: unknown): ToolFilterState {
  if (typeof stored !== 'object' || stored === null || !('explicit' in stored))
    return initialToolFilter();
  const { explicit } = stored;
  if (!Array.isArray(explicit)) return initialToolFilter();
  return initialToolFilter(explicit.filter((value): value is string => typeof value === 'string'));
}

export interface RankedHolder {
  holder: HolderSpec;
  /** Selected tools this holder accepts. */
  fits: number;
  /** Sum of the per-tool scores of the tools it accepts. */
  score: number;
}

/**
 * Bank elements that accept at least one of the selected tools, best fit first: most tools served, then
 * highest summed fit score, then id (so the order is stable). Holders that take none are dropped.
 */
export function rankHoldersForTools(
  holders: readonly HolderSpec[],
  tools: readonly ToolInterface[],
): RankedHolder[] {
  const ranked: RankedHolder[] = [];
  for (const holder of holders) {
    let fits = 0;
    let score = 0;
    for (const tool of tools) {
      const result = compatibility(tool, holder);
      if (!result.ok) continue;
      fits += 1;
      score += result.score;
    }
    if (fits > 0) ranked.push({ holder, fits, score: roundTo(score, 4) });
  }
  return ranked.sort(
    (a, b) => b.fits - a.fits || b.score - a.score || compareIds(a.holder.id, b.holder.id),
  );
}

/**
 * Class-level filter (no measurements): elements whose `fitsTool` names any of the classes, exactly; expand a finer
 * class with its `broader` first (`expandToolClasses` in `@hsw-editor/bank`) to keep the holders of the coarse one.
 */
export function holdersForClasses(
  holders: readonly HolderSpec[],
  classes: readonly string[],
): HolderSpec[] {
  if (classes.length === 0) return [...holders];
  const wanted = new Set(classes);
  return holders.filter((holder) => holder.fitsTool.some((entry) => wanted.has(entry.toolClass)));
}
