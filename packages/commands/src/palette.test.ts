import { beforeEach, describe, expect, test } from 'bun:test';
import { buildKeymap, EMPTY_USER_KEYMAP } from './keymap.ts';
import {
  commandProvider,
  type PaletteItem,
  type PaletteProvider,
  parsePaletteInput,
  type PaletteResults,
  searchPalette,
  settingsProvider,
} from './palette.ts';
import { CommandRegistry, defineCommand } from './registry.ts';
import { defineSettings, SettingsStore } from './settings.ts';
import { calls, resetCalls, sampleCommands } from './testkit.ts';
import { EMPTY_USAGE, recordUse, type UsageRecord } from './usage.ts';
import type { Context } from './when.ts';
import type { Locale } from './text.ts';
import { z } from 'zod';

const NOW = 1_000_000;

const store = new SettingsStore(
  defineSettings([
    {
      id: 'appearance.theme',
      type: 'choice',
      default: 'dark',
      group: 'appearance',
      title: { en: 'Theme', ru: 'Тема' },
      keywords: ['dark', 'light', 'тёмная', 'светлая', 'цвет'],
      options: [
        { value: 'dark', label: { en: 'Dark', ru: 'Тёмная' } },
        { value: 'light', label: { en: 'Light', ru: 'Светлая' } },
      ],
    },
    {
      id: 'editor.snapToGrid',
      type: 'boolean',
      default: true,
      group: 'editor',
      title: { en: 'Snap to honeycomb grid', ru: 'Привязка к сетке' },
    },
    {
      id: 'editor.nudgeMm',
      type: 'number',
      default: 5,
      min: 1,
      max: 50,
      step: 1,
      group: 'editor',
      title: { en: 'Nudge distance', ru: 'Шаг сдвига' },
    },
  ]),
);

let registry: CommandRegistry;
let context: Context;
let locale: Locale;

function item(
  id: string,
  kind: PaletteItem['kind'],
  title: string,
  keywords: readonly string[] = [],
): PaletteItem {
  return { id, kind, title, keywords, run: () => undefined };
}

function wallProvider(): PaletteProvider {
  return {
    id: 'walls',
    modes: ['all', 'goto'],
    items: () => [item('wall:1', 'wall', 'Garage wall'), item('wall:2', 'wall', 'Kitchen wall')],
  };
}

function wallItemsProvider(): PaletteProvider {
  return {
    id: 'wall-items',
    modes: ['all', 'items'],
    items: () => [item('item:a', 'item', 'Hammer holder'), item('item:b', 'item', 'Wrench holder')],
  };
}

function bankProvider(): PaletteProvider {
  return {
    id: 'bank',
    modes: ['all', 'bank'],
    items: async () => [
      item('bank:x', 'bank', 'Pliers rack'),
      item('tool:y', 'tool', 'Tape measure holder'),
    ],
  };
}

function providers(): readonly PaletteProvider[] {
  return [
    commandProvider({
      registry,
      getKeymap: () => buildKeymap(registry.all(), EMPTY_USER_KEYMAP, 'linux'),
      getContext: () => context,
    }),
    settingsProvider(store, () => locale),
    wallProvider(),
    wallItemsProvider(),
    bankProvider(),
  ];
}

async function search(
  input: string,
  usage: UsageRecord = EMPTY_USAGE,
  askAi?: (text: string) => void,
): Promise<PaletteResults> {
  return searchPalette({
    input,
    providers: providers(),
    locale,
    context,
    usage,
    now: NOW,
    ...(askAi === undefined ? {} : { askAi }),
  });
}

function titles(results: PaletteResults, locale_: Locale = 'en'): string[] {
  return results.rows.map((row) =>
    typeof row.item.title === 'string' ? row.item.title : row.item.title[locale_],
  );
}

beforeEach(() => {
  resetCalls();
  registry = new CommandRegistry();
  registry.register(...sampleCommands());
  context = {};
  locale = 'en';
  store.load({});
});

describe('prefix modes', () => {
  test('prefixes select the mode and strip themselves', () => {
    expect(parsePaletteInput('> undo')).toEqual({ mode: 'commands', prefix: '>', text: 'undo' });
    expect(parsePaletteInput('@hammer')).toEqual({ mode: 'items', prefix: '@', text: 'hammer' });
    expect(parsePaletteInput('#pliers')).toEqual({ mode: 'bank', prefix: '#', text: 'pliers' });
    expect(parsePaletteInput(':garage')).toEqual({ mode: 'goto', prefix: ':', text: 'garage' });
    expect(parsePaletteInput('? how do I rotate')).toEqual({
      mode: 'ai',
      prefix: '?',
      text: 'how do I rotate',
    });
    expect(parsePaletteInput(' plain ')).toEqual({ mode: 'all', prefix: '', text: 'plain' });
  });

  test('each mode searches only its own sources', async () => {
    expect(titles(await search('@holder'))).toEqual(['Hammer holder', 'Wrench holder']);
    expect(titles(await search('#holder'))).toEqual(['Tape measure holder']);
    expect(titles(await search(':wall'))).toEqual(['Garage wall', 'Kitchen wall']);
    const commands = await search('>undo');
    expect(
      commands.rows.every((row) => row.item.kind === 'command' || row.item.kind === 'setting'),
    ).toBe(true);
    expect(titles(commands)[0]).toBe('Undo');
  });
});

describe('mixed search', () => {
  test('finds commands, settings, walls, wall items and the bank in one query', async () => {
    const results = await search('wall');
    const kinds = new Set(results.sections.map((s) => s.kind));
    expect(kinds.has('wall')).toBe(true);
    const holder = await search('holder');
    expect(new Set(holder.sections.map((s) => s.kind))).toEqual(new Set(['item', 'tool']));
  });

  test('searching "тема" in Russian finds the theme setting first and it carries an inline control', async () => {
    locale = 'ru';
    const results = await search('тема');
    const first = results.rows[0]?.item;
    expect(first?.id).toBe('setting:appearance.theme');
    expect(first?.control).toEqual({
      type: 'choice',
      value: 'dark',
      options: [
        { value: 'dark', label: { en: 'Dark', ru: 'Тёмная' } },
        { value: 'light', label: { en: 'Light', ru: 'Светлая' } },
      ],
    });
  });

  test('a setting can be toggled straight from its palette item', async () => {
    const results = await search('snap');
    const snap = results.rows.find((row) => row.item.id === 'setting:editor.snapToGrid');
    expect(snap?.item.control).toEqual({ type: 'switch', checked: true });
    await snap?.item.run?.();
    expect(store.get('editor.snapToGrid')).toBe(false);
    const again = await search('snap');
    expect(
      again.rows.find((row) => row.item.id === 'setting:editor.snapToGrid')?.item.control,
    ).toEqual({
      type: 'switch',
      checked: false,
    });
  });

  test('number settings are inline-only: no run, a number control', async () => {
    const results = await search('nudge');
    const nudge = results.rows.find((row) => row.item.id === 'setting:editor.nudgeMm');
    expect(nudge?.item.run).toBeUndefined();
    expect(nudge?.item.control?.type).toBe('number');
  });

  test('mistyped layout and transliteration reach the same items', async () => {
    expect(titles(await search('ыщке'))).toContain('Sort elements');
    expect(titles(await search('ыщкеу'))).toContain('Sort elements');
    locale = 'ru';
    expect(titles(await search('ntvf'), 'ru')[0]).toBe('Тема');
  });

  test('commands whose when-clause is false are not listed', async () => {
    expect(titles(await search('delete'))).not.toContain('Delete selection');
    context = { selection: true };
    expect(titles(await search('delete'))).toContain('Delete selection');
  });

  test('commands show their key binding and run through the registry', async () => {
    const results = await search('undo');
    const undo = results.rows.find((row) => row.item.id === 'cmd:edit.undo');
    expect(undo?.item.keybinding).toBe('Ctrl+Z');
    await undo?.item.run?.();
    expect(calls).toEqual(['edit.undo']);
  });

  test('commands that need arguments are not offered, hidden ones neither', async () => {
    registry.register(
      defineCommand({
        id: 'wall.setSize',
        title: { en: 'Set wall size', ru: 'Задать размер' },
        group: 'wall',
        mutates: true,
        args: z.object({ widthMm: z.number() }),
        handler: () => undefined,
      }),
      defineCommand({
        id: 'wall.secret',
        title: { en: 'Secret wall thing', ru: 'Секрет' },
        group: 'wall',
        hidden: true,
        mutates: false,
        handler: () => undefined,
      }),
    );
    const results = await search('wall');
    const ids = results.rows.map((row) => row.item.id);
    expect(ids).not.toContain('cmd:wall.setSize');
    expect(ids).not.toContain('cmd:wall.secret');
  });

  test('highlight positions are reported for the displayed title', async () => {
    const results = await search('tgrid');
    const toggle = results.rows.find((row) => row.item.id === 'cmd:view.toggleGrid');
    expect(toggle?.positions[0]).toBe(0);
  });
});

describe('recents and frequency', () => {
  test('an empty query shows recents first, then commands', async () => {
    let usage = recordUse(EMPTY_USAGE, 'cmd:view.toggleGrid', NOW - 1000);
    usage = recordUse(usage, 'setting:editor.snapToGrid', NOW - 500);
    const results = await search('', usage);
    expect(results.sections[0]?.kind).toBe('recent');
    expect(results.sections[0]?.items.map((r) => r.item.id).sort()).toEqual([
      'cmd:view.toggleGrid',
      'setting:editor.snapToGrid',
    ]);
    expect(results.sections[1]?.kind).toBe('command');
    const commandIds = results.sections[1]?.items.map((r) => r.item.id) ?? [];
    expect(commandIds).not.toContain('cmd:view.toggleGrid');
  });

  test('stale recent ids do not crowd real commands out of the recents section', async () => {
    let usage: UsageRecord = EMPTY_USAGE;
    usage = recordUse(usage, 'cmd:view.toggleGrid', NOW - 5000);
    for (let i = 0; i < 8; i += 1) usage = recordUse(usage, `cmd:gone.${i}`, NOW - i);
    const results = await search('', usage);
    expect(results.sections[0]?.kind).toBe('recent');
    expect(results.sections[0]?.items.map((r) => r.item.id)).toEqual(['cmd:view.toggleGrid']);
  });

  test('frequency breaks ties between equally good matches', async () => {
    registry.register(
      defineCommand({
        id: 'view.zoomIn',
        title: { en: 'Zoom in', ru: 'Приблизить' },
        group: 'view',
        mutates: false,
        handler: () => undefined,
      }),
      defineCommand({
        id: 'view.zoomInstant',
        title: { en: 'Zoom instantly', ru: 'Мгновенно' },
        group: 'view',
        mutates: false,
        handler: () => undefined,
      }),
    );
    const cold = await search('zoomin');
    expect(cold.rows.length).toBe(2);
    const second = cold.rows[1]?.item.id;
    const heated = recordUse(recordUse(EMPTY_USAGE, `${second}`, NOW - 10), `${second}`, NOW - 5);
    const warm = await search('zoomin', heated);
    expect(warm.rows[0]?.item.id).toBe(second);
  });
});

describe('ask AI row', () => {
  test('is pinned last for free text and absent without a handler', async () => {
    const asked: string[] = [];
    const results = await search('how do i make the wall darker', EMPTY_USAGE, (text) => {
      asked.push(text);
    });
    const last = results.rows.at(-1);
    expect(last?.item.kind).toBe('ai');
    await last?.item.run?.();
    expect(asked).toEqual(['how do i make the wall darker']);
    const none = await search('undo');
    expect(none.rows.some((row) => row.item.kind === 'ai')).toBe(false);
  });

  test('? mode shows only the ask row, and nothing for empty text', async () => {
    const asked: string[] = [];
    const results = await search('? rotate everything', EMPTY_USAGE, (text) => {
      asked.push(text);
    });
    expect(results.rows.length).toBe(1);
    expect(results.rows[0]?.item.kind).toBe('ai');
    expect(results.sections[0]?.kind).toBe('ai');
    const empty = await search('?', EMPTY_USAGE, () => undefined);
    expect(empty.rows).toEqual([]);
  });
});

describe('offline behaviour', () => {
  test('local providers need no network: results come from memory only', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      () => {
        throw new Error('network is forbidden');
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const results = await search('undo');
      expect(titles(results)[0]).toBe('Undo');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a failing provider does not take the others down and is reported', async () => {
    const broken: PaletteProvider = {
      id: 'history',
      modes: ['all'],
      items: () => Promise.reject(new Error('offline')),
    };
    const throwing: PaletteProvider = {
      id: 'docs',
      modes: ['all'],
      items: () => {
        throw new Error('sync throw');
      },
    };
    const results = await searchPalette({
      input: 'undo',
      providers: [...providers(), broken, throwing],
      locale,
      context,
      usage: EMPTY_USAGE,
      now: NOW,
    });
    expect(titles(results)[0]).toBe('Undo');
    expect(results.failedProviders).toEqual(['history', 'docs']);
  });

  test('duplicate item ids from different providers appear once', async () => {
    const dup: PaletteProvider = {
      id: 'dup',
      modes: ['all'],
      items: () => [item('wall:1', 'wall', 'Garage wall again')],
    };
    const results = await searchPalette({
      input: 'garage',
      providers: [wallProvider(), dup],
      locale,
      context,
      usage: EMPTY_USAGE,
      now: NOW,
    });
    expect(results.rows.length).toBe(1);
  });
});
