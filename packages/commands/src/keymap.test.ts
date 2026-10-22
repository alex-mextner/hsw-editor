import { describe, expect, test } from 'bun:test';
import {
  bindingsOf,
  buildKeymap,
  conflictsWith,
  EMPTY_USER_KEYMAP,
  exportUserKeymap,
  findConflicts,
  importUserKeymap,
  isCustomized,
  parseUserKeymap,
  resetCommandBindings,
  setCommandBindings,
} from './keymap.ts';
import { defineCommand } from './registry.ts';
import { sampleCommands } from './testkit.ts';

const commands = sampleCommands();

function bindingTexts(
  commandId: string,
  platform: 'mac' | 'linux' | 'windows',
  user = EMPTY_USER_KEYMAP,
) {
  return bindingsOf(buildKeymap(commands, user, platform), commandId).map((b) => b.text);
}

describe('default keymap per OS', () => {
  test('a platform entry replaces the shared one', () => {
    expect(bindingTexts('edit.redo', 'mac')).toEqual(['mod+shift+z']);
    expect(bindingTexts('edit.redo', 'windows')).toEqual(['ctrl+y']);
    expect(bindingTexts('edit.redo', 'linux')).toEqual(['mod+shift+z', 'ctrl+y']);
  });

  test('mod resolves to the platform modifier in the identity', () => {
    const mac = bindingsOf(buildKeymap(commands, EMPTY_USER_KEYMAP, 'mac'), 'edit.undo')[0];
    const linux = bindingsOf(buildKeymap(commands, EMPTY_USER_KEYMAP, 'linux'), 'edit.undo')[0];
    expect(mac?.chordId).toBe('meta+z');
    expect(linux?.chordId).toBe('ctrl+z');
  });

  test('the sample defaults have no conflicts on any platform', () => {
    for (const platform of ['mac', 'linux', 'windows'] as const) {
      expect(findConflicts(buildKeymap(commands, EMPTY_USER_KEYMAP, platform))).toEqual([]);
    }
  });

  test('effective when-clause combines the command and the binding', () => {
    const del = bindingsOf(buildKeymap(commands, EMPTY_USER_KEYMAP, 'linux'), 'edit.delete')[0];
    expect(del?.when).toBe('selection');
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.delete', [
      { key: 'x', when: '!dialog' },
    ]);
    const custom = bindingsOf(buildKeymap(commands, user, 'linux'), 'edit.delete')[0];
    expect(custom?.when).toBe('(selection) && (!dialog)');
  });
});

describe('user overrides', () => {
  test('replace all defaults of a command; an empty list unbinds it', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.undo', [{ key: 'mod+u' }]);
    expect(bindingTexts('edit.undo', 'linux', user)).toEqual(['mod+u']);
    const unbound = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.undo', []);
    expect(bindingTexts('edit.undo', 'linux', unbound)).toEqual([]);
    expect(isCustomized(unbound, 'edit.undo')).toBe(true);
  });

  test('per-command reset restores the defaults', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.undo', [{ key: 'mod+u' }]);
    const reset = resetCommandBindings(user, 'edit.undo');
    expect(isCustomized(reset, 'edit.undo')).toBe(false);
    expect(bindingTexts('edit.undo', 'linux', reset)).toEqual(['mod+z']);
    expect(reset).toEqual(EMPTY_USER_KEYMAP);
  });

  test('unparsable user bindings become problems, not bindings', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.undo', [
      { key: 'bogus+' },
      { key: 'mod+u', when: 'a &&' },
    ]);
    const keymap = buildKeymap(commands, user, 'linux');
    expect(bindingsOf(keymap, 'edit.undo')).toEqual([]);
    expect(keymap.problems.map((p) => p.commandId)).toEqual(['edit.undo', 'edit.undo']);
  });

  test('plain typing keys never bypass the input guard', () => {
    const command = defineCommand({
      id: 'x.eager',
      title: { en: 'Eager', ru: 'Рьяный' },
      group: 'app',
      allowInInput: true,
      keybindings: { all: ['g', 'mod+g', 'alt+g', 'mod+alt+g'] },
      mutates: false,
      handler: () => undefined,
    });
    const keymap = buildKeymap([command], EMPTY_USER_KEYMAP, 'linux');
    const flags = keymap.bindings.map((b) => [b.text, b.allowInInput]);
    expect(flags).toEqual([
      ['g', false],
      ['mod+g', true],
      ['alt+g', false],
      ['mod+alt+g', false],
    ]);
  });
});

describe('conflict detection', () => {
  test('same chord on two commands in overlapping contexts is a duplicate', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.redo', [{ key: 'mod+z' }]);
    const conflicts = findConflicts(buildKeymap(commands, user, 'linux'));
    expect(conflicts.map((c) => [c.kind, c.a.commandId, c.b.commandId])).toEqual([
      ['duplicate', 'edit.undo', 'edit.redo'],
    ]);
  });

  test('mutually exclusive when-clauses do not conflict', () => {
    const a = defineCommand({
      id: 'x.a',
      title: { en: 'A', ru: 'А' },
      group: 'app',
      when: 'dialog',
      keybindings: { all: ['mod+j'] },
      mutates: false,
      handler: () => undefined,
    });
    const b = defineCommand({
      id: 'x.b',
      title: { en: 'B', ru: 'Б' },
      group: 'app',
      when: '!dialog',
      keybindings: { all: ['mod+j'] },
      mutates: false,
      handler: () => undefined,
    });
    expect(findConflicts(buildKeymap([a, b], EMPTY_USER_KEYMAP, 'linux'))).toEqual([]);
  });

  test('on mac, ctrl+z and mod+z are different keys; on linux they collide', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.redo', [{ key: 'ctrl+z' }]);
    expect(findConflicts(buildKeymap(commands, user, 'mac'))).toEqual([]);
    expect(findConflicts(buildKeymap(commands, user, 'linux')).length).toBe(1);
  });

  test('a chord prefix shadows the longer chord', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.undo', [{ key: 'mod+e' }]);
    const conflicts = findConflicts(buildKeymap(commands, user, 'linux'));
    const shadow = conflicts.filter((c) => c.kind === 'shadow');
    expect(shadow.map((c) => [c.a.commandId, c.b.commandId].sort())).toEqual([
      ['app.settings', 'edit.undo'],
    ]);
  });

  test('conflictsWith previews a candidate binding for the editor', () => {
    const keymap = buildKeymap(commands, EMPTY_USER_KEYMAP, 'linux');
    const hit = conflictsWith(keymap, commands, { commandId: 'edit.redo', key: 'mod+z' });
    expect(hit.ok && hit.value.map((c) => c.b.commandId)).toEqual(['edit.undo']);
    const clear = conflictsWith(keymap, commands, { commandId: 'edit.redo', key: 'mod+shift+y' });
    expect(clear.ok && clear.value).toEqual([]);
    const own = conflictsWith(keymap, commands, { commandId: 'edit.undo', key: 'mod+z' });
    expect(own.ok && own.value).toEqual([]);
    expect(conflictsWith(keymap, commands, { commandId: 'edit.redo', key: 'nope+' }).ok).toBe(
      false,
    );
    expect(conflictsWith(keymap, commands, { commandId: 'ghost.cmd', key: 'a' }).ok).toBe(false);
  });
});

describe('import and export', () => {
  const known = new Set(commands.map((c) => c.id));

  test('round-trips through JSON', () => {
    const user = setCommandBindings(
      setCommandBindings(EMPTY_USER_KEYMAP, 'edit.undo', [{ key: 'mod+u' }]),
      'app.settings',
      [],
    );
    const imported = importUserKeymap(exportUserKeymap(user), known);
    expect(imported.ok && imported.value.keymap).toEqual(user);
    expect(imported.ok && imported.value.warnings).toEqual([]);
  });

  test('canonicalises keys and drops bad entries with warnings', () => {
    const imported = importUserKeymap(
      JSON.stringify({
        version: 1,
        overrides: {
          'edit.undo': [{ key: 'Shift+Mod+U' }, { key: 'wat+' }],
          'ghost.command': [{ key: 'a' }],
          'edit.redo': [{ key: 'mod+y', when: 'a &&' }],
        },
      }),
      known,
    );
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.keymap.overrides).toEqual({
      'edit.undo': [{ key: 'mod+shift+u' }],
    });
    expect(imported.value.warnings.length).toBe(3);
  });

  test('an explicit empty list stays an unbind; all-invalid entries keep the defaults', () => {
    const imported = importUserKeymap(
      JSON.stringify({
        version: 1,
        overrides: { 'app.settings': [], 'edit.redo': [{ key: 'wat+' }] },
      }),
      known,
    );
    expect(imported.ok && imported.value.keymap.overrides).toEqual({ 'app.settings': [] });
  });

  test('rejects invalid documents', () => {
    expect(importUserKeymap('{nope').ok).toBe(false);
    expect(importUserKeymap('{"version":2,"overrides":{}}').ok).toBe(false);
    expect(parseUserKeymap({ version: 1, overrides: { a: 'x' } }).ok).toBe(false);
    expect(parseUserKeymap(null).ok).toBe(false);
  });
});
