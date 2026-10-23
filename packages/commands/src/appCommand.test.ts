import { beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type AppCommandDeps,
  type ApprovalMode,
  APP_COMMAND_TOOL,
  appCommandResultSchema,
  executeAppCommand,
  type PlannedAction,
} from './appCommand.ts';
import { buildKeymap, EMPTY_USER_KEYMAP } from './keymap.ts';
import { CommandRegistry, defineCommand } from './registry.ts';
import { calls, resetCalls, sampleCommands } from './testkit.ts';

interface Harness {
  readonly deps: AppCommandDeps;
  readonly events: string[];
  readonly requested: PlannedAction[];
  readonly plans: PlannedAction[];
  mode: ApprovalMode;
  answer: boolean;
  requestThrows: boolean;
  onRequest?: () => void;
}

let h: Harness;

function harness(): Harness {
  const registry = new CommandRegistry();
  registry.register(
    ...sampleCommands(),
    defineCommand({
      id: 'wall.rename',
      title: { en: 'Rename wall', ru: 'Переименовать стену' },
      description: { en: 'Give the current wall a new name', ru: 'Задать стене новое имя' },
      group: 'wall',
      mutates: true,
      args: z.object({ name: z.string().min(1) }),
      handler: ({ name }) => `renamed to ${name}`,
    }),
    defineCommand({
      id: 'dev.internal',
      title: { en: 'Internal', ru: 'Внутреннее' },
      group: 'app',
      aiHidden: true,
      mutates: false,
      handler: () => undefined,
    }),
  );
  const state: Harness = {
    events: [],
    requested: [],
    plans: [],
    mode: 'approve',
    answer: true,
    requestThrows: false,
    deps: {
      registry,
      getContext: () => ({ selection: true }),
      getKeymap: () => buildKeymap(registry.all(), EMPTY_USER_KEYMAP, 'linux'),
      locale: () => 'en',
      gate: {
        mode: () => state.mode,
        announce: (plan, status) => {
          state.events.push(`${status}:${plan.commandId}`);
          state.plans.push(plan);
        },
        request: async (plan) => {
          state.requested.push(plan);
          state.onRequest?.();
          if (state.requestThrows) throw new Error('prompt closed');
          return state.answer;
        },
      },
    },
  };
  return state;
}

beforeEach(() => {
  resetCalls();
  h = harness();
});

describe('app_command tool', () => {
  test('the tool definition carries the request schema', () => {
    expect(APP_COMMAND_TOOL.name).toBe('app_command');
    const schema = z.toJSONSchema(APP_COMMAND_TOOL.inputSchema);
    // Model tool APIs reject a root oneOf/anyOf: the root must be a plain object.
    expect(schema).toMatchObject({ type: 'object', required: ['op'] });
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema).not.toHaveProperty('oneOf');
    expect(JSON.stringify(schema)).toContain('"enum":["list","search","run"]');
  });

  test('list returns available, AI-visible commands with schema and keybinding', async () => {
    const result = await executeAppCommand(h.deps, { op: 'list' });
    expect(result.ok && result.op === 'list').toBe(true);
    if (!result.ok || result.op !== 'list') return;
    const ids = result.commands.map((c) => c.id);
    expect(ids).toContain('edit.undo');
    expect(ids).not.toContain('dev.internal');
    const undo = result.commands.find((c) => c.id === 'edit.undo');
    expect(undo?.keybinding).toBe('Ctrl+Z');
    expect(undo?.args).toBeNull();
    const rename = result.commands.find((c) => c.id === 'wall.rename');
    expect(JSON.stringify(rename?.args)).toContain('"name"');
    expect(rename?.mutates).toBe(true);
  });

  test('list can be narrowed to a group', async () => {
    const result = await executeAppCommand(h.deps, { op: 'list', group: 'wall' });
    expect(result.ok && result.op === 'list' && result.commands.map((c) => c.id).sort()).toEqual([
      'view.sortElements',
      'wall.rename',
    ]);
  });

  test('search ranks across languages and keywords', async () => {
    const en = await executeAppCommand(h.deps, { op: 'search', query: 'rename' });
    expect(en.ok && en.op === 'search' && en.commands[0]?.id).toBe('wall.rename');
    const ru = await executeAppCommand(h.deps, { op: 'search', query: 'сетка' });
    expect(ru.ok && ru.op === 'search' && ru.commands[0]?.id).toBe('view.toggleGrid');
    const none = await executeAppCommand(h.deps, { op: 'search', query: 'zzzzqq' });
    expect(none.ok && none.op === 'search' && none.commands).toEqual([]);
  });

  test('malformed requests come back as errors', async () => {
    for (const bad of [null, {}, { op: 'explode' }]) {
      const result = await executeAppCommand(h.deps, bad);
      expect(result.ok === false && result.code).toBe('invalid_request');
    }
  });
});

describe('approval policy', () => {
  test('a mutating action waits for approval and runs only once approved', async () => {
    h.answer = true;
    const result = await executeAppCommand(h.deps, { op: 'run', id: 'edit.undo' });
    expect(result).toEqual({ ok: true, op: 'run', id: 'edit.undo', value: null });
    expect(h.requested.map((p) => p.commandId)).toEqual(['edit.undo']);
    expect(h.events).toEqual(['planned:edit.undo', 'running:edit.undo', 'done:edit.undo']);
    expect(calls).toEqual(['edit.undo']);
  });

  test('a rejected mutating action does not run and is reported', async () => {
    h.answer = false;
    const result = await executeAppCommand(h.deps, { op: 'run', id: 'edit.undo' });
    expect(result.ok === false && result.code).toBe('rejected');
    expect(calls).toEqual([]);
    expect(h.events).toEqual(['planned:edit.undo', 'failed:edit.undo']);
  });

  test('auto mode announces the plan but does not ask', async () => {
    h.mode = 'auto';
    const result = await executeAppCommand(h.deps, { op: 'run', id: 'edit.undo' });
    expect(result.ok).toBe(true);
    expect(h.requested).toEqual([]);
    expect(h.events[0]).toBe('planned:edit.undo');
    expect(calls).toEqual(['edit.undo']);
  });

  test('a read-only action never asks, even in approve mode', async () => {
    const result = await executeAppCommand(h.deps, { op: 'run', id: 'view.toggleGrid' });
    expect(result.ok).toBe(true);
    expect(h.requested).toEqual([]);
    expect(calls).toEqual(['view.toggleGrid']);
  });

  test('the plan shows the args the AI chose', async () => {
    await executeAppCommand(h.deps, { op: 'run', id: 'wall.rename', args: { name: 'Garage' } });
    expect(h.requested[0]?.args).toEqual({ name: 'Garage' });
    expect(h.requested[0]?.title.ru).toBe('Переименовать стену');
  });
});

describe('run failures', () => {
  test('unknown, hidden and unavailable commands', async () => {
    const unknown = await executeAppCommand(h.deps, { op: 'run', id: 'no.such' });
    expect(unknown.ok === false && unknown.code).toBe('unknown');
    const hidden = await executeAppCommand(h.deps, { op: 'run', id: 'dev.internal' });
    expect(hidden.ok === false && hidden.code).toBe('unknown');
    const deps: AppCommandDeps = { ...h.deps, getContext: () => ({}) };
    const disabled = await executeAppCommand(deps, { op: 'run', id: 'edit.delete' });
    expect(disabled.ok === false && disabled.code).toBe('disabled');
    expect(h.requested).toEqual([]);
  });

  test('a failing handler is reported', async () => {
    h.mode = 'auto';
    h.deps.registry.register(
      defineCommand({
        id: 'x.boom',
        title: { en: 'Boom', ru: 'Бум' },
        group: 'app',
        mutates: false,
        handler: () => {
          throw new Error('kaput');
        },
      }),
    );
    const result = await executeAppCommand(h.deps, { op: 'run', id: 'x.boom' });
    expect(result).toEqual({ ok: false, code: 'failed', message: 'kaput' });
  });
});

describe('review regressions', () => {
  test('invalid args are reported before asking for approval', async () => {
    const result = await executeAppCommand(h.deps, {
      op: 'run',
      id: 'wall.rename',
      args: { name: '' },
    });
    expect(result.ok === false && result.code).toBe('invalid_args');
    expect(h.requested).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test('a failing approval prompt counts as a rejection and closes the plan', async () => {
    h.requestThrows = true;
    const result = await executeAppCommand(h.deps, { op: 'run', id: 'edit.undo' });
    expect(result.ok === false && result.code).toBe('rejected');
    expect(h.events).toEqual(['planned:edit.undo', 'failed:edit.undo']);
    expect(calls).toEqual([]);
  });

  test('every run has its own plan id', async () => {
    h.mode = 'auto';
    await executeAppCommand(h.deps, { op: 'run', id: 'edit.undo' });
    await executeAppCommand(h.deps, { op: 'run', id: 'edit.undo' });
    const ids = new Set(h.plans.map((plan) => plan.id));
    expect(ids.size).toBe(2);
  });

  test('arguments for a command that takes none are refused, not dropped', async () => {
    const result = await executeAppCommand(h.deps, {
      op: 'run',
      id: 'edit.undo',
      args: { steps: 3 },
    });
    expect(result.ok === false && result.code).toBe('invalid_args');
    expect(calls).toEqual([]);
  });

  test('search ranks like the palette: the exact title beats a looser match', async () => {
    const result = await executeAppCommand(h.deps, { op: 'search', query: 'undo' });
    expect(result.ok && result.op === 'search' && result.commands[0]?.id).toBe('edit.undo');
  });

  test('a cancelled request does not run, even in auto mode', async () => {
    h.mode = 'auto';
    const controller = new AbortController();
    controller.abort();
    const result = await executeAppCommand(
      h.deps,
      { op: 'run', id: 'edit.undo' },
      controller.signal,
    );
    expect(result.ok === false && result.code).toBe('cancelled');
    expect(calls).toEqual([]);
  });

  test('cancelling while the prompt is open stops the run even if it was approved', async () => {
    const controller = new AbortController();
    h.onRequest = () => controller.abort();
    const result = await executeAppCommand(
      h.deps,
      { op: 'run', id: 'edit.undo' },
      controller.signal,
    );
    expect(result.ok === false && result.code).toBe('cancelled');
    expect(calls).toEqual([]);
    expect(h.events.at(-1)).toBe('failed:edit.undo');
  });

  test('an abort that closes the prompt is cancelled, not a user refusal', async () => {
    const controller = new AbortController();
    h.onRequest = () => controller.abort();
    h.answer = false;
    const result = await executeAppCommand(
      h.deps,
      { op: 'run', id: 'edit.undo' },
      controller.signal,
    );
    expect(result.ok === false && result.code).toBe('cancelled');
    expect(h.events.at(-1)).toBe('failed:edit.undo');
  });

  test('ops need their own fields', async () => {
    for (const bad of [
      { op: 'search' },
      { op: 'search', query: '' },
      { op: 'run' },
      { op: 'run', id: '' },
    ]) {
      const result = await executeAppCommand(h.deps, bad);
      expect(result.ok === false && result.code).toBe('invalid_request');
    }
  });

  test('list says when it was cut short', async () => {
    const result = await executeAppCommand(h.deps, { op: 'list' });
    expect(result.ok && result.op === 'list' && result.truncated).toBe(false);
    const search = await executeAppCommand(h.deps, { op: 'search', query: 'e', limit: 1 });
    expect(search.ok && search.op === 'search' && search.truncated).toBe(true);
  });

  test('the args schema lists what the AI may send, defaults optional', async () => {
    h.deps.registry.register(
      defineCommand({
        id: 'wall.label',
        title: { en: 'Label wall', ru: 'Подписать стену' },
        group: 'wall',
        mutates: true,
        args: z.object({ text: z.string(), color: z.string().default('red') }),
        handler: () => undefined,
      }),
    );
    const result = await executeAppCommand(h.deps, { op: 'search', query: 'label wall' });
    const info = result.ok && result.op === 'search' ? result.commands[0] : undefined;
    expect(info?.id).toBe('wall.label');
    expect(JSON.stringify(info?.args)).toContain('"required":["text"]');
  });
});

describe('app_command wire schema', () => {
  test('every result executeAppCommand produces passes the result schema unchanged', async () => {
    const results = [
      await executeAppCommand(h.deps, { op: 'list' }),
      await executeAppCommand(h.deps, { op: 'search', query: 'rename' }),
      await executeAppCommand(h.deps, { op: 'run', id: 'edit.undo' }),
      await executeAppCommand(h.deps, { op: 'run', id: 'nope' }),
      await executeAppCommand(h.deps, { op: 'explode' }),
    ];
    for (const result of results) {
      const parsed = appCommandResultSchema.safeParse(JSON.parse(JSON.stringify(result)));
      expect(parsed.success).toBe(true);
      expect(parsed.data).toEqual<unknown>(result);
    }
  });

  test('replies that are not an app_command result are refused', () => {
    expect(appCommandResultSchema.safeParse({ selected: ['a'] }).success).toBe(false);
    expect(
      appCommandResultSchema.safeParse({ ok: false, code: 'melted', message: 'x' }).success,
    ).toBe(false);
    expect(appCommandResultSchema.safeParse({ ok: true, op: 'run' }).success).toBe(false);
    expect(appCommandResultSchema.safeParse('ok').success).toBe(false);
  });
});
