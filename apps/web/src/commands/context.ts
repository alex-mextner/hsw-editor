import type { Context } from '@hsw-editor/commands';

export type FocusRegion =
  | 'canvas'
  | 'palette'
  | 'bank'
  | 'inspector'
  | 'history'
  | 'agent'
  | 'input';

/** `data-slot` of the shell region that contains focus, to the name when-clauses use. */
const REGION_BY_SLOT: Readonly<Record<string, FocusRegion>> = {
  viewport: 'canvas',
  palette: 'bank',
  inspector: 'inspector',
  timeline: 'history',
  'omp-dock': 'agent',
};

export interface FocusProbe {
  /** `data-slot` of the closest shell region around the focused element, if any. */
  readonly slot: string | undefined;
  readonly typing: boolean;
  readonly paletteOpen: boolean;
}

/** Where keyboard focus is: a field beats a region, the open palette beats everything. */
export function focusRegion(probe: FocusProbe): FocusRegion {
  if (probe.paletteOpen) return 'palette';
  if (probe.typing) return 'input';
  return (probe.slot === undefined ? undefined : REGION_BY_SLOT[probe.slot]) ?? 'canvas';
}

export interface ContextInput {
  readonly selectionCount: number;
  readonly hasWall: boolean;
  /** The wall has a photo (shown or not) that can be calibrated. */
  readonly hasPhoto: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Items were copied and Paste has something to place. */
  readonly clipboard: boolean;
  /** Text is selected somewhere on the page: Ctrl+C is then a text copy. */
  readonly textSelection: boolean;
  /** A wall point was picked with "add element here"; Escape cancels it. */
  readonly placeAt: boolean;
  /** Active editor tool (`select`, `measure`, ...). */
  readonly mode: string;
  readonly dialogOpen: boolean;
  readonly focus: FocusRegion;
  /** `setting.<id>` keys from the settings store. */
  readonly settings: Context;
}

/** The context object when-clauses are evaluated against (see docs/hotkeys.md). */
export function deriveContext(input: ContextInput): Context {
  return {
    ...input.settings,
    selection: input.selectionCount > 0,
    hasWall: input.hasWall,
    hasPhoto: input.hasPhoto,
    canUndo: input.canUndo,
    canRedo: input.canRedo,
    clipboard: input.clipboard,
    textSelection: input.textSelection,
    placeAt: input.placeAt,
    mode: input.mode,
    dialog: input.dialogOpen,
    focus: input.focus,
  };
}

/** Selector matching only the shell regions: UI primitives (button, input...) carry `data-slot` too. */
export const REGION_SELECTOR = Object.keys(REGION_BY_SLOT)
  .map((slot) => `[data-slot="${slot}"]`)
  .join(',');

/** The part of an element the focus probe needs; a DOM `Element` satisfies it. */
export interface FocusSource {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/** Reads the focus probe from the element that has focus; the only DOM-dependent part of the context. */
export function probeFocus(
  paletteOpen: boolean,
  typing: boolean,
  active: FocusSource | null = globalThis.document?.activeElement ?? null,
): FocusProbe {
  const slot = active?.closest(REGION_SELECTOR)?.getAttribute('data-slot') ?? undefined;
  return { slot, typing, paletteOpen };
}
