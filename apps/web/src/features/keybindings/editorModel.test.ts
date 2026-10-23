import { describe, expect, test } from 'bun:test';
import {
  buildKeymap,
  type Command,
  defineCommand,
  EMPTY_USER_KEYMAP,
  type KeyEventLike,
  type Platform,
  type UserKeymap,
} from '@hsw-editor/commands';
import {
  addBinding,
  buildRows,
  checkCandidate,
  conflictsByCommand,
  groupRows,
  IDLE_RECORDING,
  candidateOf,
  previewImport,
  problemList,
  recordingStep,
  type RecordingState,
  removeBinding,
  searchRows,
  summariseConflicts,
} from './editorModel.ts';

const noop = (): undefined => undefined;

const COMMANDS: readonly Command[] = [
  defineCommand({
    id: 'edit.undo',
    title: { en: 'Undo', ru: 'Отменить' },
    keywords: ['revert', 'отмена'],
    group: 'edit',
    keybindings: { all: ['mod+z'] },
    mutates: true,
    handler: noop,
  }),
  defineCommand({
    id: 'edit.redo',
    title: { en: 'Redo', ru: 'Повторить' },
    group: 'edit',
    keybindings: { all: ['mod+shift+z'], windows: ['ctrl+y'] },
    mutates: true,
    handler: noop,
  }),
  defineCommand({
    id: 'view.toggleGrid',
    title: { en: 'Toggle grid', ru: 'Показать или скрыть сетку' },
    keywords: ['honeycomb', 'сетка'],
    group: 'view',
    keybindings: { all: ['g'] },
    mutates: false,
    handler: noop,
  }),
  defineCommand({
    id: 'help.chordA',
    title: { en: 'Chord A', ru: 'Цепочка А' },
    group: 'help',
    keybindings: { all: ['mod+k mod+s'] },
    mutates: false,
    handler: noop,
  }),
  defineCommand({
    id: 'app.save',
    title: { en: 'Save', ru: 'Сохранить' },
    group: 'app',
    mutates: false,
    handler: noop,
  }),
];

function setup(user: UserKeymap = EMPTY_USER_KEYMAP, platform: Platform = 'linux') {
  const keymap = buildKeymap(COMMANDS, user, platform);
  return { keymap, rows: buildRows(COMMANDS, keymap, user, 'en') };
}

function key(init: Partial<KeyEventLike> & Pick<KeyEventLike, 'code'>): KeyEventLike {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  };
}

function record(events: readonly KeyEventLike[], platform: Platform = 'linux') {
  let state: RecordingState = IDLE_RECORDING;
  let action = 'ignore';
  for (const event of events) {
    const step = recordingStep(state, event, platform);
    state = step.state;
    action = step.action;
  }
  return { state, action };
}

function textOf(state: RecordingState): string | null {
  const candidate = candidateOf(state, '', 'linux');
  return candidate?.ok === true ? candidate.text : null;
}

function labelOf(state: RecordingState, platform: Platform): string | undefined {
  const candidate = candidateOf(state, '', platform);
  return candidate?.ok === true ? candidate.label : undefined;
}

function typedOf(input: string) {
  return candidateOf(IDLE_RECORDING, input, 'linux');
}

describe('rows', () => {
  test('are ordered by group then title and carry platform labels', () => {
    const { rows } = setup();
    expect(rows.map((row) => row.id)).toEqual([
      'edit.redo',
      'edit.undo',
      'view.toggleGrid',
      'help.chordA',
      'app.save',
    ]);
    const undo = rows.find((row) => row.id === 'edit.undo');
    expect(undo?.bindings).toEqual([{ text: 'mod+z', label: 'Ctrl+Z' }]);
    const mac = buildRows(
      COMMANDS,
      buildKeymap(COMMANDS, EMPTY_USER_KEYMAP, 'mac'),
      EMPTY_USER_KEYMAP,
      'en',
    );
    expect(mac.find((row) => row.id === 'edit.undo')?.bindings[0]?.label).toBe('⌘Z');
  });

  test('titles follow the locale', () => {
    const keymap = buildKeymap(COMMANDS, EMPTY_USER_KEYMAP, 'linux');
    const ru = buildRows(COMMANDS, keymap, EMPTY_USER_KEYMAP, 'ru');
    expect(ru.find((row) => row.id === 'edit.undo')?.title).toBe('Отменить');
  });

  test('uses the per-platform default and marks overrides as customised', () => {
    const win = setup(EMPTY_USER_KEYMAP, 'windows');
    expect(win.rows.find((row) => row.id === 'edit.redo')?.bindings[0]?.text).toBe('ctrl+y');
    const user: UserKeymap = { version: 1, overrides: { 'edit.undo': [{ key: 'mod+u' }] } };
    const custom = setup(user);
    const undo = custom.rows.find((row) => row.id === 'edit.undo');
    expect(undo?.customised).toBe(true);
    expect(undo?.bindings[0]?.text).toBe('mod+u');
    expect(undo?.defaults[0]?.text).toBe('mod+z');
    expect(custom.rows.find((row) => row.id === 'edit.redo')?.customised).toBe(false);
  });

  test('an explicit unbind leaves the row with no bindings but customised', () => {
    const user: UserKeymap = { version: 1, overrides: { 'view.toggleGrid': [] } };
    const row = setup(user).rows.find((entry) => entry.id === 'view.toggleGrid');
    expect(row?.bindings).toEqual([]);
    expect(row?.customised).toBe(true);
  });

  test('groupRows splits consecutive rows by group', () => {
    const groups = groupRows(setup().rows);
    expect(groups.map((entry) => [entry.group, entry.rows.length])).toEqual([
      ['edit', 2],
      ['view', 1],
      ['help', 1],
      ['app', 1],
    ]);
  });
});

describe('conflicts', () => {
  const clash: UserKeymap = {
    version: 1,
    overrides: { 'view.toggleGrid': [{ key: 'mod+z' }] },
  };

  test('a duplicate chord is reported on both commands with the other title', () => {
    const { keymap } = setup(clash);
    const byCommand = conflictsByCommand(keymap, COMMANDS, 'en');
    expect(byCommand.get('edit.undo')).toEqual([
      {
        kind: 'duplicate',
        otherId: 'view.toggleGrid',
        otherTitle: 'Toggle grid',
        ownText: 'mod+z',
      },
    ]);
    expect(byCommand.get('view.toggleGrid')?.[0]?.otherTitle).toBe('Undo');
    expect(summariseConflicts(keymap).count).toBe(1);
    expect(summariseConflicts(keymap).commandIds).toEqual(
      new Set(['edit.undo', 'view.toggleGrid']),
    );
  });

  test('a chord prefix shadows a longer chord', () => {
    const user: UserKeymap = { version: 1, overrides: { 'view.toggleGrid': [{ key: 'mod+k' }] } };
    const { rows } = setup(user);
    const chord = rows.find((row) => row.id === 'help.chordA');
    expect(chord?.conflicts[0]?.kind).toBe('shadow');
    expect(chord?.conflicts[0]?.otherTitle).toBe('Toggle grid');
  });

  test('the shipped defaults of the fixture have none', () => {
    expect(summariseConflicts(setup().keymap).count).toBe(0);
  });

  test('checkCandidate previews a clash before saving and ignores the own command', () => {
    const { keymap } = setup();
    const clashing = checkCandidate(keymap, COMMANDS, 'view.toggleGrid', 'mod+z', 'ru');
    expect(clashing).toEqual({
      ok: true,
      conflicts: [{ kind: 'duplicate', otherId: 'edit.undo', otherTitle: 'Отменить' }],
    });
    const own = checkCandidate(keymap, COMMANDS, 'edit.undo', 'mod+z', 'en');
    expect(own).toEqual({ ok: true, conflicts: [] });
    const shadow = checkCandidate(keymap, COMMANDS, 'view.toggleGrid', 'mod+k', 'en');
    expect(shadow.ok && shadow.conflicts[0]?.kind).toBe('shadow');
  });

  test('checkCandidate reports an unparsable key', () => {
    const result = checkCandidate(setup().keymap, COMMANDS, 'edit.undo', 'mod+nope', 'en');
    expect(result.ok).toBe(false);
  });

  test('invalid user bindings surface as keymap problems', () => {
    const user: UserKeymap = {
      version: 1,
      overrides: { 'edit.undo': [{ key: 'mod+nope' }], 'edit.redo': [{ key: '??' }] },
    };
    const { keymap } = setup(user);
    expect(keymap.problems.length).toBe(2);
    expect(problemList(keymap.problems)).toBe('edit.undo: mod+nope, edit.redo: ??');
    expect(problemList(keymap.problems, 1)).toBe('edit.undo: mod+nope, …');
  });
});

describe('recording', () => {
  test('Ctrl+K then Ctrl+S records a portable chord and Enter saves it', () => {
    const first = key({ key: 'k', code: 'KeyK', ctrlKey: true });
    const second = key({ key: 's', code: 'KeyS', ctrlKey: true });
    const { state } = record([first, second]);
    expect(textOf(state)).toBe('mod+k mod+s');
    expect(labelOf(state, 'linux')).toBe('Ctrl+K Ctrl+S');
    expect(labelOf(state, 'mac')).toBe('⌘K ⌘S');
    const saved = record([first, second, key({ key: 'Enter', code: 'Enter' })]);
    expect(saved.action).toBe('save');
    expect(textOf(saved.state)).toBe('mod+k mod+s');
  });
  test('on macOS Cmd becomes mod', () => {
    const { state } = record([key({ key: 'k', code: 'KeyK', metaKey: true })], 'mac');
    expect(textOf(state)).toBe('mod+k');
  });

  test('Cyrillic layout records the physical key, not the typed letter', () => {
    const { state } = record([key({ key: 'я', code: 'KeyZ', ctrlKey: true, shiftKey: true })]);
    expect(textOf(state)).toBe('mod+shift+z');
  });

  test('? is recorded as shift+/ on any layout', () => {
    const { state } = record([key({ key: '?', code: 'Digit7', shiftKey: true })]);
    expect(textOf(state)).toBe('shift+/');
  });

  test('Escape cancels and clears the recording', () => {
    const result = record([
      key({ key: 'k', code: 'KeyK', ctrlKey: true }),
      key({ key: 'Escape', code: 'Escape' }),
    ]);
    expect(result.action).toBe('cancel');
    expect(result.state).toEqual(IDLE_RECORDING);
  });

  test('modifier-only presses, IME and auto-repeat are ignored', () => {
    expect(record([key({ key: 'Control', code: 'ControlLeft', ctrlKey: true })]).action).toBe(
      'ignore',
    );
    expect(record([key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })]).state).toEqual(
      IDLE_RECORDING,
    );
    expect(
      record([key({ key: 'к', code: 'KeyK', ctrlKey: true, isComposing: true })]).state,
    ).toEqual(IDLE_RECORDING);
    expect(record([key({ key: 'k', code: 'KeyK', ctrlKey: true, repeat: true })]).state).toEqual(
      IDLE_RECORDING,
    );
  });

  test('bare Tab and Shift+Tab are left for focus navigation, Ctrl+Tab is recorded', () => {
    expect(record([key({ key: 'Tab', code: 'Tab' })]).action).toBe('ignore');
    expect(record([key({ key: 'Tab', code: 'Tab', shiftKey: true })]).action).toBe('ignore');
    expect(textOf(record([key({ key: 'Tab', code: 'Tab', ctrlKey: true })]).state)).toBe('mod+tab');
  });

  test('Enter with nothing recorded is left alone', () => {
    expect(record([key({ key: 'Enter', code: 'Enter' })]).action).toBe('ignore');
  });

  test('a chord takes at most four strokes; extra strokes are swallowed', () => {
    const stroke = key({ key: 'a', code: 'KeyA', ctrlKey: true });
    const result = record([stroke, stroke, stroke, stroke, stroke]);
    expect(result.state.strokes.length).toBe(4);
    expect(result.action).toBe('consume');
  });

  test('Ctrl+Cmd stays literal on macOS instead of producing an invalid mod+ctrl', () => {
    const { state } = record(
      [key({ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true })],
      'mac',
    );
    expect(textOf(state)).toBe('ctrl+meta+k');
  });

  test('typed chords (phone fallback) are canonicalised or rejected', () => {
    expect(typedOf(' Mod+K  mod+S ')).toEqual({
      ok: true,
      text: 'mod+k mod+s',
      label: 'Ctrl+K Ctrl+S',
    });
    expect(typedOf('cmd+shift+p')).toMatchObject({ ok: true, text: 'shift+meta+p' });
    expect(typedOf('mod+ctrl+k')?.ok).toBe(false);
    expect(typedOf('')).toBeNull();
    const recorded = record([key({ key: 'k', code: 'KeyK', ctrlKey: true })]).state;
    expect(candidateOf(recorded, '', 'linux')).toMatchObject({ text: 'mod+k' });
    expect(candidateOf(recorded, 'mod+j', 'linux')).toMatchObject({ text: 'mod+j' });
    expect(typedOf('a b c d e')?.ok).toBe(false);
  });
});

describe('edits', () => {
  const platform: Platform = 'linux';
  const undo = COMMANDS[0] as Command;

  test('adding keeps the defaults and the row becomes customised', () => {
    const next = addBinding(EMPTY_USER_KEYMAP, undo, platform, 'mod+u');
    expect(next.overrides['edit.undo']).toEqual([{ key: 'mod+z' }, { key: 'mod+u' }]);
  });

  test('adding an existing key changes nothing', () => {
    expect(addBinding(EMPTY_USER_KEYMAP, undo, platform, 'mod+z')).toBe(EMPTY_USER_KEYMAP);
  });

  test('adding the same physical key spelled differently changes nothing', () => {
    expect(addBinding(EMPTY_USER_KEYMAP, undo, platform, 'ctrl+z')).toBe(EMPTY_USER_KEYMAP);
    expect(addBinding(EMPTY_USER_KEYMAP, undo, 'mac', 'mod+z')).toBe(EMPTY_USER_KEYMAP);
  });

  test('removing the last binding stores an explicit unbind', () => {
    const next = removeBinding(EMPTY_USER_KEYMAP, undo, platform, 'mod+z');
    expect(next.overrides['edit.undo']).toEqual([]);
  });

  test('returning to the defaults drops the override', () => {
    const added = addBinding(EMPTY_USER_KEYMAP, undo, platform, 'mod+u');
    const back = removeBinding(added, undo, platform, 'mod+u');
    expect(back.overrides).toEqual({});
  });

  test('windows redo uses its platform default as the base of an edit', () => {
    const redo = COMMANDS[1] as Command;
    const next = addBinding(EMPTY_USER_KEYMAP, redo, 'windows', 'mod+r');
    expect(next.overrides['edit.redo']).toEqual([{ key: 'ctrl+y' }, { key: 'mod+r' }]);
  });

  test('keeps a when-clause of an existing user entry', () => {
    const user: UserKeymap = {
      version: 1,
      overrides: { 'edit.undo': [{ key: 'mod+u', when: 'selection' }] },
    };
    const next = addBinding(user, undo, platform, 'mod+i');
    expect(next.overrides['edit.undo']).toEqual([
      { key: 'mod+u', when: 'selection' },
      { key: 'mod+i' },
    ]);
  });
});

describe('import', () => {
  test('counts overrides and reports skipped entries as warnings', () => {
    const text = JSON.stringify({
      version: 1,
      overrides: {
        'edit.undo': [{ key: 'ctrl+u' }],
        'nope.unknown': [{ key: 'a' }],
        'edit.redo': [{ key: 'mod+nope' }],
      },
    });
    const result = previewImport(text, COMMANDS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overrideCount).toBe(1);
    expect(result.keymap.overrides['edit.undo']).toEqual([{ key: 'ctrl+u', when: undefined }]);
    expect(result.warnings.length).toBe(2);
  });

  test('rejects invalid JSON and wrong shapes', () => {
    expect(previewImport('{oops', COMMANDS).ok).toBe(false);
    expect(previewImport('{"version":2,"overrides":{}}', COMMANDS).ok).toBe(false);
  });
});

describe('search', () => {
  const { rows } = setup();
  const ids = (query: string) => searchRows(rows, COMMANDS, query).map((row) => row.id);

  test('empty query keeps every row in order', () => {
    expect(ids('')).toEqual(rows.map((row) => row.id));
  });

  test('Russian keyword "отмена" finds Undo first', () => {
    expect(ids('отмена')[0]).toBe('edit.undo');
  });

  test('English title and wrong-layout typing work', () => {
    expect(ids('undo')[0]).toBe('edit.undo');
    expect(ids('гтвщ')[0]).toBe('edit.undo');
  });

  test('searching by shortcut text', () => {
    expect(ids('ctrl+shift+z')).toContain('edit.redo');
  });

  test('a query without matches yields nothing', () => {
    expect(ids('qqqqqqzzzz')).toEqual([]);
  });
});
