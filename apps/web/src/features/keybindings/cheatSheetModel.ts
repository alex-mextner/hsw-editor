/** Pure models of the cheat-sheet and of the pending-chord hint. */
import {
  COMMAND_GROUPS,
  type Command,
  type CommandGroup,
  type Context,
  compileQuery,
  formatChord,
  formatStroke,
  type Keymap,
  type Locale,
  labelText,
  matchQuery,
  matchesWhen,
  type PendingChord,
  type SearchField,
} from '@hsw-editor/commands';

const GROUP_ORDER: readonly CommandGroup[] = Object.keys(COMMAND_GROUPS) as CommandGroup[];

export interface CheatEntry {
  readonly id: string;
  readonly title: string;
  readonly labels: readonly string[];
}

export interface CheatGroup {
  readonly group: CommandGroup;
  readonly entries: readonly CheatEntry[];
}

/**
 * Commands that are usable now (`available` already honours their when-clauses) and have at least
 * one binding, grouped like the registry and narrowed by the filter in both languages.
 */
export function buildCheatSheet(
  available: readonly Command[],
  keymap: Keymap,
  locale: Locale,
  filter: string,
  context: Context,
): readonly CheatGroup[] {
  const compiled = compileQuery(filter);
  const byGroup = new Map<CommandGroup, CheatEntry[]>();
  for (const command of available) {
    const labels: string[] = [];
    for (const binding of keymap.bindings) {
      if (binding.commandId !== command.id) continue;
      // A binding with its own when-clause (a user override) may be inactive although the command is not.
      if (!matchesWhen(binding.when, context)) continue;
      const label = formatChord(binding.chord, keymap.platform);
      if (!labels.includes(label)) labels.push(label);
    }
    if (labels.length === 0) continue;
    if (filter.trim() !== '') {
      const fields: SearchField[] = [
        { text: command.title.en, weight: 1 },
        { text: command.title.ru, weight: 1 },
        ...(command.keywords ?? []).map((text) => ({ text, weight: 0.8 })),
        ...labels.map((text) => ({ text, weight: 0.6 })),
      ];
      if (matchQuery(compiled, fields) === null) continue;
    }
    const entry: CheatEntry = { id: command.id, title: labelText(command.title, locale), labels };
    const list = byGroup.get(command.group);
    if (list === undefined) byGroup.set(command.group, [entry]);
    else list.push(entry);
  }
  return GROUP_ORDER.flatMap((group) => {
    const entries = byGroup.get(group);
    if (entries === undefined) return [];
    return [
      {
        group,
        entries: [...entries].sort((a, b) => a.title.localeCompare(b.title, locale)),
      },
    ];
  });
}

export interface PendingOption {
  /** The stroke that completes (or continues) the chord. */
  readonly next: string;
  readonly title: string;
}

export interface PendingChordView {
  readonly typed: string;
  readonly options: readonly PendingOption[];
}

/** Display form of a chord in progress: what was typed and what each next key would do. */
export function pendingChordView(
  pending: PendingChord,
  commands: readonly Command[],
  platform: Keymap['platform'],
  locale: Locale,
): PendingChordView {
  const titles = new Map(commands.map((command) => [command.id, labelText(command.title, locale)]));
  const count = pending.typed.length;
  const options: PendingOption[] = [];
  const seen = new Set<string>();
  let typed = '';
  for (const candidate of pending.candidates) {
    const nextStroke = candidate.chord[count];
    if (nextStroke === undefined) continue;
    if (typed === '') typed = formatChord(candidate.chord.slice(0, count), platform);
    const next = formatStroke(nextStroke, platform);
    const key = `${next}\u0000${candidate.commandId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ next, title: titles.get(candidate.commandId) ?? candidate.commandId });
  }
  return { typed, options };
}
