import { describe, expect, test } from 'bun:test';
import {
  chordId,
  chordText,
  detectPlatform,
  eventStrokeId,
  formatChord,
  formatStroke,
  isImeEvent,
  parseChord,
  parseStroke,
  recordStroke,
  strokeId,
  strokeText,
} from './keys.ts';
import { keyEvent } from './testkit.ts';

function stroke(text: string) {
  const parsed = parseStroke(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe('platform detection', () => {
  test('mac, iOS, windows and linux', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(
      detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }),
    ).toBe('mac');
    expect(detectPlatform({ platform: 'Win32' })).toBe('windows');
    expect(detectPlatform({ platform: 'Linux x86_64', userAgent: 'X11; Linux x86_64' })).toBe(
      'linux',
    );
    expect(detectPlatform({})).toBe('linux');
  });
});

describe('stroke and chord parsing', () => {
  test('normalises aliases and modifier order', () => {
    expect(strokeText(stroke('Shift+Mod+P'))).toBe('mod+shift+p');
    expect(strokeText(stroke('cmd+option+del'))).toBe('alt+meta+delete');
    expect(strokeText(stroke('control+esc'))).toBe('ctrl+escape');
    expect(strokeText(stroke('shift+/'))).toBe('shift+/');
    expect(strokeText(stroke('f12'))).toBe('f12');
  });

  test('rejects malformed strokes', () => {
    for (const bad of [
      '',
      'mod+',
      '+k',
      'mod+shift',
      'a+b',
      'mod+mod+k',
      'mod+ctrl+k',
      'hyper+k',
      'mod+f25',
    ]) {
      expect(parseStroke(bad).ok).toBe(false);
    }
  });

  test('parses chords of up to four strokes', () => {
    const chord = parseChord('mod+k mod+s');
    expect(chord.ok && chordText(chord.value)).toBe('mod+k mod+s');
    expect(parseChord('a b c d').ok).toBe(true);
    expect(parseChord('a b c d e').ok).toBe(false);
    expect(parseChord('').ok).toBe(false);
    expect(parseChord('mod+k bogus').ok).toBe(false);
  });
});

describe('per-OS identity', () => {
  test('mod is Cmd on mac and Ctrl elsewhere', () => {
    expect(strokeId(stroke('mod+z'), 'mac')).toBe('meta+z');
    expect(strokeId(stroke('mod+z'), 'linux')).toBe('ctrl+z');
    expect(strokeId(stroke('mod+z'), 'windows')).toBe('ctrl+z');
  });

  test('explicit ctrl and mod collide on linux but not on mac', () => {
    expect(strokeId(stroke('ctrl+z'), 'linux')).toBe(strokeId(stroke('mod+z'), 'linux'));
    expect(strokeId(stroke('ctrl+z'), 'mac')).not.toBe(strokeId(stroke('mod+z'), 'mac'));
  });

  test('chord id joins resolved strokes', () => {
    const chord = parseChord('mod+k mod+s');
    expect(chord.ok && chordId(chord.value, 'mac')).toBe('meta+k meta+s');
  });
});

describe('key events', () => {
  test('letters are physical: the Russian layout still produces the latin key', () => {
    const russianZ = keyEvent('KeyZ', { key: 'я', ctrl: true });
    expect(eventStrokeId(russianZ, 'linux')).toBe('ctrl+z');
    expect(eventStrokeId(keyEvent('KeyZ', { meta: true }), 'mac')).toBe('meta+z');
  });

  test('digits, arrows, function keys and punctuation', () => {
    expect(eventStrokeId(keyEvent('Digit1', { shift: true, key: '!' }), 'linux')).toBe('shift+1');
    expect(eventStrokeId(keyEvent('ArrowLeft'), 'linux')).toBe('left');
    expect(eventStrokeId(keyEvent('F5'), 'linux')).toBe('f5');
    expect(eventStrokeId(keyEvent('Delete'), 'linux')).toBe('delete');
    expect(eventStrokeId(keyEvent('Slash', { key: '/' }), 'linux')).toBe('/');
  });

  test('? is shift+/ on every layout', () => {
    expect(eventStrokeId(keyEvent('Slash', { key: '?', shift: true }), 'linux')).toBe('shift+/');
    expect(eventStrokeId(keyEvent('Digit7', { key: '?', shift: true }), 'linux')).toBe('shift+/');
  });

  test('modifier-only presses are not strokes', () => {
    expect(
      eventStrokeId(keyEvent('ControlLeft', { key: 'Control', ctrl: true }), 'linux'),
    ).toBeNull();
    expect(
      eventStrokeId(keyEvent('ShiftRight', { key: 'Shift', shift: true }), 'linux'),
    ).toBeNull();
    expect(eventStrokeId(keyEvent('MetaLeft', { key: 'Meta', meta: true }), 'mac')).toBeNull();
  });

  test('IME composition is recognised', () => {
    expect(isImeEvent(keyEvent('KeyA', { isComposing: true }))).toBe(true);
    expect(isImeEvent(keyEvent('KeyA', { keyCode: 229 }))).toBe(true);
    expect(isImeEvent(keyEvent('KeyA', { key: 'Process' }))).toBe(true);
    expect(isImeEvent(keyEvent('KeyA'))).toBe(false);
  });

  test('recording turns Cmd (mac) or Ctrl (elsewhere) into the portable mod', () => {
    const mac = recordStroke(keyEvent('KeyK', { meta: true }), 'mac');
    const linux = recordStroke(keyEvent('KeyK', { ctrl: true }), 'linux');
    expect(mac && strokeText(mac)).toBe('mod+k');
    expect(linux && strokeText(linux)).toBe('mod+k');
    const ctrlOnMac = recordStroke(keyEvent('KeyK', { ctrl: true }), 'mac');
    expect(ctrlOnMac && strokeText(ctrlOnMac)).toBe('ctrl+k');
    const superOnLinux = recordStroke(keyEvent('KeyK', { meta: true }), 'linux');
    expect(superOnLinux && strokeText(superOnLinux)).toBe('meta+k');
  });
});

describe('recorded strokes survive a save', () => {
  test('every recorded combination parses back to the same identity', () => {
    const combos = [
      { ctrl: true, meta: true },
      { ctrl: true },
      { meta: true },
      { alt: true, shift: true },
    ];
    for (const platform of ['mac', 'linux', 'windows'] as const) {
      for (const combo of combos) {
        const recorded = recordStroke(keyEvent('KeyK', combo), platform);
        if (recorded === null) throw new Error('not recorded');
        const reparsed = parseStroke(strokeText(recorded));
        expect(reparsed.ok).toBe(true);
        if (!reparsed.ok) continue;
        expect(strokeId(reparsed.value, platform)).toBe(
          eventStrokeId(keyEvent('KeyK', combo), platform) ?? '',
        );
      }
    }
  });
});

describe('display', () => {
  test('mac uses glyphs, others use words', () => {
    expect(formatStroke(stroke('mod+shift+p'), 'mac')).toBe('⇧⌘P');
    expect(formatStroke(stroke('mod+shift+p'), 'linux')).toBe('Ctrl+Shift+P');
    expect(formatStroke(stroke('alt+delete'), 'windows')).toBe('Alt+Del');
    expect(formatStroke(stroke('meta+k'), 'linux')).toBe('Super+K');
    expect(formatStroke(stroke('meta+k'), 'windows')).toBe('Win+K');
    expect(formatStroke(stroke('shift+/'), 'linux')).toBe('Shift+/');
  });

  test('chords join strokes with a space', () => {
    const chord = parseChord('mod+k mod+s');
    expect(chord.ok && formatChord(chord.value, 'linux')).toBe('Ctrl+K Ctrl+S');
    expect(chord.ok && formatChord(chord.value, 'mac')).toBe('⌘K ⌘S');
  });
});
