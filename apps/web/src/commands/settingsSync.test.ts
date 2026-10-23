import { describe, expect, test } from 'bun:test';
import { SettingsStore, type SettingValue } from '@hsw-editor/commands';
import {
  applySettingsPut,
  createSettingsClient,
  defaultSettingsDocument,
  type SettingsDocument,
  type SettingsPutBody,
  type SettingsStorage,
  type SettingsTransport,
} from '@hsw-editor/user-settings';
import { APP_SETTINGS } from './appSettings.ts';
import type { SettingBinding } from './settingsBridge.ts';
import { wireSettings } from './settingsSync.ts';

class MemoryStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string): string | null => this.items.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.items.set(key, value);
  removeItem = (key: string): void => void this.items.delete(key);
}

/** The real merge rules in memory; `online = false` makes every request fail like a dead network. */
class FakeServer implements SettingsTransport {
  document: SettingsDocument = defaultSettingsDocument();
  online = true;
  puts: SettingsPutBody[] = [];

  withSettings(settings: Record<string, SettingValue>): this {
    this.document = applySettingsPut(this.document, { data: { settings } });
    return this;
  }

  get(): Promise<SettingsDocument> {
    return this.online ? Promise.resolve(this.document) : Promise.reject(new Error('offline'));
  }

  put(body: SettingsPutBody) {
    if (!this.online) return Promise.reject(new Error('offline'));
    this.puts.push(body);
    this.document = applySettingsPut(this.document, body);
    return Promise.resolve({ kind: 'ok' as const, document: this.document });
  }

  settings(): unknown {
    return this.document.data.settings;
  }
}

/** A device: the app's stores (as bindings), the settings store, and a client onto the server. */
function device(
  server: FakeServer,
  app: { language: string; theme: string; units: string },
  options: { chosen?: readonly ('language' | 'theme' | 'units')[]; storage?: MemoryStorage } = {},
) {
  const state = { ...app };
  const listeners = new Set<() => void>();
  const bind = (id: string, field: keyof typeof state, choice: boolean): SettingBinding => ({
    id,
    read: () => state[field],
    write: (value) => {
      state[field] = String(value);
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    userChoice: () => choice,
  });
  const chosen = options.chosen ?? [];
  const bindings = [
    bind('appearance.language', 'language', chosen.includes('language')),
    bind('appearance.theme', 'theme', chosen.includes('theme')),
    bind('units.length', 'units', chosen.includes('units')),
  ];
  const client = createSettingsClient({
    transport: server,
    storage: options.storage ?? new MemoryStorage(),
    debounceMs: 0,
  });
  const store = new SettingsStore(APP_SETTINGS);
  const wiring = wireSettings(client, store, bindings);
  const start = async (): Promise<void> => {
    await client.sync();
    wiring.adopt();
    await client.flush();
  };
  const edit = (id: string, value: SettingValue): void => void store.set(id, value);
  return { state, store, client, start, edit };
}

describe('a new device', () => {
  test('keeps what the server stored, whatever language the browser speaks', async () => {
    const server = new FakeServer().withSettings({
      'appearance.theme': 'light',
      'units.length': 'in',
    });
    // English browser: the locale store starts at 'en' although the setting default is 'ru'.
    const phone = device(server, { language: 'en', theme: 'dark', units: 'mm' });
    await phone.start();

    expect(phone.state.theme).toBe('light');
    expect(phone.state.units).toBe('in');
    expect(phone.state.language).toBe('en');
    expect(phone.store.get('appearance.language')).toBe('en');
    expect(server.puts).toEqual([]);
    expect(server.settings()).toEqual({ 'appearance.theme': 'light', 'units.length': 'in' });
  });

  test('a later change on the new device merges into the server document', async () => {
    const server = new FakeServer().withSettings({ 'appearance.theme': 'light' });
    const phone = device(server, { language: 'en', theme: 'dark', units: 'mm' });
    await phone.start();
    phone.edit('units.length', 'cm');
    await phone.client.flush();
    // The environment-picked language did not travel with it.
    expect(server.settings()).toEqual({ 'appearance.theme': 'light', 'units.length': 'cm' });
  });

  test('choosing the language on the device does sync it', async () => {
    const server = new FakeServer().withSettings({ 'appearance.theme': 'light' });
    const phone = device(server, { language: 'en', theme: 'dark', units: 'mm' });
    await phone.start();
    phone.edit('appearance.language', 'ru');
    phone.edit('appearance.language', 'en');
    await phone.client.flush();
    expect(server.settings()).toEqual({
      'appearance.theme': 'light',
      'appearance.language': 'en',
    });
  });

  test('a server value applies to the app store', async () => {
    const server = new FakeServer().withSettings({ 'appearance.language': 'en' });
    const desktop = device(server, { language: 'ru', theme: 'dark', units: 'mm' });
    await desktop.start();
    expect(desktop.state.language).toBe('en');
  });
});

describe('choices made before settings existed', () => {
  test('are synced when the server has no settings yet', async () => {
    const server = new FakeServer();
    const desktop = device(
      server,
      { language: 'ru', theme: 'light', units: 'in' },
      { chosen: ['theme', 'units'] },
    );
    await desktop.start();
    expect(server.settings()).toEqual({ 'appearance.theme': 'light', 'units.length': 'in' });
  });

  test('lose to the server when it already has settings', async () => {
    const server = new FakeServer().withSettings({ 'units.length': 'cm' });
    const laptop = device(
      server,
      { language: 'ru', theme: 'light', units: 'mm' },
      { chosen: ['theme'] },
    );
    await laptop.start();
    expect(laptop.state.theme).toBe('dark');
    expect(laptop.state.units).toBe('cm');
    expect(server.settings()).toEqual({ 'units.length': 'cm' });
  });

  test('are not synced blind while the server cannot be reached', async () => {
    const server = new FakeServer().withSettings({
      'appearance.theme': 'dark',
      'units.length': 'in',
    });
    server.online = false;
    const laptop = device(
      server,
      { language: 'ru', theme: 'light', units: 'mm' },
      { chosen: ['theme'] },
    );
    await laptop.start();
    expect(laptop.store.get('appearance.theme')).toBe('light');
    server.online = true;
    await laptop.client.sync();
    await laptop.client.flush();
    expect(server.puts).toEqual([]);
    expect(server.settings()).toEqual({ 'appearance.theme': 'dark', 'units.length': 'in' });
  });
});

describe('a device that has been synced before', () => {
  test("applies the mirrored settings at once and the server's newer ones after sync", async () => {
    const server = new FakeServer().withSettings({ 'appearance.theme': 'light' });
    const storage = new MemoryStorage();
    const first = device(server, { language: 'ru', theme: 'dark', units: 'mm' }, { storage });
    await first.start();
    server.withSettings({ 'appearance.theme': 'light', 'units.length': 'in' });

    const again = device(server, { language: 'ru', theme: 'dark', units: 'mm' }, { storage });
    expect(again.state.theme).toBe('light');
    expect(again.state.units).toBe('mm');
    await again.start();
    expect(again.state.units).toBe('in');
  });
});
