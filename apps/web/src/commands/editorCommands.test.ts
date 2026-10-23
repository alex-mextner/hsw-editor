import { describe, expect, test } from 'bun:test';
import {
  bindingsOf,
  buildKeymap,
  CommandRegistry,
  EMPTY_USER_KEYMAP,
  findConflicts,
  formatChord,
  KeyDispatcher,
  settingCommands,
  SettingsStore,
  type Context,
  type KeyEventLike,
  type Platform,
} from '@hsw-editor/commands';
import { APP_SETTINGS } from './appSettings.ts';
import { createEditorCommands, type EditorActions } from './editorCommands.ts';

const PLATFORMS: readonly Platform[] = ['mac', 'linux', 'windows'];

/** Records every action the commands trigger, by name. */
function recordingActions(): { actions: EditorActions; calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: readonly unknown[]): void => {
      calls.push(args.length === 0 ? name : `${name}(${args.join(',')})`);
    };
  const actions: EditorActions = {
    undo: record('undo'),
    redo: record('redo'),
    deleteSelection: record('delete'),
    duplicateSelection: record('duplicate'),
    rotateSelection: record('rotate'),
    toggleLockSelection: record('lock'),
    selectAll: record('selectAll'),
    deselect: record('deselect'),
    copySelection: record('copy'),
    pasteClipboard: record('paste'),
    nudge: record('nudge'),
    selectTool: record('selectTool'),
    toggleMeasure: record('measure'),
    toggleSnap: record('snap'),
    fitView: record('fit'),
    toggleViewMode: record('viewMode'),
    toggleOverlay: record('overlay'),
    exportPhoto: record('exportPhoto'),
    findPhotoTools: record('findPhotoTools'),
    checkPhysics: record('checkPhysics'),
    calibratePhoto: record('calibratePhoto'),
    togglePhotoVisible: record('togglePhotoVisible'),
    togglePhotoSplit: record('togglePhotoSplit'),
    cleanPhotoBackground: record('cleanPhotoBackground'),
    toggleAutoClean: record('toggleAutoClean'),
    togglePanel: record('panel'),
    focusPanel: record('focusPanel'),
    newWall: record('newWall'),
    toggleTheme: record('theme'),
    toggleLanguage: record('language'),
    openPalette: record('palette'),
    toggleCheatSheet: record('cheatSheet'),
    openKeybindingEditor: record('keybindingEditor'),
    openWall: () => true,
    selectItem: () => true,
    addBankElement: () => 'new-item',
    addToolPreset: () => 'new-item',
    showToolLibrary: () => undefined,
    openToolPhotoWizard: () => undefined,
    searchToolLibrary: () => undefined,
    addLibraryTool: () => 'new-item',
    undoToRevision: async () => 0,
    resetSettings: record('resetSettings'),
  };
  return { actions, calls };
}

const commands = createEditorCommands(recordingActions().actions);
const settings = new SettingsStore(APP_SETTINGS);
const allCommands = [...commands, ...settingCommands(settings)];

describe('editor defaults', () => {
  for (const platform of PLATFORMS) {
    test(`are valid and conflict-free on ${platform}`, () => {
      const keymap = buildKeymap(allCommands, EMPTY_USER_KEYMAP, platform);
      expect(keymap.problems).toEqual([]);
      expect(
        findConflicts(keymap).map((c) => `${c.kind}: ${c.a.commandId} / ${c.b.commandId}`),
      ).toEqual([]);
    });
  }

  test('register together without clashing ids', () => {
    expect(() => new CommandRegistry().register(...allCommands)).not.toThrow();
  });

  test('every command has an English and a Russian title', () => {
    for (const command of allCommands) {
      expect(command.title.en.trim()).not.toBe('');
      expect(command.title.ru.trim()).not.toBe('');
    }
  });

  test('physics.check is a read-only palette command with ru/en titles and physics keywords', async () => {
    const { actions, calls } = recordingActions();
    const registry = new CommandRegistry();
    registry.register(...createEditorCommands(actions));
    const command = registry.get('physics.check');
    expect(command?.title).toEqual({ en: 'Check wall physics', ru: 'Проверить физику стены' });
    expect(command?.mutates).toBe(false);
    expect(command?.keywords).toEqual(expect.arrayContaining(['physics', 'removal', 'физика']));
    expect(bindingsOf(buildKeymap(commands, EMPTY_USER_KEYMAP, 'linux'), 'physics.check')).toEqual(
      [],
    );
    await registry.run('physics.check', undefined, SELECTED);
    expect(calls).toEqual(['checkPhysics']);
  });

  test('keep every shortcut of the old flat list', () => {
    const keymap = buildKeymap(commands, EMPTY_USER_KEYMAP, 'linux');
    const keysOf = (id: string): string[] => bindingsOf(keymap, id).map((b) => b.text);
    expect(keysOf('edit.undo')).toEqual(['mod+z']);
    expect(keysOf('edit.redo')).toEqual(['mod+shift+z', 'ctrl+y']);
    expect(keysOf('edit.delete')).toEqual(['delete', 'backspace']);
    expect(keysOf('edit.duplicate')).toEqual(['mod+d']);
    expect(keysOf('edit.rotate')).toEqual(['r']);
    expect(keysOf('edit.rotateBack')).toEqual(['shift+r']);
    expect(keysOf('edit.lock')).toEqual(['l']);
    expect(keysOf('edit.selectAll')).toEqual(['mod+a']);
    expect(keysOf('edit.deselect')).toEqual(['escape']);
    expect(keysOf('edit.copy')).toEqual(['mod+c']);
    expect(keysOf('edit.paste')).toEqual(['mod+v']);
    expect(keysOf('edit.nudgeLeft')).toEqual(['left']);
    expect(keysOf('tool.select')).toEqual(['v']);
    expect(keysOf('tool.measure')).toEqual(['m']);
    expect(keysOf('tool.snap')).toEqual(['s']);
    expect(keysOf('view.fit')).toEqual(['f']);
    expect(keysOf('view.toggle')).toEqual(['o']);
    expect(keysOf('view.overlay')).toEqual(['p']);
    expect(keysOf('panel.bank')).toEqual(['b']);
    expect(keysOf('panel.inspector')).toEqual(['i']);
    expect(keysOf('panel.omp')).toEqual(['a']);
    expect(keysOf('panel.history')).toEqual(['h']);
    expect(keysOf('app.palette')).toEqual(['mod+shift+p', 'mod+k']);
    expect(keysOf('help.cheatsheet')).toEqual(['shift+/']);
    expect(keysOf('app.keybindings')).toEqual(['g k']);
    expect(keysOf('panel.focus.bank')).toEqual(['g b']);
  });

  test('only the palette keys work inside a text field', () => {
    const keymap = buildKeymap(commands, EMPTY_USER_KEYMAP, 'linux');
    const inInput = keymap.bindings.filter((b) => b.allowInInput).map((b) => b.commandId);
    expect(new Set(inInput)).toEqual(new Set(['app.palette']));
  });

  test('nudging repeats while the key is held, nothing else does', () => {
    const keymap = buildKeymap(commands, EMPTY_USER_KEYMAP, 'linux');
    const repeating = new Set(keymap.bindings.filter((b) => b.repeat).map((b) => b.commandId));
    expect(repeating).toEqual(
      new Set(['edit.nudgeLeft', 'edit.nudgeRight', 'edit.nudgeUp', 'edit.nudgeDown']),
    );
  });

  test('are shown per platform', () => {
    const mac = buildKeymap(commands, EMPTY_USER_KEYMAP, 'mac');
    const undo = bindingsOf(mac, 'edit.undo')[0];
    expect(undo === undefined ? '' : formatChord(undo.chord, 'mac')).toContain('Z');
    expect(undo?.chordId).toContain('meta');
  });
});

function key(code: string, init: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    key: code.replace(/^Key/, '').toLowerCase(),
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  };
}

/** Real dispatcher over the real defaults: what pressing a key does in a given context. */
function press(
  events: readonly KeyEventLike[],
  context: Context,
  options: { platform?: Platform; typing?: boolean } = {},
): string[] {
  const { actions, calls } = recordingActions();
  const registry = new CommandRegistry();
  registry.register(...createEditorCommands(actions));
  const keymap = buildKeymap(registry.all(), EMPTY_USER_KEYMAP, options.platform ?? 'linux');
  const dispatcher = new KeyDispatcher({
    getKeymap: () => keymap,
    getContext: () => context,
    onRun: (binding) => void registry.run(binding.commandId, undefined, context),
  });
  for (const event of events) dispatcher.handleKeyDown(event, options.typing === true);
  return calls;
}

const SELECTED: Context = {
  selection: true,
  hasWall: true,
  canUndo: true,
  canRedo: true,
  dialog: false,
};

describe('copy, paste and escape', () => {
  const key = (code: string, extra: Partial<KeyEventLike> = {}): KeyEventLike => ({
    key: code.slice(3).toLowerCase(),
    code,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });

  test('Ctrl+C copies the selection but leaves a text copy alone', () => {
    expect(press([key('KeyC')], SELECTED)).toEqual(['copy']);
    expect(press([key('KeyC')], { ...SELECTED, textSelection: true })).toEqual([]);
    expect(press([key('KeyC')], { ...SELECTED, selection: false })).toEqual([]);
  });

  test('Ctrl+V pastes only when something was copied on an open wall', () => {
    expect(press([key('KeyV')], { ...SELECTED, clipboard: true })).toEqual(['paste']);
    expect(press([key('KeyV')], SELECTED)).toEqual([]);
  });

  test('Escape also cancels a picked placement point', () => {
    const escape = { key: 'Escape', code: 'Escape', ctrlKey: false };
    expect(
      press([key('Escape', escape)], { ...SELECTED, selection: false, placeAt: true }),
    ).toEqual(['deselect']);
    expect(press([key('Escape', escape)], { ...SELECTED, selection: false })).toEqual([]);
  });
});

describe('editor shortcuts through the dispatcher', () => {
  test('a selection key works, also on the Russian layout', () => {
    expect(press([key('KeyR', { key: 'к' })], SELECTED)).toEqual(['rotate(1)']);
    expect(press([key('KeyR', { shiftKey: true })], SELECTED)).toEqual(['rotate(-1)']);
  });

  test('keys needing a selection are quiet without one', () => {
    expect(press([key('KeyR')], { ...SELECTED, selection: false })).toEqual([]);
    expect(press([key('Delete')], { ...SELECTED, selection: false })).toEqual([]);
  });

  test('undo uses Cmd on macOS and Ctrl elsewhere, and needs something to undo', () => {
    expect(press([key('KeyZ', { metaKey: true })], SELECTED, { platform: 'mac' })).toEqual([
      'undo',
    ]);
    expect(press([key('KeyZ', { ctrlKey: true })], SELECTED)).toEqual(['undo']);
    expect(press([key('KeyZ', { ctrlKey: true })], { ...SELECTED, canUndo: false })).toEqual([]);
  });

  test('redo answers to both Ctrl+Shift+Z and Ctrl+Y', () => {
    expect(press([key('KeyZ', { ctrlKey: true, shiftKey: true })], SELECTED)).toEqual(['redo']);
    expect(press([key('KeyY', { ctrlKey: true })], SELECTED)).toEqual(['redo']);
  });

  test('typing in a field and open dialogs swallow single-key shortcuts', () => {
    expect(press([key('KeyR')], SELECTED, { typing: true })).toEqual([]);
    expect(press([key('Delete')], SELECTED, { typing: true })).toEqual([]);
    expect(press([key('KeyR')], { ...SELECTED, dialog: true })).toEqual([]);
  });

  test('the palette keys still open it from a text field', () => {
    expect(press([key('KeyK', { ctrlKey: true })], SELECTED, { typing: true })).toEqual([
      'palette',
    ]);
    expect(
      press([key('KeyP', { ctrlKey: true, shiftKey: true })], SELECTED, { typing: true }),
    ).toEqual(['palette']);
  });

  test('? opens the cheat-sheet, even over another dialog', () => {
    const slash = key('Slash', { key: '?', shiftKey: true });
    expect(press([slash], SELECTED)).toEqual(['cheatSheet']);
    expect(press([slash], { ...SELECTED, dialog: true })).toEqual(['cheatSheet']);
  });

  test('the chord g b focuses the bank, a wrong second key cancels it', () => {
    expect(press([key('KeyG'), key('KeyB')], SELECTED)).toEqual(['focusPanel(bank)']);
    expect(press([key('KeyG'), key('KeyX'), key('KeyB')], SELECTED)).toEqual(['panel(bank)']);
  });

  test('arrows nudge and repeat while held', () => {
    const held = key('ArrowLeft', { repeat: true });
    expect(press([key('ArrowLeft'), held, held], SELECTED)).toEqual([
      'nudge(-1,0)',
      'nudge(-1,0)',
      'nudge(-1,0)',
    ]);
  });
});
