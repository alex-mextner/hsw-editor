import type { Theme } from '@/state/theme.ts';

/** Scene colours per UI theme; the viewport background itself comes from the CSS `--viewport` token. */
export interface ScenePalette {
  readonly plate: string;
  readonly cell: string;
  readonly cellOccupied: string;
  readonly item: string;
  readonly itemSelected: string;
  readonly itemInvalid: string;
  readonly itemLocked: string;
  /** Placeholder box of an item whose model is missing or failed to load. */
  readonly itemMissing: string;
  readonly ghostOk: string;
  readonly ghostBad: string;
  readonly measure: string;
  readonly dimension: string;
  /** The floor under the wall where released tools fall, at rest and lit (while a tool is dragged or falls). */
  readonly floor: string;
  readonly floorLit: string;
}

const DARK: ScenePalette = {
  plate: '#50505a',
  cell: '#26262c',
  cellOccupied: '#5a4720',
  item: '#c9ccd3',
  itemSelected: '#f5b942',
  itemInvalid: '#ef5350',
  itemLocked: '#7d8696',
  itemMissing: '#fb923c',
  ghostOk: '#4ade80',
  ghostBad: '#ef5350',
  measure: '#38bdf8',
  dimension: '#f5b942',
  floor: '#6b7280',
  floorLit: '#22d3ee',
};

const LIGHT: ScenePalette = {
  plate: '#b7b4aa',
  cell: '#dcd9cf',
  cellOccupied: '#efd391',
  item: '#4b5563',
  itemSelected: '#d97706',
  itemInvalid: '#dc2626',
  itemLocked: '#9ca3af',
  itemMissing: '#ea580c',
  ghostOk: '#16a34a',
  ghostBad: '#dc2626',
  measure: '#0284c7',
  dimension: '#b45309',
  floor: '#9ca3af',
  floorLit: '#0891b2',
};

export function scenePalette(theme: Theme): ScenePalette {
  return theme === 'dark' ? DARK : LIGHT;
}
