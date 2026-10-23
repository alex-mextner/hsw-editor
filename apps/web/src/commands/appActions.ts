/** The real `EditorActions`: wires the registry's handlers to the editor's stores and wall actions. */
import { api } from '@/api/http.ts';
import {
  calibrateShownPhoto,
  exportPhotoPng,
  findPhotoTools,
  togglePhotoHidden,
  togglePhotoMode,
  toggleSplit,
} from '@/features/photo/photoActions.ts';
import { checkPhysics } from '@/features/physics/checkPhysics.ts';
import { seatPhysics } from '@/features/physics/seatPhysics.ts';
import { bankStore } from '@/bank/client.ts';
import { newWallDialogStore } from '@/features/wizard/NewWallDialog.tsx';
import type { HistoryEntry } from '@hsw-editor/core';
import { localeStore, t } from '@/i18n/index.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { editorStore, fitView, patchEditor, setSelection, setTool } from '@/state/editor.ts';
import { leftTabStore } from '@/features/palette/leftTab.ts';
import { addLibraryToolById } from '@/features/tools/actions.ts';
import { closeToolDetail, openPhotoWizard, patchToolsQuery } from '@/features/tools/store.ts';
import { layoutStore, togglePanel, type LayoutState } from '@/state/layout.ts';
import { toggleTheme } from '@/state/theme.ts';
import {
  addElementToWall,
  addToolPreset,
  copySelection,
  currentWall,
  deleteSelection,
  duplicateSelection,
  nudgeSelection,
  pasteClipboard,
  rotateSelection,
  selectAll,
  toggleLockSelection,
} from '@/wall/actions.ts';
import { redoEdit, sessionStore, undoEdit, wallListStore } from '@/wall/session.ts';
import type { EditorActions, PanelKey } from './editorCommands.ts';
import { planUndoTo, UNDO_WINDOW, windowStart } from './historyUndo.ts';

/** What the actions need from the composition root (which owns the palette and dialog stores). */
export interface AppActionDeps {
  readonly openPalette: (initialInput?: string) => void;
  readonly toggleCheatSheet: () => void;
  readonly openKeybindingEditor: () => void;
  readonly nudgeStep: () => number;
  readonly resetSettings: () => void;
}

export const PANEL_LAYOUT_KEY: Readonly<Record<PanelKey, keyof LayoutState>> = {
  bank: 'leftOpen',
  inspector: 'rightOpen',
  history: 'bottomOpen',
  agent: 'ompOpen',
};

/** `data-slot` of the shell region each panel lives in. */
const PANEL_SLOT: Readonly<Record<PanelKey, string>> = {
  bank: 'palette',
  inspector: 'inspector',
  history: 'timeline',
  agent: 'omp-dock',
};

const FOCUSABLE = 'input, button, [href], select, textarea, [tabindex]:not([tabindex="-1"])';

function focusPanelContents(panel: PanelKey): void {
  // After the panel has rendered open; a hidden panel cannot take focus.
  globalThis.requestAnimationFrame(() => {
    const region = globalThis.document?.querySelector<HTMLElement>(
      `[data-slot="${PANEL_SLOT[panel]}"]`,
    );
    region?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  });
}

/** The newest slice of a wall's history, ending at its current revision. */
export function loadUndoWindow(wallId: string, currentRev: number): Promise<HistoryEntry[]> {
  // A little past the window, so edits that landed after `currentRev` are part of the replay too.
  return api.history(wallId, windowStart(currentRev), UNDO_WINDOW + 200);
}

/**
 * Undoes edits until the wall is at revision `rev`. The step count comes from the server's history
 * and only holds while nothing else is in flight, so it refuses while this tab has unconfirmed
 * edits and when the wall moved while the history was loading.
 */
export async function undoToRevision(rev: number): Promise<number> {
  const before = sessionStore.get();
  if (before === null) throw new Error(t('cmd.needsWall'));
  const entries = await loadUndoWindow(before.wallId, before.confirmedRev);
  const now = sessionStore.get();
  if (now?.wallId !== before.wallId || now.confirmedRev !== before.confirmedRev) {
    throw new Error(t('cmd.undoToMoved'));
  }
  const plan = planUndoTo(entries, rev, now.pending);
  if (!plan.ok) {
    throw new Error(t(plan.reason === 'pending' ? 'cmd.undoToPending' : 'cmd.undoToUnreachable'));
  }
  // Each undo is queued in the sync pipeline and sent in order.
  for (let step = 0; step < plan.steps; step += 1) undoEdit();
  return plan.steps;
}

export function createAppActions(deps: AppActionDeps): EditorActions {
  return {
    undo: undoEdit,
    redo: redoEdit,
    deleteSelection,
    duplicateSelection,
    rotateSelection,
    toggleLockSelection,
    selectAll,
    deselect: () => {
      setSelection([]);
      patchEditor({ placeAt: null });
    },
    copySelection,
    pasteClipboard: () => void pasteClipboard(),
    nudge: (dx, dy) => {
      const step = deps.nudgeStep();
      nudgeSelection(dx * step, dy * step);
    },
    selectTool: () => setTool('select'),
    toggleMeasure: () => setTool(editorStore.get().tool === 'measure' ? 'select' : 'measure'),
    toggleSnap: () => patchEditor({ snap: !editorStore.get().snap }),
    fitView,
    toggleViewMode: () =>
      patchEditor({ view: editorStore.get().view === 'front' ? 'perspective' : 'front' }),
    toggleOverlay: togglePhotoMode,
    exportPhoto: () => void exportPhotoPng(),
    findPhotoTools: () => void findPhotoTools(),
    checkPhysics: () => {
      // The report list lives in the wall view of the inspector: no selection, panel open.
      setSelection([]);
      layoutStore.set({ ...layoutStore.get(), [PANEL_LAYOUT_KEY.inspector]: true });
      void checkPhysics();
    },
    seatPhysics: () => void seatPhysics(),
    calibratePhoto: calibrateShownPhoto,
    togglePhotoVisible: togglePhotoHidden,
    togglePhotoSplit: toggleSplit,
    togglePanel: (panel) => togglePanel(PANEL_LAYOUT_KEY[panel]),
    focusPanel: (panel) => {
      layoutStore.set({ ...layoutStore.get(), [PANEL_LAYOUT_KEY[panel]]: true });
      focusPanelContents(panel);
    },
    newWall: () => newWallDialogStore.set(true),
    toggleTheme,
    toggleLanguage: () => localeStore.set(localeStore.get() === 'ru' ? 'en' : 'ru'),
    openPalette: deps.openPalette,
    toggleCheatSheet: deps.toggleCheatSheet,
    openKeybindingEditor: deps.openKeybindingEditor,
    openWall: (id) => {
      if (!wallListStore.get().walls.some((wall) => wall.id === id)) return false;
      currentWallId.set(id);
      return true;
    },
    selectItem: (id) => {
      if (!currentWall()?.items.some((item) => item.id === id)) return false;
      setSelection([id]);
      fitView();
      return true;
    },
    addBankElement: (id) => {
      const bank = bankStore.get();
      const element = bank.status === 'ready' ? bank.byId.get(id) : undefined;
      return element === undefined ? null : addElementToWall(element);
    },
    addToolPreset: (toolClassId) => {
      const bank = bankStore.get();
      const toolClass =
        bank.status === 'ready'
          ? bank.index.toolClasses.find((candidate) => candidate.id === toolClassId)
          : undefined;
      return toolClass === undefined
        ? null
        : addToolPreset(toolClass, toolClass.name[localeStore.get()]);
    },
    showToolLibrary: () => {
      layoutStore.set({ ...layoutStore.get(), leftOpen: true });
      leftTabStore.set('tools');
      closeToolDetail();
      focusPanelContents('bank');
    },
    openToolPhotoWizard: () => {
      layoutStore.set({ ...layoutStore.get(), leftOpen: true });
      leftTabStore.set('tools');
      closeToolDetail();
      openPhotoWizard();
    },
    searchToolLibrary: (query) => {
      layoutStore.set({ ...layoutStore.get(), leftOpen: true });
      leftTabStore.set('tools');
      closeToolDetail();
      patchToolsQuery({ text: query });
    },
    addLibraryTool: (id) => addLibraryToolById(id, localeStore.get()),
    undoToRevision,
    resetSettings: deps.resetSettings,
  };
}
