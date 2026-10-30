import { describe, expect, test } from 'bun:test';
import {
  EMPTY_USER_KEYMAP,
  parseUsage,
  parseUserKeymap,
  recordUse,
  SettingsStore,
  type UsageRecord,
  type UserKeymap,
} from '@hsw-editor/commands';
import { createSettingsClient, type SettingsStorage } from '@hsw-editor/user-settings';
import { createValueStore } from '#state-backend';
import { APP_SETTINGS } from './appSettings.ts';
import { persistNamespaces, toSettingsValue, type PersistedNamespace } from './persistence.ts';

function memoryStorage(): SettingsStorage & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function settingsEntry(store: SettingsStore): PersistedNamespace {
  return {
    namespace: 'settings',
    read: () => (Object.keys(store.overrides()).length === 0 ? undefined : store.overrides()),
    write: (value) => store.load(value),
    subscribe: store.subscribe.bind(store),
  };
}

describe('persistNamespaces', () => {
  test('a change is stored in the namespace', () => {
    const client = createSettingsClient({ storage: memoryStorage() });
    const store = new SettingsStore(APP_SETTINGS);
    persistNamespaces(client, [settingsEntry(store)]);
    store.set('appearance.theme', 'light');
    expect(client.get('settings')).toEqual({ 'appearance.theme': 'light' });
  });

  test('a stored namespace is applied at start', () => {
    const storage = memoryStorage();
    const first = createSettingsClient({ storage });
    first.set('settings', { 'units.length': 'in' });
    const second = createSettingsClient({ storage });
    const store = new SettingsStore(APP_SETTINGS);
    persistNamespaces(second, [settingsEntry(store)]);
    expect(store.get('units.length')).toBe('in');
  });

  test('a value that arrives from elsewhere is applied without being written back', () => {
    const client = createSettingsClient({ storage: memoryStorage() });
    const store = new SettingsStore(APP_SETTINGS);
    let writes = 0;
    const set = client.set.bind(client);
    client.set = (namespace, value) => {
      writes += 1;
      set(namespace, value);
    };
    persistNamespaces(client, [settingsEntry(store)]);
    set('settings', { 'editor.snap': false });
    expect(store.get('editor.snap')).toBe(false);
    expect(writes).toBe(0);
  });

  test('a remote value the store normalizes is not written back when notifications arrive later', async () => {
    const client = createSettingsClient({ storage: memoryStorage() });
    const store = createValueStore<string>('');
    let writes = 0;
    const set = client.set.bind(client);
    client.set = (namespace, value) => {
      writes += 1;
      set(namespace, value);
    };
    persistNamespaces(client, [
      {
        namespace: 'key',
        read: () => (store.get() === '' ? undefined : store.get()),
        write: (value) => store.set(typeof value === 'string' ? value.toLowerCase() : ''),
        subscribe: store.subscribe,
      },
    ]);
    set('key', 'Ctrl+U');
    const afterRemote = writes;
    await Promise.resolve();
    expect(store.get()).toBe('ctrl+u');
    expect(writes).toBe(afterRemote);
  });

  test('a namespace removed elsewhere resets the store to its defaults', () => {
    const client = createSettingsClient({ storage: memoryStorage() });
    const store = new SettingsStore(APP_SETTINGS);
    persistNamespaces(client, [settingsEntry(store)]);
    store.set('appearance.theme', 'light');
    client.remove('settings');
    expect(store.get('appearance.theme')).toBe('dark');
  });

  test('going back to defaults removes the namespace instead of storing an empty one', () => {
    const client = createSettingsClient({ storage: memoryStorage() });
    const store = new SettingsStore(APP_SETTINGS);
    persistNamespaces(client, [settingsEntry(store)]);
    store.set('appearance.theme', 'light');
    store.reset('appearance.theme');
    expect(client.get('settings')).toBeUndefined();
  });

  test('keymap and usage round-trip through their parsers', async () => {
    const client = createSettingsClient({ storage: memoryStorage() });
    const keymap = createValueStore<UserKeymap>(EMPTY_USER_KEYMAP);
    const usage = createValueStore<UsageRecord>({});
    persistNamespaces(client, [
      {
        namespace: 'keymap',
        read: () => (Object.keys(keymap.get().overrides).length === 0 ? undefined : keymap.get()),
        write: (value) => {
          const parsed = parseUserKeymap(value ?? EMPTY_USER_KEYMAP);
          keymap.set(parsed.ok ? parsed.value.keymap : EMPTY_USER_KEYMAP);
        },
        subscribe: keymap.subscribe,
      },
      {
        namespace: 'palette',
        read: () => (Object.keys(usage.get()).length === 0 ? undefined : usage.get()),
        write: (value) => usage.set(parseUsage(value)),
        subscribe: usage.subscribe,
      },
    ]);
    keymap.set({ version: 1, overrides: { 'edit.undo': [{ key: 'mod+u', when: undefined }] } });
    usage.set(recordUse({}, 'cmd:edit.undo', 1000));
    // state-lib delivers subscriber notifications in a microtask (see statelib-scope.ts).
    await Promise.resolve();
    expect(client.get('keymap')).toEqual({
      version: 1,
      overrides: { 'edit.undo': [{ key: 'mod+u' }] },
    });
    expect(client.get('palette')).toEqual({ 'cmd:edit.undo': { count: 1, lastUsed: 1000 } });
    // Garbage in storage must not break startup.
    client.set('palette', { bad: 'entry' });
    expect(usage.get()).toEqual({});
  });
});

test('toSettingsValue drops undefined members', () => {
  expect(toSettingsValue({ a: 1, b: undefined })).toEqual({ a: 1 });
});
