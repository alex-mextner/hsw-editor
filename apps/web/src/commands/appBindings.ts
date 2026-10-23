/** The existing stores that own theme, language, snap, units, view and panel visibility. */
import { isLocale, localeStore } from '@/i18n/locale.ts';
import { editorStore, patchEditor } from '@/state/editor.ts';
import { layoutStore, type LayoutState } from '@/state/layout.ts';
import { themeStore } from '@/state/theme.ts';
import { isLengthUnit, unitStore } from '@/widgets/units.ts';
import type { SettingBinding } from './settingsBridge.ts';

/** The app store saved a value under `key`: only a deliberate choice (or a synced value) is saved. */
function hasStoredChoice(key: string): () => boolean {
  return () => {
    try {
      return globalThis.localStorage?.getItem(key) != null;
    } catch {
      return false;
    }
  };
}

function panelBinding(id: string, key: keyof LayoutState): SettingBinding {
  return {
    id,
    read: () => layoutStore.get()[key],
    write: (value) => layoutStore.set({ ...layoutStore.get(), [key]: value === true }),
    subscribe: layoutStore.subscribe,
  };
}

export function appSettingBindings(): readonly SettingBinding[] {
  return [
    {
      id: 'appearance.theme',
      read: () => themeStore.get(),
      write: (value) => themeStore.set(value === 'light' ? 'light' : 'dark'),
      subscribe: themeStore.subscribe,
      userChoice: hasStoredChoice('hsw-editor.theme'),
    },
    {
      id: 'appearance.language',
      read: () => localeStore.get(),
      write: (value) => {
        if (typeof value === 'string' && isLocale(value)) localeStore.set(value);
      },
      subscribe: localeStore.subscribe,
      userChoice: hasStoredChoice('hsw-editor.locale'),
    },
    {
      id: 'editor.snap',
      read: () => editorStore.get().snap,
      write: (value) => patchEditor({ snap: value === true }),
      // The editor store changes on every drag frame; the bridge compares before it writes.
      subscribe: editorStore.subscribe,
    },
    {
      id: 'view.mode',
      read: () => editorStore.get().view,
      write: (value) => patchEditor({ view: value === 'front' ? 'front' : 'perspective' }),
      subscribe: editorStore.subscribe,
    },
    {
      id: 'units.length',
      read: () => unitStore.get(),
      write: (value) => {
        if (typeof value === 'string' && isLengthUnit(value)) unitStore.set(value);
      },
      subscribe: unitStore.subscribe,
      userChoice: hasStoredChoice('hsw.widgets.unit'),
    },
    panelBinding('layout.bank', 'leftOpen'),
    panelBinding('layout.inspector', 'rightOpen'),
    panelBinding('layout.history', 'bottomOpen'),
    panelBinding('layout.agent', 'ompOpen'),
  ];
}
