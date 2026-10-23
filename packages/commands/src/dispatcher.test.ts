import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_CHORD_TIMEOUT_MS,
  IDLE_CHORD,
  KeyDispatcher,
  type PendingChord,
  stepChord,
} from './dispatcher.ts';
import {
  type Binding,
  buildKeymap,
  EMPTY_USER_KEYMAP,
  type Keymap,
  setCommandBindings,
  type UserKeymap,
} from './keymap.ts';
import type { Platform } from './keys.ts';
import type { Context } from './when.ts';
import { keyEvent, type KeyOptions, sampleCommands } from './testkit.ts';
import { type Command, defineCommand } from './registry.ts';

interface Harness {
  readonly dispatcher: KeyDispatcher;
  readonly ran: string[];
  readonly pending: (PendingChord | null)[];
  context: Context;
  time: number;
  advance(ms: number): void;
  press(code: string, options?: KeyOptions, typing?: boolean): boolean;
}

function harness(
  platform: Platform = 'linux',
  user: UserKeymap = EMPTY_USER_KEYMAP,
  commands: readonly Command[] = sampleCommands(),
): Harness {
  const keymap: Keymap = buildKeymap(commands, user, platform);
  const timers: { at: number; callback: () => void; live: boolean }[] = [];
  const state: Harness = {
    ran: [],
    pending: [],
    context: {},
    time: 1_000,
    advance(ms) {
      state.time += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= state.time) {
          timer.live = false;
          timer.callback();
        }
      }
    },
    press(code, options, typing = false) {
      return state.dispatcher.handleKeyDown(keyEvent(code, options), typing).consumed;
    },
    dispatcher: new KeyDispatcher({
      getKeymap: () => keymap,
      getContext: () => state.context,
      onRun: (binding: Binding) => {
        state.ran.push(binding.commandId);
      },
      now: () => state.time,
      setTimer: (callback, ms) => {
        const timer = { at: state.time + ms, callback, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    }),
  };
  state.dispatcher.subscribe((pending) => state.pending.push(pending));
  return state;
}

describe('single strokes', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  test('runs the bound command and consumes the key', () => {
    expect(h.press('KeyZ', { ctrl: true })).toBe(true);
    expect(h.ran).toEqual(['edit.undo']);
  });

  test('works on the Russian layout through physical key codes', () => {
    expect(h.press('KeyZ', { ctrl: true, key: 'я' })).toBe(true);
    expect(h.ran).toEqual(['edit.undo']);
  });

  test('unbound keys pass through untouched', () => {
    expect(h.press('KeyQ')).toBe(false);
    expect(h.press('KeyZ')).toBe(false);
    expect(h.ran).toEqual([]);
  });

  test('when-clauses gate the binding', () => {
    expect(h.press('Delete')).toBe(false);
    h.context = { selection: true };
    expect(h.press('Delete')).toBe(true);
    expect(h.ran).toEqual(['edit.delete']);
    h.context = { selection: true, dialog: true };
    expect(h.press('KeyR')).toBe(false);
  });

  test('holding a key does not repeat a command unless it asks to', () => {
    expect(h.press('KeyG', { repeat: true })).toBe(true);
    expect(h.ran).toEqual([]);
    h.press('KeyG');
    expect(h.ran).toEqual(['view.toggleGrid']);
  });

  test('Cmd on mac, Ctrl elsewhere', () => {
    const mac = harness('mac');
    expect(mac.press('KeyZ', { ctrl: true })).toBe(false);
    expect(mac.press('KeyZ', { meta: true })).toBe(true);
    expect(mac.ran).toEqual(['edit.undo']);
  });

  test('? opens the cheat-sheet from any layout', () => {
    expect(h.press('Slash', { key: '?', shift: true })).toBe(true);
    expect(h.press('Digit7', { key: '?', shift: true })).toBe(true);
    expect(h.ran).toEqual(['app.cheatsheet', 'app.cheatsheet']);
  });
});

describe('typing targets and IME', () => {
  test('plain keys and ordinary modifier chords are ignored while typing', () => {
    const h = harness();
    expect(h.press('KeyG', {}, true)).toBe(false);
    expect(h.press('KeyZ', { ctrl: true }, true)).toBe(false);
    expect(h.press('Slash', { key: '?', shift: true }, true)).toBe(false);
    expect(h.ran).toEqual([]);
  });

  test('a command marked allowInInput still fires from a text field', () => {
    const h = harness();
    expect(h.press('KeyP', { ctrl: true, shift: true }, true)).toBe(true);
    expect(h.ran).toEqual(['app.palette']);
  });

  test('IME composition keystrokes are never handled', () => {
    const h = harness();
    expect(h.press('KeyZ', { ctrl: true, isComposing: true })).toBe(false);
    expect(h.press('KeyG', { keyCode: 229 })).toBe(false);
    expect(h.press('KeyG', { key: 'Process' })).toBe(false);
    expect(h.ran).toEqual([]);
  });
});

describe('chords', () => {
  test('a single stroke that is also a palette binding fires at once', () => {
    const h = harness();
    expect(h.press('KeyK', { ctrl: true })).toBe(true);
    expect(h.ran).toEqual(['app.palette']);
  });

  test('Ctrl+E then Ctrl+S waits after the first stroke and completes on the second', () => {
    const h = harness();
    expect(h.press('KeyE', { ctrl: true })).toBe(true);
    expect(h.ran).toEqual([]);
    expect(h.dispatcher.pendingChord?.typed).toEqual(['ctrl+e']);
    expect(h.dispatcher.pendingChord?.candidates.map((b) => b.commandId)).toEqual(['app.settings']);
    expect(h.press('KeyS', { ctrl: true })).toBe(true);
    expect(h.ran).toEqual(['app.settings']);
    expect(h.dispatcher.pendingChord).toBeNull();
  });

  test('chords are per-OS: Cmd on mac', () => {
    const h = harness('mac');
    expect(h.press('KeyE', { ctrl: true })).toBe(false);
    expect(h.press('KeyE', { meta: true })).toBe(true);
    expect(h.press('KeyS', { meta: true })).toBe(true);
    expect(h.ran).toEqual(['app.settings']);
  });

  test('holding the first key of a chord does not break it', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    expect(h.press('KeyE', { ctrl: true, repeat: true })).toBe(true);
    expect(h.press('KeyE', { ctrl: true, repeat: true })).toBe(true);
    expect(h.dispatcher.pendingChord?.typed).toEqual(['ctrl+e']);
    h.press('KeyS', { ctrl: true });
    expect(h.ran).toEqual(['app.settings']);
  });

  test('holding the last key of a completed chord does not leak repeats to the browser', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    h.press('KeyS', { ctrl: true });
    expect(h.press('KeyS', { ctrl: true, repeat: true })).toBe(true);
    expect(h.press('KeyS', { ctrl: true, repeat: true })).toBe(true);
    expect(h.ran).toEqual(['app.settings']);
    h.press('KeyG');
    expect(h.press('KeyS', { ctrl: true, repeat: true })).toBe(false);
  });

  test('repeats of the wrong key that broke a chord are swallowed too', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    expect(h.press('KeyX')).toBe(true);
    expect(h.press('KeyX', { repeat: true })).toBe(true);
  });

  test('a wrong second key aborts the chord and is swallowed', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    expect(h.press('KeyX')).toBe(true);
    expect(h.ran).toEqual([]);
    expect(h.dispatcher.pendingChord).toBeNull();
    expect(h.press('KeyG')).toBe(true);
    expect(h.ran).toEqual(['view.toggleGrid']);
  });

  test('Escape cancels a pending chord', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    expect(h.press('Escape', { key: 'Escape' })).toBe(true);
    expect(h.dispatcher.pendingChord).toBeNull();
    expect(h.ran).toEqual([]);
  });

  test('a pending chord times out and the next key is handled fresh', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    h.advance(DEFAULT_CHORD_TIMEOUT_MS + 10);
    expect(h.dispatcher.pendingChord).toBeNull();
    expect(h.pending.at(-1)).toBeNull();
    expect(h.press('KeyS', { ctrl: true })).toBe(false);
    expect(h.ran).toEqual([]);
  });

  test('state expires even without the timer when the clock moves on', () => {
    const keymap = buildKeymap(sampleCommands(), EMPTY_USER_KEYMAP, 'linux');
    const input = { escape: false, typing: false, context: {}, timeoutMs: 1000 };
    const first = stepChord(keymap, IDLE_CHORD, { ...input, strokeId: 'ctrl+e', now: 100 });
    expect(first.result.kind).toBe('pending');
    const late = stepChord(keymap, first.state, { ...input, strokeId: 'ctrl+s', now: 2000 });
    expect(late.result.kind).toBe('pass');
    const inTime = stepChord(keymap, first.state, { ...input, strokeId: 'ctrl+s', now: 900 });
    expect(inTime.result.kind).toBe('run');
  });

  test('the input guard applies where a chord starts', () => {
    const h = harness();
    expect(h.press('KeyE', { ctrl: true }, true)).toBe(false);
    expect(h.dispatcher.pendingChord).toBeNull();
  });

  test('IME keys do not break a chord in progress', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    h.press('KeyG', { isComposing: true });
    expect(h.dispatcher.pendingChord).not.toBeNull();
    h.press('KeyS', { ctrl: true });
    expect(h.ran).toEqual(['app.settings']);
  });

  test('a repeat:true command on a multi-stroke chord repeats while its last key is held', () => {
    const h = harness('linux', EMPTY_USER_KEYMAP, [
      defineCommand({
        id: 'edit.nudgeRight',
        title: { en: 'Nudge right', ru: 'Сдвиг вправо' },
        group: 'edit',
        keybindings: { all: ['mod+e mod+n'] },
        repeat: true,
        mutates: true,
        handler: () => undefined,
      }),
    ]);
    h.press('KeyE', { ctrl: true });
    h.press('KeyN', { ctrl: true });
    expect(h.ran).toEqual(['edit.nudgeRight']);
    expect(h.press('KeyN', { ctrl: true, repeat: true })).toBe(true);
    expect(h.press('KeyN', { ctrl: true, repeat: true })).toBe(true);
    expect(h.ran).toEqual(['edit.nudgeRight', 'edit.nudgeRight', 'edit.nudgeRight']);
  });

  describe('repeats of a completed repeat:true chord', () => {
    function nudgeHarness(): Harness {
      const h = harness('linux', EMPTY_USER_KEYMAP, [
        defineCommand({
          id: 'edit.nudgeRight',
          title: { en: 'Nudge right', ru: 'Сдвиг вправо' },
          group: 'edit',
          when: 'selection',
          keybindings: { all: ['mod+e mod+n'] },
          repeat: true,
          mutates: true,
          handler: () => undefined,
        }),
      ]);
      h.context = { selection: true };
      h.press('KeyE', { ctrl: true });
      h.press('KeyN', { ctrl: true });
      return h;
    }

    test('stop running once the when-clause no longer holds, yet stay swallowed', () => {
      const h = nudgeHarness();
      h.context = {};
      expect(h.press('KeyN', { ctrl: true, repeat: true })).toBe(true);
      expect(h.ran).toEqual(['edit.nudgeRight']);
    });

    test('stop running while a text field has focus, yet stay swallowed', () => {
      const h = nudgeHarness();
      expect(h.press('KeyN', { ctrl: true, repeat: true }, true)).toBe(true);
      expect(h.ran).toEqual(['edit.nudgeRight']);
    });

    test('stop repeating after reset() (a dialog opened) but never leak to the browser', () => {
      const h = nudgeHarness();
      h.dispatcher.reset();
      expect(h.press('KeyN', { ctrl: true, repeat: true })).toBe(true);
      expect(h.ran).toEqual(['edit.nudgeRight']);
    });

    test('stop once another key arrives', () => {
      const h = nudgeHarness();
      h.press('KeyA');
      expect(h.press('KeyN', { ctrl: true, repeat: true })).toBe(false);
      expect(h.ran).toEqual(['edit.nudgeRight']);
    });
  });

  test('a reset caused by the chord itself (it opened a dialog) keeps swallowing the held key', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    h.press('KeyS', { ctrl: true });
    h.dispatcher.reset();
    expect(h.press('KeyS', { ctrl: true, repeat: true })).toBe(true);
    expect(h.ran).toEqual(['app.settings']);
  });

  test('a reset while a chord is pending does not let the held first key start it again', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    h.dispatcher.reset();
    expect(h.dispatcher.pendingChord).toBeNull();
    expect(h.press('KeyE', { ctrl: true, repeat: true })).toBe(true);
    expect(h.dispatcher.pendingChord).toBeNull();
    h.press('KeyS', { ctrl: true });
    expect(h.ran).toEqual([]);
  });

  test('holding the first key of a chord past the timeout does not restart the chord', () => {
    const h = harness();
    h.press('KeyE', { ctrl: true });
    h.advance(DEFAULT_CHORD_TIMEOUT_MS + 10);
    expect(h.dispatcher.pendingChord).toBeNull();
    expect(h.press('KeyE', { ctrl: true, repeat: true })).toBe(true);
    expect(h.dispatcher.pendingChord).toBeNull();
    h.press('KeyS', { ctrl: true });
    expect(h.ran).toEqual([]);
    // Pressing the first key again (not a repeat) starts the chord afresh.
    h.press('KeyE', { ctrl: true });
    expect(h.dispatcher.pendingChord?.typed).toEqual(['ctrl+e']);
  });

  test('a later chord stroke bound to Escape completes the chord instead of cancelling it', () => {
    const h = harness('linux', EMPTY_USER_KEYMAP, [
      defineCommand({
        id: 'app.closeAll',
        title: { en: 'Close all', ru: 'Закрыть всё' },
        group: 'app',
        keybindings: { all: ['mod+e escape'] },
        mutates: false,
        handler: () => undefined,
      }),
    ]);
    h.press('KeyE', { ctrl: true });
    expect(h.press('Escape', { key: 'Escape' })).toBe(true);
    expect(h.ran).toEqual(['app.closeAll']);
    expect(h.dispatcher.pendingChord).toBeNull();
  });
});

describe('precedence', () => {
  test('a user binding beats a default on the same key', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.redo', [{ key: 'mod+z' }]);
    const h = harness('linux', user);
    h.press('KeyZ', { ctrl: true });
    expect(h.ran).toEqual(['edit.redo']);
  });

  test('a prefix command wins over the longer chord it shadows', () => {
    const user = setCommandBindings(EMPTY_USER_KEYMAP, 'edit.undo', [{ key: 'mod+e' }]);
    const h = harness('linux', user);
    h.press('KeyE', { ctrl: true });
    expect(h.dispatcher.pendingChord).toBeNull();
    h.press('KeyS', { ctrl: true });
    expect(h.ran).toEqual(['edit.undo']);
  });
});
