import type { SettingsStore, SettingValue } from '@hsw-editor/commands';
import { isDeviceLocalSetting } from './appSettings.ts';

type Overrides = Readonly<Record<string, SettingValue>>;

/**
 * Which setting values stay on this device instead of travelling in the synced `settings`
 * namespace: panel visibility (always) and values the environment picked (the browser language)
 * until the user changes them or the server supplies one.
 */
export class DeviceSettings {
  /** Environment-picked ids with the value they were given. */
  private readonly derived = new Map<string, SettingValue>();
  private adopting = false;

  /** Starts watching `store`: any later change of a value ends its "environment-picked" status. */
  attach(store: SettingsStore): () => void {
    return store.subscribe((id) => {
      if (this.adopting || !this.derived.has(id)) return;
      // `SettingsStore.load` notifies every id it touched, changed or not: only a different value is the user's.
      if (store.get(id) !== this.derived.get(id)) this.derived.delete(id);
    });
  }

  /** Stores an environment-picked value without letting it count as the user's change. */
  keep(id: string, store: SettingsStore, value: SettingValue): void {
    this.adopting = true;
    this.derived.set(id, value);
    try {
      store.set(id, value);
    } finally {
      this.adopting = false;
    }
  }

  isLocal(id: string): boolean {
    return isDeviceLocalSetting(id) || this.derived.has(id);
  }

  /** The overrides that belong in the synced document. */
  synced(overrides: Overrides): Overrides {
    return Object.fromEntries(Object.entries(overrides).filter(([id]) => !this.isLocal(id)));
  }

  /**
   * A document received from the server with this device's own values kept: panels always, an
   * environment-picked value unless the server has one. Whatever the server states ends the
   * "environment-picked" status of its ids.
   */
  merge(received: unknown, overrides: Overrides): Readonly<Record<string, unknown>> {
    const remote =
      typeof received === 'object' && received !== null && !Array.isArray(received)
        ? Object.entries(received).filter(([id]) => !isDeviceLocalSetting(id))
        : [];
    const remoteIds = new Set(remote.map(([id]) => id));
    for (const id of remoteIds) this.derived.delete(id);
    const local = Object.entries(overrides).filter(
      ([id]) => isDeviceLocalSetting(id) || (this.derived.has(id) && !remoteIds.has(id)),
    );
    return Object.fromEntries([...remote, ...local]);
  }
}
