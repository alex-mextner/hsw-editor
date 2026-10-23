import { describe, expect, test } from 'bun:test';
import {
  buildKeymap,
  type Command,
  defineCommand,
  EMPTY_USER_KEYMAP,
  type PendingChord,
  setCommandBindings,
} from '@hsw-editor/commands';
import { buildCheatSheet, pendingChordView } from './cheatSheetModel.ts';

const noop = (): undefined => undefined;

const COMMANDS: readonly Command[] = [
  defineCommand({
    id: 'edit.undo',
    title: { en: 'Undo', ru: 'Отменить' },
    keywords: ['отмена'],
    group: 'edit',
    keybindings: { all: ['mod+z'] },
    mutates: true,
    handler: noop,
  }),
  defineCommand({
    id: 'edit.delete',
    title: { en: 'Delete selection', ru: 'Удалить выбранное' },
    group: 'edit',
    when: 'selection',
    keybindings: { all: ['delete', 'backspace'] },
    mutates: true,
    handler: noop,
  }),
  defineCommand({
    id: 'view.toggleGrid',
    title: { en: 'Toggle grid', ru: 'Сетка' },
    group: 'view',
    keybindings: { all: ['g'] },
    mutates: false,
    handler: noop,
  }),
  defineCommand({
    id: 'app.noKey',
    title: { en: 'No key', ru: 'Без клавиши' },
    group: 'app',
    mutates: false,
    handler: noop,
  }),
  defineCommand({
    id: 'help.keys',
    title: { en: 'Keyboard shortcuts', ru: 'Горячие клавиши' },
    group: 'help',
    keybindings: { all: ['mod+k mod+s', 'shift+/'] },
    mutates: false,
    handler: noop,
  }),
  defineCommand({
    id: 'help.docs',
    title: { en: 'Open docs', ru: 'Открыть справку' },
    group: 'help',
    keybindings: { all: ['mod+k mod+d'] },
    mutates: false,
    handler: noop,
  }),
];

const keymap = buildKeymap(COMMANDS, EMPTY_USER_KEYMAP, 'linux');
const available = COMMANDS.filter((command) => command.id !== 'edit.delete');

describe('cheat-sheet', () => {
  test('a binding whose own when-clause is false is not listed', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'help.docs', [
      { key: 'mod+u', when: 'selection' },
    ]);
    const custom = buildKeymap(COMMANDS, user, 'linux');
    const docs = (selection: boolean) =>
      buildCheatSheet(available, custom, 'en', '', { selection })
        .flatMap((group) => group.entries)
        .some((entry) => entry.id === 'help.docs');
    expect(docs(false)).toBe(false);
    expect(docs(true)).toBe(true);
  });

  test('lists only available commands that have a binding, grouped in registry order', () => {
    const groups = buildCheatSheet(available, keymap, 'en', '', {});
    expect(groups.map((group) => group.group)).toEqual(['edit', 'view', 'help']);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.id))).not.toContain(
      'edit.delete',
    );
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.id))).not.toContain(
      'app.noKey',
    );
  });

  test('shows every binding of a command formatted for the platform', () => {
    const help = buildCheatSheet(available, keymap, 'en', '', {}).find((g) => g.group === 'help');
    const keys = help?.entries.find((entry) => entry.id === 'help.keys');
    expect(keys?.labels).toEqual(['Ctrl+K Ctrl+S', 'Shift+/']);
    const mac = buildKeymap(COMMANDS, EMPTY_USER_KEYMAP, 'mac');
    const macEntry = buildCheatSheet(available, mac, 'en', '', {})
      .flatMap((group) => group.entries)
      .find((entry) => entry.id === 'edit.undo');
    expect(macEntry?.labels).toEqual(['⌘Z']);
  });

  test('filters in both languages and by key', () => {
    const ids = (filter: string, locale: 'en' | 'ru' = 'en') =>
      buildCheatSheet(available, keymap, locale, filter, {}).flatMap((group) =>
        group.entries.map((entry) => entry.id),
      );
    expect(ids('отмена')).toEqual(['edit.undo']);
    expect(ids('grid')).toContain('view.toggleGrid');
    expect(ids('grid')).not.toContain('edit.undo');
    expect(ids('ctrl z')).toContain('edit.undo');
    expect(ids('qqqqzzzz')).toEqual([]);
  });

  test('titles follow the locale', () => {
    const entry = buildCheatSheet(available, keymap, 'ru', '', {})
      .flatMap((group) => group.entries)
      .find((candidate) => candidate.id === 'edit.undo');
    expect(entry?.title).toBe('Отменить');
  });
});

describe('pending chord hint', () => {
  const pending: PendingChord = {
    typed: ['ctrl+k'],
    candidates: keymap.bindings.filter((binding) => binding.chord.length === 2),
  };

  test('shows what was typed and what each next key does', () => {
    const view = pendingChordView(pending, COMMANDS, 'linux', 'en');
    expect(view.typed).toBe('Ctrl+K');
    expect(view.options).toEqual([
      { next: 'Ctrl+S', title: 'Keyboard shortcuts' },
      { next: 'Ctrl+D', title: 'Open docs' },
    ]);
  });

  test('uses the localised titles and mac glyphs', () => {
    const mac = buildKeymap(COMMANDS, EMPTY_USER_KEYMAP, 'mac');
    const view = pendingChordView(
      {
        typed: ['meta+k'],
        candidates: mac.bindings.filter((binding) => binding.chord.length === 2),
      },
      COMMANDS,
      'mac',
      'ru',
    );
    expect(view.typed).toBe('⌘K');
    expect(view.options[0]).toEqual({ next: '⌘S', title: 'Горячие клавиши' });
  });
});
