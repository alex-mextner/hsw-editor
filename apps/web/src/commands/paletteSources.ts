/** The palette's real sources: engine commands and settings plus the app providers on live stores. */
import { commandProvider, settingsProvider, type PaletteProvider } from '@hsw-editor/commands';
import { bankRoutes, bankStore } from '@/bank/client.ts';
import { notify } from '@/features/notices/notices.ts';
import { localeStore, t } from '@/i18n/index.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { fitView, setSelection } from '@/state/editor.ts';
import { addElementToWall, addToolPreset, currentWall } from '@/wall/actions.ts';
import { sessionStore, wallListStore } from '@/wall/session.ts';
import { loadUndoWindow, undoToRevision } from './appActions.ts';
import {
  cheatSheetStore,
  commandRegistry,
  getBaseContext,
  keybindingEditorStore,
  keymapStore,
  settingsStore,
} from './app.ts';
import {
  bankProvider,
  docsProvider,
  gotoProvider,
  historyProviders,
  type ProviderDeps,
  wallItemsProvider,
  wallsProvider,
} from './providers.ts';

function requireWall(added: string | null): void {
  if (added === null && currentWall() === null) notify('error', t('cmd.needsWall'));
}

const deps: ProviderDeps = {
  walls: () => wallListStore.get(),
  openWall: (id) => currentWallId.set(id),
  currentWallId: () => sessionStore.get()?.wallId ?? null,
  currentRev: () => sessionStore.get()?.confirmedRev ?? 0,
  pendingEdits: () => sessionStore.get()?.pending ?? 0,
  wallItems: () => currentWall()?.items ?? [],
  selectItem: (id) => {
    setSelection([id]);
    fitView();
  },
  bank: () => {
    const state = bankStore.get();
    return state.status === 'ready' ? { status: 'ready', index: state.index } : state;
  },
  thumbnailUrl: (element) => bankRoutes.asset(element.assets.thumbnail.path),
  addBankElement: (element) => requireWall(addElementToWall(element)),
  addToolPreset: (toolClass) =>
    requireWall(addToolPreset(toolClass, toolClass.name[localeStore.get()])),
  loadHistory: loadUndoWindow,
  undoToRevision: async (rev) => {
    await undoToRevision(rev);
  },
  focusPanel: (panel) =>
    void commandRegistry.run(`panel.focus.${panel}`, undefined, getBaseContext()),
  openCheatSheet: () => cheatSheetStore.set(true),
  openKeybindingEditor: () => keybindingEditorStore.set(true),
  openDocs: (url) => void globalThis.open(url, '_blank', 'noopener'),
};

export const paletteProviders: readonly PaletteProvider[] = [
  commandProvider({
    registry: commandRegistry,
    getKeymap: () => keymapStore.get().keymap,
    // The palette is itself a dialog; its commands run against the editor behind it.
    getContext: getBaseContext,
    onRun: (command, ok) => {
      if (!ok) {
        const title = command.title[localeStore.get()];
        notify('error', t('cmd.failed', { title, reason: t('cmd.unavailable') }));
      }
    },
  }),
  settingsProvider(settingsStore, () => localeStore.get()),
  wallsProvider(deps),
  wallItemsProvider(deps),
  bankProvider(deps),
  ...historyProviders(deps),
  docsProvider(deps, (text) => notify('info', text[localeStore.get()])),
  gotoProvider(deps),
];
