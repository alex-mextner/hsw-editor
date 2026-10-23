import { newWallDialogStore } from '@/features/wizard/NewWallDialog.tsx';
import { localeStore } from '@/i18n/index.ts';
import { editorStore, fitView, patchEditor, setSelection, setTool } from '@/state/editor.ts';
import { togglePanel } from '@/state/layout.ts';
import { toggleTheme } from '@/state/theme.ts';
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  nudgeSelection,
  pasteClipboard,
  rotateSelection,
  selectAll,
  toggleLockSelection,
} from '@/wall/actions.ts';
import { clipboardStore } from '@/wall/clipboard.ts';
import { redoEdit, sessionStore, undoEdit } from '@/wall/session.ts';
import { paletteOpenStore, registerCommands, type Command } from './registry.ts';

const hasWall = (): boolean => sessionStore.get()?.wall != null;
const canUndo = (): boolean => sessionStore.get()?.canUndo === true;
const canRedo = (): boolean => sessionStore.get()?.canRedo === true;
const hasSelection = (): boolean => editorStore.get().selection.length > 0;
/** Ctrl+C with text selected somewhere (agent transcript, inspector) is a text copy, not a wall copy. */
const hasTextSelection = (): boolean => (globalThis.getSelection?.()?.toString() ?? '') !== '';

const COMMANDS: readonly Command[] = [
  {
    id: 'edit.undo',
    label: 'action.undo',
    group: 'edit',
    shortcut: 'Ctrl+Z',
    keys: ['mod+z'],
    enabled: canUndo,
    run: undoEdit,
  },
  {
    id: 'edit.redo',
    label: 'action.redo',
    group: 'edit',
    shortcut: 'Ctrl+Shift+Z',
    keys: ['mod+shift+z', 'mod+y'],
    enabled: canRedo,
    run: redoEdit,
  },
  {
    id: 'edit.delete',
    label: 'action.delete',
    group: 'edit',
    shortcut: 'Del',
    keys: ['delete', 'backspace'],
    enabled: hasSelection,
    run: deleteSelection,
  },
  {
    id: 'edit.duplicate',
    label: 'action.duplicate',
    group: 'edit',
    shortcut: 'Ctrl+D',
    keys: ['mod+d'],
    enabled: hasSelection,
    run: duplicateSelection,
  },
  {
    id: 'edit.rotate',
    label: 'action.rotateRight',
    group: 'edit',
    shortcut: 'R',
    keys: ['r'],
    enabled: hasSelection,
    run: () => rotateSelection(1),
  },
  {
    id: 'edit.rotateBack',
    label: 'action.rotateLeft',
    group: 'edit',
    shortcut: 'Shift+R',
    keys: ['shift+r'],
    enabled: hasSelection,
    run: () => rotateSelection(-1),
  },
  {
    id: 'edit.lock',
    label: 'action.lockToggle',
    group: 'edit',
    shortcut: 'L',
    keys: ['l'],
    enabled: hasSelection,
    run: toggleLockSelection,
  },
  {
    id: 'edit.copy',
    label: 'context.copy',
    group: 'edit',
    shortcut: 'Ctrl+C',
    keys: ['mod+c'],
    enabled: () => hasSelection() && !hasTextSelection(),
    run: copySelection,
  },
  {
    id: 'edit.paste',
    label: 'action.paste',
    group: 'edit',
    shortcut: 'Ctrl+V',
    keys: ['mod+v'],
    enabled: () => hasWall() && clipboardStore.get().length > 0,
    run: () => void pasteClipboard(),
  },
  {
    id: 'edit.selectAll',
    label: 'action.selectAll',
    group: 'edit',
    shortcut: 'Ctrl+A',
    keys: ['mod+a'],
    enabled: hasWall,
    run: selectAll,
  },
  {
    id: 'edit.deselect',
    label: 'action.deselect',
    group: 'edit',
    shortcut: 'Esc',
    keys: ['escape'],
    enabled: () => hasSelection() || editorStore.get().placeAt !== null,
    run: () => {
      setSelection([]);
      patchEditor({ placeAt: null });
    },
  },
  {
    id: 'edit.nudgeLeft',
    label: 'action.nudgeLeft',
    group: 'edit',
    keys: ['arrowleft'],
    enabled: hasSelection,
    run: () => nudgeSelection(-2, 0),
  },
  {
    id: 'edit.nudgeRight',
    label: 'action.nudgeRight',
    group: 'edit',
    keys: ['arrowright'],
    enabled: hasSelection,
    run: () => nudgeSelection(2, 0),
  },
  {
    id: 'edit.nudgeUp',
    label: 'action.nudgeUp',
    group: 'edit',
    keys: ['arrowup'],
    enabled: hasSelection,
    run: () => nudgeSelection(0, 2),
  },
  {
    id: 'edit.nudgeDown',
    label: 'action.nudgeDown',
    group: 'edit',
    keys: ['arrowdown'],
    enabled: hasSelection,
    run: () => nudgeSelection(0, -2),
  },

  {
    id: 'tool.select',
    label: 'tool.select',
    group: 'tools',
    shortcut: 'V',
    keys: ['v'],
    run: () => setTool('select'),
  },
  {
    id: 'tool.measure',
    label: 'tool.measure',
    group: 'tools',
    shortcut: 'M',
    keys: ['m'],
    run: () => setTool(editorStore.get().tool === 'measure' ? 'select' : 'measure'),
  },
  {
    id: 'tool.snap',
    label: 'tool.snap',
    group: 'tools',
    shortcut: 'S',
    keys: ['s'],
    run: () => patchEditor({ snap: !editorStore.get().snap }),
  },

  { id: 'view.fit', label: 'view.fit', group: 'view', shortcut: 'F', keys: ['f'], run: fitView },
  {
    id: 'view.toggle',
    label: 'view.toggle',
    group: 'view',
    shortcut: 'O',
    keys: ['o'],
    run: () => patchEditor({ view: editorStore.get().view === 'front' ? 'perspective' : 'front' }),
  },
  {
    id: 'view.overlay',
    label: 'overlay.toggle',
    group: 'view',
    shortcut: 'P',
    keys: ['p'],
    enabled: hasWall,
    run: toggleOverlay,
  },
  {
    id: 'panel.bank',
    label: 'panel.bank',
    group: 'view',
    shortcut: 'B',
    keys: ['b'],
    run: () => togglePanel('leftOpen'),
  },
  {
    id: 'panel.inspector',
    label: 'panel.inspector',
    group: 'view',
    shortcut: 'I',
    keys: ['i'],
    run: () => togglePanel('rightOpen'),
  },
  {
    id: 'panel.omp',
    label: 'panel.omp',
    group: 'view',
    shortcut: 'A',
    keys: ['a'],
    run: () => togglePanel('ompOpen'),
  },
  {
    id: 'panel.history',
    label: 'panel.history',
    group: 'view',
    shortcut: 'H',
    keys: ['h'],
    run: () => togglePanel('bottomOpen'),
  },

  { id: 'wall.new', label: 'wall.new', group: 'wall', run: () => newWallDialogStore.set(true) },
  { id: 'app.theme', label: 'theme.toggle', group: 'app', run: toggleTheme },
  {
    id: 'app.language',
    label: 'language.toggle',
    group: 'app',
    run: () => localeStore.set(localeStore.get() === 'ru' ? 'en' : 'ru'),
  },
  {
    id: 'app.palette',
    label: 'palette.title',
    group: 'app',
    shortcut: 'Ctrl+K',
    run: () => paletteOpenStore.set(true),
  },
];

function toggleOverlay(): void {
  const photos = sessionStore.get()?.wall?.photos ?? [];
  const first = photos[0];
  if (!first) return;
  const { overlay } = editorStore.get();
  patchEditor({ overlay: { ...overlay, photoId: overlay.photoId === null ? first.id : null } });
}

/** Registers the editor's commands (shortcuts + palette entries); returns the unregister function. */
export function registerEditorCommands(): () => void {
  return registerCommands(COMMANDS);
}
