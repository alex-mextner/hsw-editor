/**
 * Key strokes and chords.
 *
 * A binding is written portably: `mod+shift+p` (mod = Cmd on macOS and iOS, Ctrl elsewhere) or a
 * chord of up to {@link MAX_CHORD_LENGTH} strokes separated by spaces: `mod+k mod+s`. Key names are
 * physical (`KeyboardEvent.code`), so letter shortcuts also work on the Russian layout.
 *
 * The module is DOM-free: browsers feed it {@link KeyEventLike}.
 */

export type Platform = 'mac' | 'windows' | 'linux';

export const MAX_CHORD_LENGTH = 4;

export interface PlatformInfo {
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** iPhone and iPad keyboards use Cmd, so they follow the macOS conventions. */
export function detectPlatform(info: PlatformInfo): Platform {
  const text = `${info.platform ?? ''} ${info.userAgent ?? ''}`.toLowerCase();
  if (/mac|iphone|ipad|ipod|ios/.test(text)) return 'mac';
  if (/win/.test(text)) return 'windows';
  return 'linux';
}

/** A stroke as written by the user: `mod` is portable, `ctrl` and `meta` are literal. */
export interface Stroke {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string;
}

export type Chord = readonly Stroke[];

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** The subset of `KeyboardEvent` the dispatcher needs. */
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean | undefined;
  readonly keyCode?: number | undefined;
  readonly repeat?: boolean | undefined;
}

const CODE_KEYS: Readonly<Record<string, string>> = {
  Enter: 'enter',
  NumpadEnter: 'enter',
  Escape: 'escape',
  Space: 'space',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'escape',
  return: 'enter',
  del: 'delete',
  ins: 'insert',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  pgup: 'pageup',
  pgdn: 'pagedown',
  spacebar: 'space',
  ' ': 'space',
};

const MODIFIER_ALIASES: Readonly<Record<string, keyof Omit<Stroke, 'key'>>> = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
};

const NAMED_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(CODE_KEYS),
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

function isValidKeyName(key: string): boolean {
  return /^[a-z0-9]$/.test(key) || NAMED_KEYS.has(key);
}

export function parseStroke(text: string): ParseResult<Stroke> {
  const parts = text
    .trim()
    .split('+')
    .map((part) => part.trim().toLowerCase());
  // A literal `+` key is not expressible; `shift+=` is the portable spelling.
  if (parts.some((part) => part === '')) return { ok: false, error: `malformed stroke '${text}'` };
  const flags = { mod: false, ctrl: false, meta: false, alt: false, shift: false };
  let key: string | undefined;
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier !== undefined) {
      if (flags[modifier]) return { ok: false, error: `duplicate modifier '${part}'` };
      flags[modifier] = true;
      continue;
    }
    if (key !== undefined) return { ok: false, error: `more than one key in '${text}'` };
    key = KEY_ALIASES[part] ?? part;
  }
  if (key === undefined) return { ok: false, error: `no key in '${text}'` };
  if (!isValidKeyName(key)) return { ok: false, error: `unknown key '${key}'` };
  if (flags.mod && (flags.ctrl || flags.meta)) {
    return { ok: false, error: `'mod' cannot be combined with ctrl or meta in '${text}'` };
  }
  return { ok: true, value: { ...flags, key } };
}

export function parseChord(text: string): ParseResult<Chord> {
  const parts = text.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return { ok: false, error: 'empty key binding' };
  if (parts.length > MAX_CHORD_LENGTH) {
    return { ok: false, error: `a chord has at most ${MAX_CHORD_LENGTH} strokes` };
  }
  const strokes: Stroke[] = [];
  for (const part of parts) {
    const stroke = parseStroke(part);
    if (!stroke.ok) return stroke;
    strokes.push(stroke.value);
  }
  return { ok: true, value: strokes };
}

/** Canonical portable text of a stroke, stable for storage and comparison within one platform. */
export function strokeText(stroke: Stroke): string {
  const parts: string[] = [];
  if (stroke.mod) parts.push('mod');
  if (stroke.ctrl) parts.push('ctrl');
  if (stroke.alt) parts.push('alt');
  if (stroke.shift) parts.push('shift');
  if (stroke.meta) parts.push('meta');
  parts.push(stroke.key);
  return parts.join('+');
}

export function chordText(chord: Chord): string {
  return chord.map(strokeText).join(' ');
}

/**
 * Identity of a stroke on a platform: `mod` collapses into ctrl or meta, so `mod+z` and
 * `ctrl+z` are the same on Linux but different on macOS.
 */
export function strokeId(stroke: Stroke, platform: Platform): string {
  const mac = platform === 'mac';
  return strokeText({
    mod: false,
    ctrl: stroke.ctrl || (stroke.mod && !mac),
    meta: stroke.meta || (stroke.mod && mac),
    alt: stroke.alt,
    shift: stroke.shift,
    key: stroke.key,
  });
}

export function chordId(chord: Chord, platform: Platform): string {
  return chord.map((stroke) => strokeId(stroke, platform)).join(' ');
}

function keyFromEvent(event: KeyEventLike): { key: string; shift: boolean } | null {
  const { code } = event;
  // `?` is the same character on every layout; the physical key under it differs (Shift+7 on RU).
  if (event.key === '?') return { key: '/', shift: true };
  if (/^Key[A-Z]$/.test(code)) return { key: code.slice(3).toLowerCase(), shift: event.shiftKey };
  if (/^Digit\d$/.test(code)) return { key: code.slice(5), shift: event.shiftKey };
  if (/^Numpad\d$/.test(code)) return { key: code.slice(6), shift: event.shiftKey };
  if (/^F\d{1,2}$/.test(code)) return { key: code.toLowerCase(), shift: event.shiftKey };
  const named = CODE_KEYS[code];
  if (named !== undefined) return { key: named, shift: event.shiftKey };
  if (/^(Control|Shift|Alt|Meta|AltGraph|OS|Fn)(Left|Right)?$/.test(code)) return null;
  if (code === '') {
    const key = KEY_ALIASES[event.key.toLowerCase()] ?? event.key.toLowerCase();
    return isValidKeyName(key) ? { key, shift: event.shiftKey } : null;
  }
  return null;
}

/** The literal stroke a key event represents, without any `mod` collapsing. */
export function eventStroke(event: KeyEventLike): Stroke | null {
  const resolved = keyFromEvent(event);
  if (resolved === null) return null;
  return {
    mod: false,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: resolved.shift,
    key: resolved.key,
  };
}

/** Identity of the key event, comparable with {@link strokeId}. */
export function eventStrokeId(event: KeyEventLike, platform: Platform): string | null {
  const stroke = eventStroke(event);
  return stroke === null ? null : strokeId(stroke, platform);
}

/** Portable stroke recorded by the keybinding editor: Cmd on mac and Ctrl elsewhere become `mod`. */
export function recordStroke(event: KeyEventLike, platform: Platform): Stroke | null {
  const stroke = eventStroke(event);
  if (stroke === null) return null;
  // `mod` cannot be combined with the literal modifier it stands for, so Ctrl+Cmd (mac) or
  // Ctrl+Super (elsewhere) stays literal instead of producing an unparsable `mod+ctrl+k`.
  if (stroke.ctrl && stroke.meta) return stroke;
  return platform === 'mac'
    ? { ...stroke, mod: stroke.meta, meta: false }
    : { ...stroke, mod: stroke.ctrl, ctrl: false };
}

export function isImeEvent(event: KeyEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229 || event.key === 'Process';
}

/**
 * True when the stroke cannot be produced by typing text. Alt is excluded: Option types characters
 * on macOS and AltGr arrives as Ctrl+Alt on Windows layouts that have accented letters.
 */
export function isInputSafeStroke(stroke: Stroke): boolean {
  return (stroke.mod || stroke.ctrl || stroke.meta) && !stroke.alt;
}

// ---- Display ------------------------------------------------------------------------------------

const MAC_GLYPHS: Readonly<Record<string, string>> = {
  enter: '↩',
  escape: '⎋',
  space: '␣',
  tab: '⇥',
  backspace: '⌫',
  delete: '⌦',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

const OTHER_LABELS: Readonly<Record<string, string>> = {
  enter: 'Enter',
  escape: 'Esc',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Del',
  insert: 'Ins',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

function keyLabel(key: string, platform: Platform): string {
  if (platform === 'mac') {
    const glyph = MAC_GLYPHS[key];
    if (glyph !== undefined) return glyph;
  }
  return OTHER_LABELS[key] ?? key.toUpperCase();
}

/** Parts of a stroke in display order, for rendering one keycap each. */
export function strokeParts(stroke: Stroke, platform: Platform): readonly string[] {
  const mac = platform === 'mac';
  const resolved = {
    ctrl: stroke.ctrl || (stroke.mod && !mac),
    meta: stroke.meta || (stroke.mod && mac),
  };
  const parts: string[] = [];
  if (resolved.ctrl) parts.push(mac ? '⌃' : 'Ctrl');
  if (stroke.alt) parts.push(mac ? '⌥' : 'Alt');
  if (stroke.shift) parts.push(mac ? '⇧' : 'Shift');
  if (resolved.meta) parts.push(mac ? '⌘' : platform === 'windows' ? 'Win' : 'Super');
  parts.push(keyLabel(stroke.key, platform));
  return parts;
}

export function formatStroke(stroke: Stroke, platform: Platform): string {
  return strokeParts(stroke, platform).join(platform === 'mac' ? '' : '+');
}

export function formatChord(chord: Chord, platform: Platform): string {
  return chord.map((stroke) => formatStroke(stroke, platform)).join(' ');
}
