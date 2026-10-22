/**
 * The action registry: every user-visible action of the editor is a command registered here once,
 * and every surface (key bindings, command palette, cheat-sheet, the AI `app_command` tool, menus)
 * reads the same list.
 */
import type { JsonValue } from '@hsw-editor/core';
import { z } from 'zod';
import { parseChord } from './keys.ts';
import { type Context, matchesWhen, parseWhen } from './when.ts';
import type { LocalizedText } from './text.ts';

export type CommandGroup =
  | 'edit'
  | 'view'
  | 'wall'
  | 'tools'
  | 'bank'
  | 'history'
  | 'navigation'
  | 'settings'
  | 'help'
  | 'ai'
  | 'app';

export const COMMAND_GROUPS: Readonly<Record<CommandGroup, LocalizedText>> = {
  edit: { en: 'Edit', ru: 'Правка' },
  view: { en: 'View', ru: 'Вид' },
  wall: { en: 'Wall', ru: 'Стена' },
  tools: { en: 'Tools', ru: 'Инструменты' },
  bank: { en: 'Bank', ru: 'Банк' },
  history: { en: 'History', ru: 'История' },
  navigation: { en: 'Go to', ru: 'Переход' },
  settings: { en: 'Settings', ru: 'Настройки' },
  help: { en: 'Help', ru: 'Справка' },
  ai: { en: 'AI', ru: 'ИИ' },
  app: { en: 'App', ru: 'Приложение' },
};

/** Per-OS default bindings. A platform entry replaces `all`; `[]` means unbound on that platform. */
export interface DefaultKeybindings {
  readonly all?: readonly string[];
  readonly mac?: readonly string[];
  readonly windows?: readonly string[];
  readonly linux?: readonly string[];
}

interface CommandBase {
  /** Stable dotted id: `edit.undo`, `view.toggleGrid`. Persisted in user keymaps. */
  readonly id: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  /** Synonyms and related words in any language; matched by the palette search. */
  readonly keywords?: readonly string[];
  readonly group: CommandGroup;
  /** When-clause over context keys; the command is listed and runnable only while it holds. */
  readonly when?: string;
  readonly keybindings?: DefaultKeybindings;
  /** Changes the wall, the selection or a persisted setting. The AI asks before running these. */
  readonly mutates: boolean;
  /** The command's key bindings stay active while a text field has focus (needs a modifier). */
  readonly allowInInput?: boolean;
  /** Holding the key repeats the command (nudge, scrub). Off by default. */
  readonly repeat?: boolean;
  /** Hidden from the command palette (still bindable). Default listed. */
  readonly hidden?: boolean;
  /** Not exposed to the AI `app_command` tool. Default exposed. */
  readonly aiHidden?: boolean;
}

export type CommandOutput = JsonValue | undefined;
export type CommandReturn = CommandOutput | Promise<CommandOutput>;

export interface ArglessCommandSpec extends CommandBase {
  readonly args?: undefined;
  readonly handler: () => CommandReturn;
}

export interface ArgsCommandSpec<Schema extends z.ZodType> extends CommandBase {
  readonly args: Schema;
  readonly handler: (args: z.output<Schema>) => CommandReturn;
}

export type RunFailureReason = 'unknown' | 'disabled' | 'invalid_args' | 'failed';

export type RunOutcome =
  | { readonly ok: true; readonly value: CommandOutput }
  | { readonly ok: false; readonly reason: RunFailureReason; readonly message: string };

/** A registered command with its handler type-erased behind a validating `execute`. */
export interface Command extends CommandBase {
  readonly argsSchema: z.ZodType | undefined;
  /** Checks `rawArgs` without running anything (an approval prompt can then show valid args only). */
  readonly validateArgs: (rawArgs: unknown) => ArgsCheck;
  /** Validates `rawArgs`, then runs the handler. Never throws. */
  readonly execute: (rawArgs: unknown) => Promise<RunOutcome>;
}

export type ArgsCheck =
  | { readonly ok: true; readonly args: unknown }
  | { readonly ok: false; readonly message: string };

const ID_PATTERN = /^[a-zA-Z][\w-]*(\.[\w-]+)+$/;

/** Ids of commands and settings: dotted, at least two segments (`edit.undo`, `appearance.theme`). */
export function isDottedId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function isEmptyArgs(rawArgs: unknown): boolean {
  if (rawArgs === undefined || rawArgs === null) return true;
  return typeof rawArgs === 'object' && Object.keys(rawArgs).length === 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runHandler(call: () => CommandReturn): Promise<RunOutcome> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, reason: 'failed', message: describeError(error) };
  }
}

function takesArgs<Schema extends z.ZodType>(
  spec: ArglessCommandSpec | ArgsCommandSpec<Schema>,
): spec is ArgsCommandSpec<Schema> {
  return spec.args !== undefined;
}

export function defineCommand(spec: ArglessCommandSpec): Command;
export function defineCommand<Schema extends z.ZodType>(spec: ArgsCommandSpec<Schema>): Command;
export function defineCommand<Schema extends z.ZodType>(
  spec: ArglessCommandSpec | ArgsCommandSpec<Schema>,
): Command {
  if (!isDottedId(spec.id)) throw new Error(`invalid command id '${spec.id}'`);
  if (spec.when !== undefined) {
    const parsed = parseWhen(spec.when);
    if (!parsed.ok) throw new Error(`command ${spec.id}: bad when-clause: ${parsed.error}`);
  }
  for (const key of Object.values(spec.keybindings ?? {}).flat()) {
    const chord = parseChord(key);
    if (!chord.ok) throw new Error(`command ${spec.id}: bad default key '${key}': ${chord.error}`);
  }
  const { handler, args, ...meta } = spec;
  if (!takesArgs(spec)) {
    const run = spec.handler;
    // Silently dropping arguments would let a caller believe they took effect.
    const validateArgs = (rawArgs: unknown): ArgsCheck =>
      isEmptyArgs(rawArgs)
        ? { ok: true, args: undefined }
        : { ok: false, message: `command '${spec.id}' takes no arguments` };
    return {
      ...meta,
      argsSchema: undefined,
      validateArgs,
      execute: async (rawArgs) => {
        const checked = validateArgs(rawArgs);
        if (!checked.ok) return { ok: false, reason: 'invalid_args', message: checked.message };
        return runHandler(run);
      },
    };
  }
  const schema = spec.args;
  const run = spec.handler;
  const parse = (rawArgs: unknown) => schema.safeParse(rawArgs ?? {});
  return {
    ...meta,
    argsSchema: schema,
    validateArgs: (rawArgs) => {
      const parsed = parse(rawArgs);
      return parsed.success
        ? { ok: true, args: parsed.data }
        : { ok: false, message: z.prettifyError(parsed.error) };
    },
    execute: async (rawArgs) => {
      const parsed = parse(rawArgs);
      if (!parsed.success) {
        return { ok: false, reason: 'invalid_args', message: z.prettifyError(parsed.error) };
      }
      return runHandler(() => run(parsed.data));
    },
  };
}

export type Disposer = () => void;

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly schemaCache = new WeakMap<z.ZodType, JsonValue>();

  /** Registers commands; returns a disposer that removes exactly those. Duplicate ids throw. */
  register(...commands: readonly Command[]): Disposer {
    const seen = new Set<string>();
    for (const command of commands) {
      if (this.commands.has(command.id) || seen.has(command.id)) {
        throw new Error(`command '${command.id}' is already registered`);
      }
      seen.add(command.id);
    }
    for (const command of commands) this.commands.set(command.id, command);
    this.changed();
    return () => {
      let removed = false;
      for (const command of commands) {
        if (this.commands.get(command.id) === command) {
          this.commands.delete(command.id);
          removed = true;
        }
      }
      if (removed) this.changed();
    };
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): readonly Command[] {
    return [...this.commands.values()];
  }

  /** Commands whose when-clause holds in `context`. */
  available(context: Context): readonly Command[] {
    return this.all().filter((command) => matchesWhen(command.when, context));
  }

  isEnabled(id: string, context: Context): boolean {
    const command = this.commands.get(id);
    return command !== undefined && matchesWhen(command.when, context);
  }

  async run(id: string, rawArgs: unknown, context: Context): Promise<RunOutcome> {
    const command = this.commands.get(id);
    if (command === undefined) {
      return { ok: false, reason: 'unknown', message: `unknown command '${id}'` };
    }
    if (!matchesWhen(command.when, context)) {
      return {
        ok: false,
        reason: 'disabled',
        message: `command '${id}' is not available now (when: ${command.when ?? 'always'})`,
      };
    }
    return command.execute(rawArgs);
  }

  /** JSON Schema of a command's arguments, for the AI tool listing. */
  argsJsonSchema(id: string): JsonValue | undefined {
    const schema = this.commands.get(id)?.argsSchema;
    if (schema === undefined) return undefined;
    const cached = this.schemaCache.get(schema);
    if (cached !== undefined) return cached;
    // `io: 'input'`: the AI needs what it may send (defaults optional), not what the handler gets.
    // The round trip drops anything not JSON (undefined members) and yields a typed JsonValue.
    const json: JsonValue = JSON.parse(
      JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' })),
    );
    this.schemaCache.set(schema, json);
    return json;
  }

  /** Bumps on every registration change; lets a UI memoise derived lists. */
  version(): number {
    return this.revision;
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
