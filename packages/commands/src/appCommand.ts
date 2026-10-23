/**
 * `app_command`: the host tool the embedded omp session calls to list, search and run registry
 * commands in the page. {@link executeAppCommand} is its page-side implementation: it validates the
 * request, always announces what is about to run, and holds mutating actions for the user's
 * approval unless the user switched to auto.
 */
import type { JsonValue } from '@hsw-editor/core';
import { z } from 'zod';
import { bindingsOf, type Keymap } from './keymap.ts';
import { formatChord } from './keys.ts';
import { commandPaletteItem, rankPaletteItems } from './palette.ts';
import type { Command, CommandRegistry } from './registry.ts';
import type { Locale, LocalizedText } from './text.ts';
import { EMPTY_USAGE } from './usage.ts';
import type { Context } from './when.ts';

export const APP_COMMAND_TOOL_NAME = 'app_command';

/**
 * One flat object (not a union): model tool APIs require the root of an input schema to be an
 * object. Which fields an `op` needs is checked in {@link parseAppCommandRequest}.
 */
export const appCommandRequestSchema = z.object({
  op: z.enum(['list', 'search', 'run']).describe('list, search or run a command.'),
  group: z.string().optional().describe('op=list: only commands of this group, e.g. edit, view.'),
  query: z
    .string()
    .optional()
    .describe('op=search: words from the command title or what it does, any language.'),
  limit: z.number().int().min(1).max(50).optional().describe('op=search: at most this many hits.'),
  id: z.string().optional().describe('op=run: command id from list or search.'),
  args: z
    .record(z.string(), z.json())
    .optional()
    .describe("op=run: arguments matching the command's args schema, if it has one."),
});

export type AppCommandRequest =
  | { readonly op: 'list'; readonly group?: string }
  | { readonly op: 'search'; readonly query: string; readonly limit?: number }
  | {
      readonly op: 'run';
      readonly id: string;
      readonly args?: Readonly<Record<string, JsonValue>>;
    };

type RequestParse =
  | { readonly ok: true; readonly request: AppCommandRequest }
  | { readonly ok: false; readonly message: string };

export function parseAppCommandRequest(raw: unknown): RequestParse {
  const parsed = appCommandRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: z.prettifyError(parsed.error) };
  const { op, group, query, limit, id, args } = parsed.data;
  switch (op) {
    case 'list':
      return { ok: true, request: { op, ...(group === undefined ? {} : { group }) } };
    case 'search':
      if (query === undefined || query === '')
        return { ok: false, message: 'op=search needs query' };
      return {
        ok: true,
        request: { op, query, ...(limit === undefined ? {} : { limit }) },
      };
    case 'run':
      if (id === undefined || id === '') return { ok: false, message: 'op=run needs id' };
      return { ok: true, request: { op, id, ...(args === undefined ? {} : { args }) } };
  }
}

/** Tool definition handed to omp when the page registers the `app_command` host tool. */
export const APP_COMMAND_TOOL = {
  name: APP_COMMAND_TOOL_NAME,
  description:
    'List, search and run actions of the HSW editor UI (the same actions as the command palette and ' +
    'keyboard shortcuts: undo, view toggles, theme and other settings, panels, bank search...). ' +
    'Use op=search or op=list first to find the id, then op=run. Actions that change the wall ' +
    'or settings may need the user to approve them; a rejection comes back as an error.',
  inputSchema: appCommandRequestSchema,
} as const;

export interface AppCommandInfo {
  readonly id: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  readonly group: string;
  readonly mutates: boolean;
  /** Formatted default or user binding, if any. */
  readonly keybinding?: string;
  /** JSON Schema of `args`, null when the command takes none. */
  readonly args: JsonValue | null;
}

export type AppCommandErrorCode =
  | 'invalid_request'
  | 'unknown'
  | 'disabled'
  | 'invalid_args'
  | 'rejected'
  | 'cancelled'
  | 'failed';

export type AppCommandResult =
  | {
      readonly ok: true;
      readonly op: 'list' | 'search';
      readonly commands: readonly AppCommandInfo[];
      /** More commands matched than are returned; narrow the request (group, search). */
      readonly truncated: boolean;
    }
  | { readonly ok: true; readonly op: 'run'; readonly id: string; readonly value: JsonValue | null }
  | { readonly ok: false; readonly code: AppCommandErrorCode; readonly message: string };

/** What the AI is about to do, shown to the user before (approve mode) or while (auto) it runs. */
export interface PlannedAction {
  /** Unique per run, so two runs of the same command are told apart. */
  readonly id: string;
  readonly commandId: string;
  readonly title: LocalizedText;
  readonly args: JsonValue | null;
  readonly mutates: boolean;
}

export type PlanStatus = 'planned' | 'running' | 'done' | 'failed';

export type ApprovalMode = 'approve' | 'auto';

export interface ApprovalGate {
  readonly mode: () => ApprovalMode;
  /** Shows the plan; called for every run, mutating or not. */
  readonly announce: (plan: PlannedAction, status: PlanStatus) => void;
  /**
   * Asks the user; resolves true to proceed. Only called in `approve` mode for mutating actions.
   * Must settle when `signal` aborts (the palette closed, the answer was cancelled): a rejection
   * or `false` counts as "not approved".
   */
  readonly request: (plan: PlannedAction, signal: AbortSignal | undefined) => Promise<boolean>;
}

export interface AppCommandDeps {
  readonly registry: CommandRegistry;
  readonly getContext: () => Context;
  readonly getKeymap: () => Keymap;
  readonly gate: ApprovalGate;
  readonly locale: () => Locale;
}

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_LIST = 200;

let planCounter = 0;

/** A function, not an inline check: the signal can abort during any await, which narrowing hides. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelled(): AppCommandResult {
  return { ok: false, code: 'cancelled', message: 'the request was cancelled' };
}

function infoOf(command: Command, keymap: Keymap, registry: CommandRegistry): AppCommandInfo {
  const binding = bindingsOf(keymap, command.id)[0];
  return {
    id: command.id,
    title: command.title,
    ...(command.description === undefined ? {} : { description: command.description }),
    group: command.group,
    mutates: command.mutates,
    ...(binding === undefined ? {} : { keybinding: formatChord(binding.chord, keymap.platform) }),
    args: registry.argsJsonSchema(command.id) ?? null,
  };
}

function exposed(deps: AppCommandDeps): readonly Command[] {
  return deps.registry.available(deps.getContext()).filter((command) => command.aiHidden !== true);
}

export async function executeAppCommand(
  deps: AppCommandDeps,
  rawRequest: unknown,
  signal?: AbortSignal,
): Promise<AppCommandResult> {
  const parsed = parseAppCommandRequest(rawRequest);
  if (!parsed.ok) return { ok: false, code: 'invalid_request', message: parsed.message };
  const { request } = parsed;
  switch (request.op) {
    case 'list': {
      const keymap = deps.getKeymap();
      const matching = exposed(deps).filter(
        (command) => request.group === undefined || command.group === request.group,
      );
      const commands = matching
        .slice(0, MAX_LIST)
        .map((command) => infoOf(command, keymap, deps.registry));
      return { ok: true, op: 'list', commands, truncated: matching.length > MAX_LIST };
    }
    case 'search': {
      const keymap = deps.getKeymap();
      const byItemId = new Map(
        exposed(deps).map((command) => [commandPaletteItem(command, keymap).id, command] as const),
      );
      // Same fields, weights and tie-breaks as the palette, so the user and the AI see one ranking.
      const ranked = rankPaletteItems(
        [...byItemId.values()].map((command) => commandPaletteItem(command, keymap)),
        request.query,
        { locale: deps.locale(), usage: EMPTY_USAGE, now: 0 },
      );
      const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
      const commands = ranked.slice(0, limit).flatMap((entry) => {
        const command = byItemId.get(entry.item.id);
        return command === undefined ? [] : [infoOf(command, keymap, deps.registry)];
      });
      return { ok: true, op: 'search', commands, truncated: ranked.length > limit };
    }
    case 'run':
      return runCommand(deps, request.id, request.args, signal);
  }
}

async function runCommand(
  deps: AppCommandDeps,
  id: string,
  args: Readonly<Record<string, JsonValue>> | undefined,
  signal: AbortSignal | undefined,
): Promise<AppCommandResult> {
  const command = deps.registry.get(id);
  if (command === undefined || command.aiHidden === true) {
    return { ok: false, code: 'unknown', message: `unknown command '${id}'` };
  }
  if (!deps.registry.isEnabled(id, deps.getContext())) {
    return { ok: false, code: 'disabled', message: `command '${id}' is not available right now` };
  }
  if (isAborted(signal)) return cancelled();
  // Bad arguments are the AI's mistake: report them before bothering the user with an approval.
  const checked = command.validateArgs(args);
  if (!checked.ok) return { ok: false, code: 'invalid_args', message: checked.message };

  planCounter += 1;
  const plan: PlannedAction = {
    id: `plan-${planCounter}`,
    commandId: id,
    title: command.title,
    args: args ?? null,
    mutates: command.mutates,
  };
  deps.gate.announce(plan, 'planned');
  if (command.mutates && deps.gate.mode() === 'approve') {
    let approved = false;
    try {
      approved = await deps.gate.request(plan, signal);
    } catch {
      approved = false;
    }
    // An abort that closed the prompt is not a refusal: the user never decided.
    if (!approved && !isAborted(signal)) {
      deps.gate.announce(plan, 'failed');
      return { ok: false, code: 'rejected', message: 'the user did not approve this action' };
    }
  }
  if (isAborted(signal)) {
    deps.gate.announce(plan, 'failed');
    return cancelled();
  }
  deps.gate.announce(plan, 'running');
  const outcome = await deps.registry.run(id, args, deps.getContext());
  if (!outcome.ok) {
    deps.gate.announce(plan, 'failed');
    return { ok: false, code: outcome.reason, message: outcome.message };
  }
  deps.gate.announce(plan, 'done');
  return { ok: true, op: 'run', id, value: outcome.value ?? null };
}
