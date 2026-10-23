import { type PaletteMode, parsePaletteInput } from '@hsw-editor/commands';
import type { MessageKey } from '@/i18n/index.ts';

export type NavKey = 'ArrowDown' | 'ArrowUp' | 'PageDown' | 'PageUp' | 'Home' | 'End';

export const NAV_KEYS: readonly NavKey[] = [
  'ArrowDown',
  'ArrowUp',
  'PageDown',
  'PageUp',
  'Home',
  'End',
];

export const PAGE_ROWS = 6;

export function isNavKey(key: string): key is NavKey {
  return NAV_KEYS.some((candidate) => candidate === key);
}

/** The row to highlight after `key`; the arrows wrap around, paging and Home/End stop at the ends. */
export function moveActive(current: number, count: number, key: NavKey): number {
  if (count <= 0) return 0;
  const last = count - 1;
  switch (key) {
    case 'ArrowDown':
      return current >= last ? 0 : current + 1;
    case 'ArrowUp':
      return current <= 0 ? last : current - 1;
    case 'PageDown':
      return Math.min(last, current + PAGE_ROWS);
    case 'PageUp':
      return Math.max(0, current - PAGE_ROWS);
    case 'Home':
      return 0;
    case 'End':
      return last;
  }
}

const MODE_PREFIXES: readonly string[] = ['', '>', '@', '#', ':', '?'];

/** Tab accelerates the prefix modes: the typed text stays, the prefix moves on (Shift+Tab goes back). */
export function cycleMode(input: string, backwards: boolean): string {
  const { prefix, text } = parsePaletteInput(input);
  const at = MODE_PREFIXES.indexOf(prefix);
  const next =
    MODE_PREFIXES[(at + (backwards ? -1 : 1) + MODE_PREFIXES.length) % MODE_PREFIXES.length];
  return `${next ?? ''}${text}`;
}

export const PLACEHOLDER_KEYS: Readonly<Record<PaletteMode, MessageKey>> = {
  all: 'palette.placeholderAll',
  commands: 'palette.placeholderMode.commands',
  items: 'palette.placeholderMode.items',
  bank: 'palette.placeholderMode.bank',
  goto: 'palette.placeholderMode.goto',
  ai: 'palette.placeholderMode.ai',
};

export const MODE_LABEL_KEYS: Readonly<Record<PaletteMode, MessageKey>> = {
  all: 'palette.mode.all',
  commands: 'palette.mode.commands',
  items: 'palette.mode.items',
  bank: 'palette.mode.bank',
  goto: 'palette.mode.goto',
  ai: 'palette.mode.ai',
};

/** Hint under an empty row: what Enter does for each kind of result. */
export const ENTER_HINT_KEYS = {
  command: 'palette.enterRuns',
  recent: 'palette.enterRuns',
  setting: 'palette.enterToggles',
  wall: 'palette.enterOpen',
  goto: 'palette.enterOpen',
  item: 'palette.enterSelect',
  bank: 'palette.enterAdd',
  tool: 'palette.enterAdd',
  history: 'palette.undoTo',
  doc: 'palette.enterOpen',
  ai: 'palette.enterAsk',
} as const satisfies Readonly<Record<string, MessageKey>>;
