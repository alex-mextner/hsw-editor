/**
 * Pure model behind the keybinding editor: rows per command, conflict lookup, search, the key
 * recording state machine and the user-keymap edits. React only renders what this returns.
 */
import {
  type BindingOverride,
  type Command,
  type CommandGroup,
  COMMAND_GROUPS,
  chordId,
  chordText,
  compileQuery,
  conflictsWith,
  type ConflictKind,
  defaultKeysFor,
  findConflicts,
  formatChord,
  importUserKeymap,
  isImeEvent,
  type KeyEventLike,
  type Keymap,
  type KeymapProblem,
  type Locale,
  labelText,
  MAX_CHORD_LENGTH,
  matchQuery,
  parseChord,
  type Platform,
  recordStroke,
  resetCommandBindings,
  type SearchField,
  setCommandBindings,
  type Stroke,
  type UserKeymap,
} from '@hsw-editor/commands';

const GROUP_ORDER: readonly CommandGroup[] = Object.keys(COMMAND_GROUPS) as CommandGroup[];

// ---- Rows -----------------------------------------------------------------------------------

export interface RowBinding {
  /** Canonical portable text, as stored in the user keymap. */
  readonly text: string;
  /** Platform-specific display text (`Ctrl+K Ctrl+S`, `⌘K ⌘S`). */
  readonly label: string;
}

export interface RowConflict {
  readonly kind: ConflictKind;
  readonly otherId: string;
  readonly otherTitle: string;
  /** The chord of the command this row belongs to that collides. */
  readonly ownText: string;
}

export interface EditorRow {
  readonly id: string;
  readonly title: string;
  readonly group: CommandGroup;
  readonly bindings: readonly RowBinding[];
  readonly defaults: readonly RowBinding[];
  readonly customised: boolean;
  readonly conflicts: readonly RowConflict[];
}

function bindingOf(text: string, platform: Platform): RowBinding | null {
  const parsed = parseChord(text);
  if (!parsed.ok) return null;
  return { text: chordText(parsed.value), label: formatChord(parsed.value, platform) };
}

function toBindings(texts: readonly string[], platform: Platform): readonly RowBinding[] {
  const out: RowBinding[] = [];
  for (const text of texts) {
    const binding = bindingOf(text, platform);
    if (binding !== null) out.push(binding);
  }
  return out;
}

export function defaultKeyTexts(command: Command, platform: Platform): readonly string[] {
  return toBindings(defaultKeysFor(command.keybindings, platform), platform).map(
    (binding) => binding.text,
  );
}

/** Conflicts of the whole keymap, indexed by command id and seen from that command's side. */
export function conflictsByCommand(
  keymap: Keymap,
  commands: readonly Command[],
  locale: Locale,
): ReadonlyMap<string, readonly RowConflict[]> {
  const titles = new Map(commands.map((command) => [command.id, labelText(command.title, locale)]));
  const byCommand = new Map<string, RowConflict[]>();
  const push = (id: string, conflict: RowConflict): void => {
    const list = byCommand.get(id);
    if (list === undefined) byCommand.set(id, [conflict]);
    else list.push(conflict);
  };
  for (const { kind, a, b } of findConflicts(keymap)) {
    push(a.commandId, {
      kind,
      otherId: b.commandId,
      otherTitle: titles.get(b.commandId) ?? b.commandId,
      ownText: a.text,
    });
    push(b.commandId, {
      kind,
      otherId: a.commandId,
      otherTitle: titles.get(a.commandId) ?? a.commandId,
      ownText: b.text,
    });
  }
  return byCommand;
}

/** Rows ordered by group (registry order of the groups), then by title in the active language. */
export function buildRows(
  commands: readonly Command[],
  keymap: Keymap,
  user: UserKeymap,
  locale: Locale,
): readonly EditorRow[] {
  const conflicts = conflictsByCommand(keymap, commands, locale);
  const rows = commands.map<EditorRow>((command) => {
    const current: string[] = [];
    for (const binding of keymap.bindings) {
      if (binding.commandId === command.id && !current.includes(binding.text)) {
        current.push(binding.text);
      }
    }
    return {
      id: command.id,
      title: labelText(command.title, locale),
      group: command.group,
      bindings: toBindings(current, keymap.platform),
      defaults: toBindings(defaultKeysFor(command.keybindings, keymap.platform), keymap.platform),
      customised: user.overrides[command.id] !== undefined,
      conflicts: conflicts.get(command.id) ?? [],
    };
  });
  return rows.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.title.localeCompare(b.title, locale),
  );
}

export interface RowGroup {
  readonly group: CommandGroup;
  readonly rows: readonly EditorRow[];
}

/** Splits consecutive rows of one group; keeps the incoming order (search order or group order). */
export function groupRows(rows: readonly EditorRow[]): readonly RowGroup[] {
  const groups: { group: CommandGroup; rows: EditorRow[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === row.group) last.rows.push(row);
    else groups.push({ group: row.group, rows: [row] });
  }
  return groups;
}

export interface KeymapConflictSummary {
  readonly count: number;
  /** Commands that take part in at least one conflict. */
  readonly commandIds: ReadonlySet<string>;
}

export function summariseConflicts(keymap: Keymap): KeymapConflictSummary {
  const found = findConflicts(keymap);
  const commandIds = new Set<string>();
  for (const { a, b } of found) {
    commandIds.add(a.commandId);
    commandIds.add(b.commandId);
  }
  return { count: found.length, commandIds };
}

/** `keymap.problems` as short `command: key` entries for the notice, without duplicates. */
export function problemList(problems: readonly KeymapProblem[], limit = 5): string {
  const seen = new Set<string>();
  for (const problem of problems) seen.add(`${problem.commandId}: ${problem.key}`);
  const items = [...seen];
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit ? `${shown}, …` : shown;
}

// ---- Search ---------------------------------------------------------------------------------

/**
 * Fuzzy search over the rows in both languages: title (ru and en), id, keywords, group and the
 * formatted shortcut, so `отмена`, `undo`, `ctrl z` and a mistyped `ыщке` all find their command.
 */
export function searchRows(
  rows: readonly EditorRow[],
  commands: readonly Command[],
  query: string,
): readonly EditorRow[] {
  if (query.trim() === '') return rows;
  const compiled = compileQuery(query);
  const byId = new Map(commands.map((command) => [command.id, command]));
  const scored: { row: EditorRow; score: number; index: number }[] = [];
  rows.forEach((row, index) => {
    const command = byId.get(row.id);
    if (command === undefined) return;
    const fields: SearchField[] = [
      { text: command.title.en, weight: 1 },
      { text: command.title.ru, weight: 1 },
      { text: row.id, weight: 0.6 },
      { text: COMMAND_GROUPS[row.group].en, weight: 0.4 },
      { text: COMMAND_GROUPS[row.group].ru, weight: 0.4 },
      ...(command.keywords ?? []).map((text) => ({ text, weight: 0.8 })),
      ...row.bindings.map((binding) => ({ text: binding.label, weight: 0.6 })),
    ];
    const match = matchQuery(compiled, fields);
    if (match !== null) scored.push({ row, score: match.score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.row);
}

// ---- Recording ------------------------------------------------------------------------------

export interface RecordingState {
  readonly strokes: readonly Stroke[];
}

export const IDLE_RECORDING: RecordingState = { strokes: [] };

/**
 * What the capture box should do with the key event:
 * `ignore` leaves the key alone (modifier alone, IME, repeat); `consume` is a recorded stroke or a
 * stroke refused because the chord is full; `save` and `cancel` end the recording.
 */
export type RecordingAction = 'ignore' | 'consume' | 'save' | 'cancel';

export interface RecordingStep {
  readonly state: RecordingState;
  readonly action: RecordingAction;
}

function hasNoModifier(event: KeyEventLike): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function recordingStep(
  state: RecordingState,
  event: KeyEventLike,
  platform: Platform,
): RecordingStep {
  if (isImeEvent(event) || event.repeat === true) return { state, action: 'ignore' };
  const bare = hasNoModifier(event);
  if (bare && event.code === 'Escape') return { state: IDLE_RECORDING, action: 'cancel' };
  if (bare && (event.code === 'Enter' || event.code === 'NumpadEnter')) {
    // Enter on an empty recording is just a key press the caller may let through.
    return state.strokes.length > 0 ? { state, action: 'save' } : { state, action: 'ignore' };
  }
  // Bare Tab (and Shift+Tab) keeps moving focus so keyboard users can leave the capture box;
  // `tab` can still be bound by typing it.
  if (event.code === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    return { state, action: 'ignore' };
  }
  const stroke = recordStroke(event, platform);
  if (stroke === null) return { state, action: 'ignore' };
  if (state.strokes.length >= MAX_CHORD_LENGTH) return { state, action: 'consume' };
  return { state: { strokes: [...state.strokes, stroke] }, action: 'consume' };
}

export type Candidate =
  | { readonly ok: true; readonly text: string; readonly label: string }
  | { readonly ok: false; readonly error: string };

/**
 * The binding being entered: a typed chord (phone fallback, `mod+k mod+s`) wins over the recorded
 * keys because typing in the field resets the recording. Null while nothing was entered.
 */
export function candidateOf(
  state: RecordingState,
  typed: string,
  platform: Platform,
): Candidate | null {
  if (typed.trim() !== '') {
    const parsed = parseChord(typed);
    if (!parsed.ok) return parsed;
    return { ok: true, text: chordText(parsed.value), label: formatChord(parsed.value, platform) };
  }
  if (state.strokes.length === 0) return null;
  return { ok: true, text: chordText(state.strokes), label: formatChord(state.strokes, platform) };
}

// ---- Conflict preview -----------------------------------------------------------------------

export interface CandidateConflict {
  readonly kind: ConflictKind;
  readonly otherId: string;
  readonly otherTitle: string;
}

export type CandidateCheck =
  | { readonly ok: true; readonly conflicts: readonly CandidateConflict[] }
  | { readonly ok: false; readonly error: string };

/** Previews `text` as a new binding of `commandId` before it is saved. */
export function checkCandidate(
  keymap: Keymap,
  commands: readonly Command[],
  commandId: string,
  text: string,
  locale: Locale,
): CandidateCheck {
  const result = conflictsWith(keymap, commands, { commandId, key: text });
  if (!result.ok) return result;
  const titles = new Map(commands.map((command) => [command.id, labelText(command.title, locale)]));
  const seen = new Set<string>();
  const conflicts: CandidateConflict[] = [];
  for (const { kind, b } of result.value) {
    const key = `${kind}:${b.commandId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push({
      kind,
      otherId: b.commandId,
      otherTitle: titles.get(b.commandId) ?? b.commandId,
    });
  }
  return { ok: true, conflicts };
}

// ---- Keymap edits ---------------------------------------------------------------------------

/** The override entries that describe what the command currently has. */
function currentEntries(
  user: UserKeymap,
  command: Command,
  platform: Platform,
): readonly BindingOverride[] {
  const override = user.overrides[command.id];
  if (override !== undefined) return override;
  return defaultKeyTexts(command, platform).map((key) => ({ key }));
}

/** An override identical to the defaults is no override: the row must not look customised. */
function commit(
  user: UserKeymap,
  command: Command,
  platform: Platform,
  entries: readonly BindingOverride[],
): UserKeymap {
  const defaults = defaultKeyTexts(command, platform);
  const same =
    entries.length === defaults.length &&
    entries.every((entry, index) => entry.when === undefined && entry.key === defaults[index]);
  return same
    ? resetCommandBindings(user, command.id)
    : setCommandBindings(user, command.id, entries);
}

/** Platform identity of a chord text, or null when it does not parse: `mod+y` and `ctrl+y` are one key on Linux. */
function chordIdOfText(text: string, platform: Platform): string | null {
  const parsed = parseChord(text);
  return parsed.ok ? chordId(parsed.value, platform) : null;
}

export function addBinding(
  user: UserKeymap,
  command: Command,
  platform: Platform,
  text: string,
): UserKeymap {
  const entries = currentEntries(user, command, platform);
  const wanted = chordIdOfText(text, platform);
  if (
    entries.some((entry) => entry.key === text || chordIdOfText(entry.key, platform) === wanted)
  ) {
    return user;
  }
  return commit(user, command, platform, [...entries, { key: text }]);
}

export function removeBinding(
  user: UserKeymap,
  command: Command,
  platform: Platform,
  text: string,
): UserKeymap {
  const entries = currentEntries(user, command, platform);
  return commit(
    user,
    command,
    platform,
    entries.filter((entry) => entry.key !== text),
  );
}

// ---- Import / export ------------------------------------------------------------------------

export type ImportPreview =
  | {
      readonly ok: true;
      readonly keymap: UserKeymap;
      readonly overrideCount: number;
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/** Validates a pasted or uploaded file against the registered commands; bad entries become warnings. */
export function previewImport(text: string, commands: readonly Command[]): ImportPreview {
  const result = importUserKeymap(text, new Set(commands.map((command) => command.id)));
  if (!result.ok) return result;
  return {
    ok: true,
    keymap: result.value.keymap,
    overrideCount: Object.keys(result.value.keymap.overrides).length,
    warnings: result.value.warnings,
  };
}
