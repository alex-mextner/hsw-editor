import { describe, expect, test } from 'bun:test';
import { SettingsStore, type SettingValue } from '@hsw-editor/commands';
import { APP_SETTINGS } from './appSettings.ts';
import { adoptAppValues, bridgeSettings, type SettingBinding } from './settingsBridge.ts';

/** A store of the app that, like the real ones, notifies on every write (even an equal one). */
function fakeApp<State extends Record<string, SettingValue>>(initial: State) {
  let state = initial;
  const listeners = new Set<() => void>();
  let writes = 0;
  const write = (patch: Partial<State>): void => {
    writes += 1;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  /** A binding onto one field of the shared app store. */
  const bind = (
    id: string,
    field: keyof State & string,
    userChoice?: () => boolean,
  ): SettingBinding => ({
    id,
    read: () => state[field] as SettingValue,
    write: (value) => write({ [field]: value } as Partial<State>),
    subscribe,
    ...(userChoice === undefined ? {} : { userChoice }),
  });
  return { bind, write, writes: () => writes, state: () => state };
}

function fakeBinding(id: string, initial: SettingValue, userChoice?: () => boolean) {
  const app = fakeApp({ value: initial });
  const binding = app.bind(id, 'value', userChoice);
  return { binding, writes: app.writes, set: (next: SettingValue) => app.write({ value: next }) };
}

describe('bridgeSettings', () => {
  test('a stored setting wins over the app value at start', () => {
    const store = new SettingsStore(APP_SETTINGS, { 'appearance.theme': 'light' });
    const theme = fakeBinding('appearance.theme', 'dark');
    bridgeSettings(store, [theme.binding]);
    expect(theme.binding.read()).toBe('light');
  });

  test('the app values are not adopted at start', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const theme = fakeBinding('appearance.theme', 'light');
    bridgeSettings(store, [theme.binding]);
    expect(store.isDefault('appearance.theme')).toBe(true);
  });

  test('changes flow both ways without echoing', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const snap = fakeBinding('editor.snap', true);
    bridgeSettings(store, [snap.binding]);
    store.set('editor.snap', false);
    expect(snap.binding.read()).toBe(false);
    expect(snap.writes()).toBe(1);
    snap.set(true);
    expect(store.get('editor.snap')).toBe(true);
    expect(snap.writes()).toBe(2);
  });

  test('reloading the persisted object (a server sync) reaches the app store', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const unit = fakeBinding('units.length', 'mm');
    bridgeSettings(store, [unit.binding]);
    store.load({ 'units.length': 'in' });
    expect(unit.binding.read()).toBe('in');
    store.load({});
    expect(unit.binding.read()).toBe('mm');
  });

  test('settings sharing one app store all survive a reload that changes them together', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const editor = fakeApp<{ snap: boolean; view: string }>({ snap: true, view: 'perspective' });
    bridgeSettings(store, [editor.bind('editor.snap', 'snap'), editor.bind('view.mode', 'view')]);
    store.load({ 'editor.snap': false, 'view.mode': 'front' });
    expect(editor.state()).toEqual({ snap: false, view: 'front' });
    expect(store.get('editor.snap')).toBe(false);
    expect(store.get('view.mode')).toBe('front');
    store.load({});
    expect(editor.state()).toEqual({ snap: true, view: 'perspective' });
    expect(store.overrides()).toEqual({});
  });

  test('a user edit made right after such a reload is still seen', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const editor = fakeApp<{ snap: boolean; view: string }>({ snap: true, view: 'perspective' });
    bridgeSettings(store, [editor.bind('editor.snap', 'snap'), editor.bind('view.mode', 'view')]);
    store.load({ 'view.mode': 'front' });
    editor.write({ snap: false });
    expect(store.get('editor.snap')).toBe(false);
    expect(store.get('view.mode')).toBe('front');
  });

  test('an app value the setting rejects leaves the setting untouched', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const unit = fakeBinding('units.length', 'mm');
    bridgeSettings(store, [unit.binding]);
    unit.set('furlong');
    expect(store.get('units.length')).toBe('mm');
  });

  test('the disposer detaches both sides', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const snap = fakeBinding('editor.snap', true);
    const stop = bridgeSettings(store, [snap.binding]);
    stop();
    store.set('editor.snap', false);
    expect(snap.binding.read()).toBe(true);
    snap.set(false);
    store.set('editor.snap', true);
    expect(snap.binding.read()).toBe(false);
  });
});

describe('adoptAppValues', () => {
  function adopt(
    store: SettingsStore,
    bindings: readonly SettingBinding[],
    document: 'none' | 'present' | 'unknown',
  ) {
    const onDevice: string[] = [];
    adoptAppValues(store, bindings, {
      document,
      storeOnDevice: (id, value) => {
        onDevice.push(id);
        store.set(id, value);
      },
      isDeviceOnly: (id) => id.startsWith('layout.'),
    });
    return onDevice;
  }

  test('a saved choice becomes a synced setting when the server has no document', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const theme = fakeBinding('appearance.theme', 'light', () => true);
    expect(adopt(store, [theme.binding], 'none')).toEqual([]);
    expect(store.get('appearance.theme')).toBe('light');
  });

  test('an environment-picked value is shown but stays on the device', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const language = fakeBinding('appearance.language', 'en', () => false);
    expect(adopt(store, [language.binding], 'none')).toEqual(['appearance.language']);
    expect(store.get('appearance.language')).toBe('en');
  });

  test('without server contact nothing is synced, a saved choice stays on the device', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const theme = fakeBinding('appearance.theme', 'light', () => true);
    expect(adopt(store, [theme.binding], 'unknown')).toEqual(['appearance.theme']);
  });

  test('a server document that says default wins over a saved choice', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const theme = fakeBinding('appearance.theme', 'light', () => true);
    expect(adopt(store, [theme.binding], 'present')).toEqual([]);
    expect(theme.binding.read()).toBe('dark');
    expect(store.isDefault('appearance.theme')).toBe(true);
  });

  test('panels are adopted whatever the server holds', () => {
    const store = new SettingsStore(APP_SETTINGS);
    const bank = fakeBinding('layout.bank', false);
    adopt(store, [bank.binding], 'present');
    expect(store.get('layout.bank')).toBe(false);
  });

  test('settings the user already changed are left alone', () => {
    const store = new SettingsStore(APP_SETTINGS, { 'appearance.theme': 'light' });
    const theme = fakeBinding('appearance.theme', 'dark', () => true);
    adopt(store, [theme.binding], 'none');
    expect(store.get('appearance.theme')).toBe('light');
  });
});
