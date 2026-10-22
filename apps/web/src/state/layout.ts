import { createPersistedStore } from './persisted.ts';

export interface LayoutState {
  readonly leftOpen: boolean;
  readonly rightOpen: boolean;
  readonly bottomOpen: boolean;
  readonly ompOpen: boolean;
}

const DEFAULT_LAYOUT: LayoutState = {
  leftOpen: true,
  rightOpen: true,
  bottomOpen: true,
  ompOpen: false,
};

function parseLayout(raw: string): LayoutState | null {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) return null;
  const pick = (key: keyof LayoutState): boolean => {
    const field: unknown = Reflect.get(value, key);
    return typeof field === 'boolean' ? field : DEFAULT_LAYOUT[key];
  };
  return {
    leftOpen: pick('leftOpen'),
    rightOpen: pick('rightOpen'),
    bottomOpen: pick('bottomOpen'),
    ompOpen: pick('ompOpen'),
  };
}

export const layoutStore = createPersistedStore<LayoutState>(
  'hsw-editor.layout',
  DEFAULT_LAYOUT,
  parseLayout,
);

export function togglePanel(key: keyof LayoutState): void {
  const layout = layoutStore.get();
  layoutStore.set({ ...layout, [key]: !layout[key] });
}
