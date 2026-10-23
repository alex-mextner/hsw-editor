/**
 * The keymap: default per-OS bindings of the registered commands merged with the user's overrides,
 * conflict detection between bindings, and the JSON form of the user's overrides.
 */
import { z } from 'zod';
import {
  type Chord,
  chordId,
  chordText,
  isInputSafeStroke,
  type ParseResult,
  parseChord,
  type Platform,
} from './keys.ts';
import type { Command, DefaultKeybindings } from './registry.ts';
import { parseWhen, whenMayOverlap } from './when.ts';

export type BindingSource = 'default' | 'user';

export interface Binding {
  readonly commandId: string;
  readonly chord: Chord;
  /** Platform-resolved identity of the chord; equal ids collide. */
  readonly chordId: string;
  /** Canonical portable text (`mod+k mod+s`), as stored in the user keymap. */
  readonly text: string;
  /** Effective when-clause: the command's clause and the binding's own, combined. */
  readonly when: string | undefined;
  readonly source: BindingSource;
  readonly allowInInput: boolean;
  readonly repeat: boolean;
}

export interface KeymapProblem {
  readonly commandId: string;
  readonly key: string;
  readonly error: string;
}

export interface Keymap {
  readonly platform: Platform;
  readonly bindings: readonly Binding[];
  readonly problems: readonly KeymapProblem[];
}

export interface BindingOverride {
  readonly key: string;
  readonly when?: string | undefined;
}

/** `overrides[commandId]` replaces ALL default bindings of that command; `[]` unbinds it. */
export interface UserKeymap {
  readonly version: 1;
  readonly overrides: Readonly<Record<string, readonly BindingOverride[]>>;
}

export const EMPTY_USER_KEYMAP: UserKeymap = { version: 1, overrides: {} };

export function defaultKeysFor(
  keybindings: DefaultKeybindings | undefined,
  platform: Platform,
): readonly string[] {
  if (keybindings === undefined) return [];
  return keybindings[platform] ?? keybindings.all ?? [];
}

function combineWhen(commandWhen: string | undefined, bindingWhen: string | undefined) {
  if (commandWhen === undefined) return bindingWhen;
  if (bindingWhen === undefined) return commandWhen;
  return `(${commandWhen}) && (${bindingWhen})`;
}

export function buildKeymap(
  commands: readonly Command[],
  user: UserKeymap,
  platform: Platform,
): Keymap {
  const bindings: Binding[] = [];
  const problems: KeymapProblem[] = [];
  const add = (command: Command, source: BindingSource, entry: BindingOverride): void => {
    const parsed = parseChord(entry.key);
    if (!parsed.ok) {
      problems.push({ commandId: command.id, key: entry.key, error: parsed.error });
      return;
    }
    if (entry.when !== undefined) {
      const when = parseWhen(entry.when);
      if (!when.ok) {
        problems.push({ commandId: command.id, key: entry.key, error: when.error });
        return;
      }
    }
    const first = parsed.value[0];
    bindings.push({
      commandId: command.id,
      chord: parsed.value,
      chordId: chordId(parsed.value, platform),
      text: chordText(parsed.value),
      when: combineWhen(command.when, entry.when),
      source,
      // Plain typing must never trigger a command: only modifier chords may bypass the input guard.
      allowInInput:
        command.allowInInput === true && first !== undefined && isInputSafeStroke(first),
      repeat: command.repeat === true,
    });
  };
  for (const command of commands) {
    const override = user.overrides[command.id];
    if (override !== undefined) {
      for (const entry of override) add(command, 'user', entry);
      continue;
    }
    for (const key of defaultKeysFor(command.keybindings, platform)) {
      add(command, 'default', { key });
    }
  }
  return { platform, bindings, problems };
}

export function bindingsOf(keymap: Keymap, commandId: string): readonly Binding[] {
  return keymap.bindings.filter((binding) => binding.commandId === commandId);
}

// ---- Conflicts ----------------------------------------------------------------------------------

/**
 * `duplicate`: two commands on the same chord in overlapping contexts.
 * `shadow`: one command's chord is a strict prefix of another's, so the longer chord can never
 * be completed (the shorter binding fires first).
 */
export type ConflictKind = 'duplicate' | 'shadow';

export interface Conflict {
  readonly kind: ConflictKind;
  readonly a: Binding;
  readonly b: Binding;
}

function isStrictPrefix(shorter: string, longer: string): boolean {
  return longer.length > shorter.length && longer.startsWith(`${shorter} `);
}

function conflictBetween(a: Binding, b: Binding): ConflictKind | null {
  if (a.commandId === b.commandId) return null;
  if (!whenMayOverlap(a.when, b.when)) return null;
  if (a.chordId === b.chordId) return 'duplicate';
  if (isStrictPrefix(a.chordId, b.chordId) || isStrictPrefix(b.chordId, a.chordId)) return 'shadow';
  return null;
}

function firstStroke(binding: Binding): string {
  return binding.chordId.split(' ')[0] ?? '';
}

export function findConflicts(keymap: Keymap): readonly Conflict[] {
  const buckets = new Map<string, Binding[]>();
  for (const binding of keymap.bindings) {
    const key = firstStroke(binding);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [binding]);
    else bucket.push(binding);
  }
  const conflicts: Conflict[] = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a === undefined || b === undefined) continue;
        const kind = conflictBetween(a, b);
        if (kind !== null) conflicts.push({ kind, a, b });
      }
    }
  }
  return conflicts;
}

export interface CandidateBinding {
  readonly commandId: string;
  readonly key: string;
  readonly when?: string | undefined;
}

/**
 * Existing bindings that would collide with `candidate` if it were added to `keymap`; used by the
 * editor to warn while a key is being recorded. Bindings of the candidate's own command are ignored.
 */
export function conflictsWith(
  keymap: Keymap,
  commands: readonly Command[],
  candidate: CandidateBinding,
): ParseResult<readonly Conflict[]> {
  const command = commands.find((entry) => entry.id === candidate.commandId);
  if (command === undefined)
    return { ok: false, error: `unknown command '${candidate.commandId}'` };
  const probe = buildKeymap(
    [command],
    { version: 1, overrides: { [command.id]: [{ key: candidate.key, when: candidate.when }] } },
    keymap.platform,
  );
  const problem = probe.problems[0];
  if (problem !== undefined) return { ok: false, error: problem.error };
  const [binding] = probe.bindings;
  if (binding === undefined) return { ok: true, value: [] };
  const found: Conflict[] = [];
  for (const other of keymap.bindings) {
    const kind = conflictBetween(binding, other);
    if (kind !== null) found.push({ kind, a: binding, b: other });
  }
  return { ok: true, value: found };
}

// ---- User keymap: edit, export, import ----------------------------------------------------------

export function setCommandBindings(
  user: UserKeymap,
  commandId: string,
  bindings: readonly BindingOverride[],
): UserKeymap {
  return { version: 1, overrides: { ...user.overrides, [commandId]: bindings } };
}

export function resetCommandBindings(user: UserKeymap, commandId: string): UserKeymap {
  const { [commandId]: _removed, ...rest } = user.overrides;
  return { version: 1, overrides: rest };
}

export function isCustomized(user: UserKeymap, commandId: string): boolean {
  return user.overrides[commandId] !== undefined;
}

const userKeymapSchema = z.object({
  version: z.literal(1),
  overrides: z.record(
    z.string(),
    z.array(z.object({ key: z.string(), when: z.string().optional() })),
  ),
});

export interface KeymapImport {
  readonly keymap: UserKeymap;
  /** Entries that were dropped: unparsable keys, bad when-clauses, unknown commands. */
  readonly warnings: readonly string[];
}

/**
 * Validates an untrusted keymap document (a settings load, a pasted file). Bad entries are
 * dropped with a warning instead of failing the whole import; `knownCommandIds` additionally
 * drops overrides of commands that do not exist.
 */
export function parseUserKeymap(
  value: unknown,
  knownCommandIds?: ReadonlySet<string>,
): ParseResult<KeymapImport> {
  const parsed = userKeymapSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const warnings: string[] = [];
  const overrides: Record<string, readonly BindingOverride[]> = {};
  for (const [commandId, entries] of Object.entries(parsed.data.overrides)) {
    if (knownCommandIds !== undefined && !knownCommandIds.has(commandId)) {
      warnings.push(`${commandId}: unknown command, skipped`);
      continue;
    }
    const valid: BindingOverride[] = [];
    for (const entry of entries) {
      const chord = parseChord(entry.key);
      if (!chord.ok) {
        warnings.push(`${commandId}: ${chord.error}`);
        continue;
      }
      if (entry.when !== undefined) {
        const when = parseWhen(entry.when);
        if (!when.ok) {
          warnings.push(`${commandId}: ${when.error}`);
          continue;
        }
      }
      valid.push({ key: chordText(chord.value), when: entry.when });
    }
    // An empty list means "unbound" only when the file said so; a list whose every entry was
    // dropped must not strip the command's defaults.
    if (valid.length > 0 || entries.length === 0) overrides[commandId] = valid;
  }
  return { ok: true, value: { keymap: { version: 1, overrides }, warnings } };
}

export function exportUserKeymap(user: UserKeymap): string {
  return `${JSON.stringify(user, null, 2)}\n`;
}

export function importUserKeymap(
  text: string,
  knownCommandIds?: ReadonlySet<string>,
): ParseResult<KeymapImport> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid JSON' };
  }
  return parseUserKeymap(json, knownCommandIds);
}
