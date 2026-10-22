import { describe, expect, test } from 'bun:test';
import { CommandRegistry } from './registry.ts';
import {
  coerceSetting,
  defineSettings,
  describeSettings,
  type SettingDefinition,
  SettingsStore,
  settingCommands,
} from './settings.ts';

const DEFINITIONS = defineSettings([
  {
    id: 'appearance.theme',
    type: 'choice',
    default: 'dark',
    group: 'appearance',
    title: { en: 'Theme', ru: 'Тема' },
    keywords: ['dark', 'light', 'тёмная', 'светлая'],
    options: [
      { value: 'dark', label: { en: 'Dark', ru: 'Тёмная' } },
      { value: 'light', label: { en: 'Light', ru: 'Светлая' } },
      { value: 'system', label: { en: 'System', ru: 'Системная' } },
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
    step: 0.5,
    group: 'editor',
    title: { en: 'Nudge distance (mm)', ru: 'Шаг сдвига (мм)' },
  },
]);

describe('setting definitions', () => {
  test('rejects duplicates, bad ids and a default outside the options', () => {
    const [theme] = DEFINITIONS;
    if (theme === undefined) throw new Error('fixture');
    expect(() => defineSettings([theme, theme])).toThrow('duplicate');
    expect(() => defineSettings([{ ...theme, id: 'nodots' }])).toThrow('invalid setting id');
    const bad: SettingDefinition = {
      id: 'a.b',
      type: 'choice',
      default: 'x',
      group: 'editor',
      title: { en: 'A', ru: 'А' },
      options: [{ value: 'y', label: 'Y' }],
    };
    expect(() => defineSettings([bad])).toThrow('default is not one of the options');
  });

  test('coercion validates by type, clamps and snaps numbers to the step grid', () => {
    const [theme, snap, nudge] = DEFINITIONS;
    if (theme === undefined || snap === undefined || nudge === undefined)
      throw new Error('fixture');
    expect(coerceSetting(theme, 'light')).toBe('light');
    expect(coerceSetting(theme, 'neon')).toBeUndefined();
    expect(coerceSetting(snap, 'yes')).toBeUndefined();
    expect(coerceSetting(nudge, 100)).toBe(50);
    expect(coerceSetting(nudge, -3)).toBe(1);
    expect(coerceSetting(nudge, 7.3)).toBe(7.5);
    expect(coerceSetting(nudge, Number.NaN)).toBeUndefined();
  });

  test('snapping never lands above max, and ranges are validated up front', () => {
    const odd: SettingDefinition = {
      id: 'a.odd',
      type: 'number',
      default: 1,
      min: 1,
      max: 10,
      step: 2,
      group: 'editor',
      title: { en: 'Odd', ru: 'Нечёт' },
    };
    expect(coerceSetting(odd, 10)).toBe(10);
    expect(() => defineSettings([{ ...odd, step: 0 }])).toThrow('step > 0');
    expect(() => defineSettings([{ ...odd, min: 5, max: 1 }])).toThrow('min <= max');
  });
});

describe('settings store and persistence', () => {
  test('defaults, set, toggle, reset', () => {
    const store = new SettingsStore(DEFINITIONS);
    expect(store.get('appearance.theme')).toBe('dark');
    expect(store.set('appearance.theme', 'light')).toBe(true);
    expect(store.get('appearance.theme')).toBe('light');
    expect(store.toggle('editor.snapToGrid')).toBe(true);
    expect(store.get('editor.snapToGrid')).toBe(false);
    expect(store.toggle('appearance.theme')).toBe(true);
    expect(store.get('appearance.theme')).toBe('system');
    expect(store.toggle('appearance.theme')).toBe(true);
    expect(store.get('appearance.theme')).toBe('dark');
    store.reset('editor.snapToGrid');
    expect(store.get('editor.snapToGrid')).toBe(true);
    expect(store.toggle('editor.nudgeMm')).toBe(false);
  });

  test('invalid values and unknown ids are refused without changing anything', () => {
    const store = new SettingsStore(DEFINITIONS);
    expect(store.set('appearance.theme', 'neon')).toBe(false);
    expect(store.set('ghost.setting', true)).toBe(false);
    expect(store.get('appearance.theme')).toBe('dark');
    expect(() => store.get('ghost.setting')).toThrow('unknown setting');
  });

  test('only non-default values persist, and they reload identically', () => {
    const store = new SettingsStore(DEFINITIONS);
    store.set('appearance.theme', 'light');
    store.set('editor.snapToGrid', true);
    store.set('editor.nudgeMm', 10);
    const saved = JSON.parse(JSON.stringify(store.overrides()));
    expect(saved).toEqual({ 'appearance.theme': 'light', 'editor.nudgeMm': 10 });
    const reloaded = new SettingsStore(DEFINITIONS, saved);
    expect(reloaded.get('appearance.theme')).toBe('light');
    expect(reloaded.get('editor.nudgeMm')).toBe(10);
    expect(reloaded.get('editor.snapToGrid')).toBe(true);
    expect(reloaded.overrides()).toEqual(saved);
  });

  test('loading is tolerant: stale ids, wrong types and garbage are dropped', () => {
    const store = new SettingsStore(DEFINITIONS, {
      'appearance.theme': 'purple',
      'editor.snapToGrid': 'yes',
      'removed.setting': 1,
      'editor.nudgeMm': 12,
    });
    expect(store.overrides()).toEqual({ 'editor.nudgeMm': 12 });
    store.load(null);
    expect(store.overrides()).toEqual({});
    store.load([1, 2]);
    expect(store.overrides()).toEqual({});
  });

  test('subscribers hear about each change and about a reload', () => {
    const store = new SettingsStore(DEFINITIONS);
    const heard: string[] = [];
    const stop = store.subscribe((id) => heard.push(id));
    store.set('appearance.theme', 'light');
    store.set('appearance.theme', 'light');
    store.reset('appearance.theme');
    expect(heard).toEqual(['appearance.theme', 'appearance.theme']);
    store.load({ 'editor.nudgeMm': 9 });
    expect(heard.at(-1)).toBe('editor.nudgeMm');
    stop();
    store.set('editor.snapToGrid', false);
    expect(heard.length).toBe(3);
  });

  test('settings are exposed as when-clause context keys', () => {
    const store = new SettingsStore(DEFINITIONS);
    store.set('editor.snapToGrid', false);
    expect(store.context()).toEqual({
      'setting.appearance.theme': 'dark',
      'setting.editor.snapToGrid': false,
      'setting.editor.nudgeMm': 5,
    });
  });

  test('describeSettings lists id, titles, value and default for the AI', () => {
    const store = new SettingsStore(DEFINITIONS);
    store.set('appearance.theme', 'light');
    const described = describeSettings(store);
    expect(Array.isArray(described) && described[0]).toEqual({
      id: 'appearance.theme',
      title: { en: 'Theme', ru: 'Тема' },
      type: 'choice',
      value: 'light',
      default: 'dark',
    });
  });
});

describe('setting commands', () => {
  test('every setting is reachable through the registry', async () => {
    const store = new SettingsStore(DEFINITIONS);
    const registry = new CommandRegistry();
    registry.register(...settingCommands(store));
    const ids = registry
      .all()
      .map((c) => c.id)
      .sort();
    expect(ids).toEqual([
      'settings.set.appearance.theme',
      'settings.set.editor.nudgeMm',
      'settings.set.editor.snapToGrid',
      'settings.toggle.appearance.theme',
      'settings.toggle.editor.snapToGrid',
    ]);
    expect(await registry.run('settings.toggle.editor.snapToGrid', undefined, {})).toEqual({
      ok: true,
      value: false,
    });
    expect(await registry.run('settings.set.appearance.theme', { value: 'light' }, {})).toEqual({
      ok: true,
      value: 'light',
    });
    expect(store.get('appearance.theme')).toBe('light');
  });

  test('choice settings expose their allowed values to the AI', () => {
    const store = new SettingsStore(DEFINITIONS);
    const registry = new CommandRegistry();
    registry.register(...settingCommands(store));
    expect(JSON.stringify(registry.argsJsonSchema('settings.set.appearance.theme'))).toContain(
      '"enum":["dark","light","system"]',
    );
  });

  test('invalid values are rejected by the args schema', async () => {
    const store = new SettingsStore(DEFINITIONS);
    const registry = new CommandRegistry();
    registry.register(...settingCommands(store));
    const bad = await registry.run('settings.set.appearance.theme', { value: 'neon' }, {});
    expect(bad.ok === false && bad.reason).toBe('invalid_args');
    const range = await registry.run('settings.set.editor.nudgeMm', { value: 500 }, {});
    expect(range.ok === false && range.reason).toBe('invalid_args');
    expect(store.get('editor.nudgeMm')).toBe(5);
    expect(registry.get('settings.set.appearance.theme')?.mutates).toBe(true);
  });
});
