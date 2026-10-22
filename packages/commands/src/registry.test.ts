import { beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { CommandRegistry, defineCommand } from './registry.ts';
import { calls, resetCalls, sampleCommands } from './testkit.ts';

beforeEach(resetCalls);

describe('command registry', () => {
  test('registers, lists and removes commands with a disposer', () => {
    const registry = new CommandRegistry();
    const dispose = registry.register(...sampleCommands());
    expect(registry.get('edit.undo')?.title.ru).toBe('Отменить');
    expect(registry.all().length).toBe(sampleCommands().length);
    dispose();
    expect(registry.all()).toEqual([]);
  });

  test('duplicate ids are rejected atomically', () => {
    const registry = new CommandRegistry();
    registry.register(...sampleCommands());
    const [first] = sampleCommands();
    if (first === undefined) throw new Error('fixture empty');
    expect(() => registry.register(first)).toThrow('already registered');
    const fresh = defineCommand({
      id: 'x.fresh',
      title: { en: 'Fresh', ru: 'Новая' },
      group: 'app',
      mutates: false,
      handler: () => undefined,
    });
    expect(() => registry.register(fresh, first)).toThrow();
    expect(registry.get('x.fresh')).toBeUndefined();
  });

  test('ids and when-clauses are validated at definition time', () => {
    const base = {
      title: { en: 'A', ru: 'А' },
      group: 'app',
      mutates: false,
      handler: () => undefined,
    } as const;
    expect(() => defineCommand({ ...base, id: 'nodots' })).toThrow('invalid command id');
    expect(() => defineCommand({ ...base, id: 'a.b', when: 'x &&' })).toThrow('bad when-clause');
  });

  test('available() filters by when-clause over the context', () => {
    const registry = new CommandRegistry();
    registry.register(...sampleCommands());
    const none = registry.available({}).map((c) => c.id);
    expect(none).not.toContain('edit.delete');
    expect(none).toContain('edit.undo');
    const selected = registry.available({ selection: true }).map((c) => c.id);
    expect(selected).toContain('edit.delete');
    expect(selected).toContain('edit.rotate');
    const dialog = registry.available({ selection: true, dialog: true }).map((c) => c.id);
    expect(dialog).toContain('edit.delete');
    expect(dialog).not.toContain('edit.rotate');
  });

  test('run executes the handler and reports unknown or disabled commands', async () => {
    const registry = new CommandRegistry();
    registry.register(...sampleCommands());
    expect(await registry.run('edit.undo', undefined, {})).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual(['edit.undo']);
    const unknown = await registry.run('nope.nothing', undefined, {});
    expect(unknown.ok === false && unknown.reason).toBe('unknown');
    const disabled = await registry.run('edit.delete', undefined, {});
    expect(disabled.ok === false && disabled.reason).toBe('disabled');
    expect(calls).toEqual(['edit.undo']);
  });

  test('args are validated against the schema and typed in the handler', async () => {
    const registry = new CommandRegistry();
    registry.register(
      defineCommand({
        id: 'wall.setSize',
        title: { en: 'Set size', ru: 'Задать размер' },
        group: 'wall',
        mutates: true,
        args: z.object({ widthMm: z.number().positive(), label: z.string().default('wall') }),
        handler: ({ widthMm, label }) => `${label}:${widthMm * 2}`,
      }),
    );
    expect(await registry.run('wall.setSize', { widthMm: 5 }, {})).toEqual({
      ok: true,
      value: 'wall:10',
    });
    const bad = await registry.run('wall.setSize', { widthMm: -1 }, {});
    expect(bad.ok === false && bad.reason).toBe('invalid_args');
    const missing = await registry.run('wall.setSize', undefined, {});
    expect(missing.ok === false && missing.reason).toBe('invalid_args');
  });

  test('handler failures become outcomes, never exceptions', async () => {
    const registry = new CommandRegistry();
    registry.register(
      defineCommand({
        id: 'x.boom',
        title: { en: 'Boom', ru: 'Бум' },
        group: 'app',
        mutates: false,
        handler: () => {
          throw new Error('kaput');
        },
      }),
      defineCommand({
        id: 'x.rejects',
        title: { en: 'Rejects', ru: 'Отказ' },
        group: 'app',
        mutates: false,
        handler: () => Promise.reject(new Error('later')),
      }),
    );
    expect(await registry.run('x.boom', undefined, {})).toEqual({
      ok: false,
      reason: 'failed',
      message: 'kaput',
    });
    const rejected = await registry.run('x.rejects', undefined, {});
    expect(rejected.ok === false && rejected.message).toBe('later');
  });

  test('default key bindings are validated at definition time', () => {
    const base = {
      title: { en: 'A', ru: 'А' },
      group: 'app',
      mutates: false,
      handler: () => undefined,
    } as const;
    expect(() =>
      defineCommand({ ...base, id: 'a.b', keybindings: { all: ['mod+shfit+p'] } }),
    ).toThrow('bad default key');
    expect(() =>
      defineCommand({ ...base, id: 'a.c', keybindings: { mac: ['mod+k'], linux: ['a b c d e'] } }),
    ).toThrow('bad default key');
  });

  test('the args schema describes the input: defaulted fields are optional', () => {
    const registry = new CommandRegistry();
    registry.register(
      defineCommand({
        id: 'wall.label',
        title: { en: 'Label', ru: 'Подпись' },
        group: 'wall',
        mutates: true,
        args: z.object({ text: z.string(), color: z.string().default('red') }),
        handler: () => undefined,
      }),
    );
    expect(JSON.stringify(registry.argsJsonSchema('wall.label'))).toContain('"required":["text"]');
  });

  test('exposes the args JSON schema and notifies subscribers', () => {
    const registry = new CommandRegistry();
    let notified = 0;
    registry.subscribe(() => {
      notified += 1;
    });
    registry.register(
      defineCommand({
        id: 'wall.rename',
        title: { en: 'Rename', ru: 'Переименовать' },
        group: 'wall',
        mutates: true,
        args: z.object({ name: z.string().min(1) }),
        handler: () => undefined,
      }),
    );
    const schema = registry.argsJsonSchema('wall.rename');
    expect(JSON.stringify(schema)).toContain('"name"');
    expect(registry.argsJsonSchema('missing.id')).toBeUndefined();
    expect(notified).toBe(1);
    expect(registry.version()).toBe(1);
  });
});
