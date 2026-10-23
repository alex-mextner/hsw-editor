import type { SettingsStore } from '@hsw-editor/commands';
import type { SettingsClient } from '@hsw-editor/user-settings';
import { isDeviceLocalSetting } from './appSettings.ts';
import { DeviceSettings } from './deviceSettings.ts';
import { persistNamespaces } from './persistence.ts';
import {
  adoptAppValues,
  bridgeSettings,
  type DocumentState,
  type SettingBinding,
} from './settingsBridge.ts';

export const SETTINGS_NAMESPACE = 'settings';

export interface SettingsWiring {
  readonly dispose: () => void;
  /** Call once the first server contact has settled (answered or failed). */
  readonly adopt: () => void;
}

function documentState(client: SettingsClient): DocumentState {
  if (client.get(SETTINGS_NAMESPACE) !== undefined) return 'present';
  return client.serverRev() === null ? 'unknown' : 'none';
}

/**
 * The settings store, its synced namespace and the app stores that already own the values. The
 * server's document always wins over this device's guesses: nothing the app derived from its
 * environment is written to the server, so a new device never erases what other devices stored.
 */
export function wireSettings(
  client: SettingsClient,
  store: SettingsStore,
  bindings: readonly SettingBinding[],
): SettingsWiring {
  const device = new DeviceSettings();
  const stopDevice = device.attach(store);
  const unpersist = persistNamespaces(client, [
    {
      namespace: SETTINGS_NAMESPACE,
      read: () => {
        const synced = device.synced(store.overrides());
        return Object.keys(synced).length === 0 ? undefined : synced;
      },
      write: (value) => store.load(device.merge(value, store.overrides())),
      subscribe: (listener) => store.subscribe(listener),
    },
  ]);
  const unbridge = bridgeSettings(store, bindings);
  return {
    adopt: () =>
      adoptAppValues(store, bindings, {
        document: documentState(client),
        storeOnDevice: (id, value) => device.keep(id, store, value),
        isDeviceOnly: isDeviceLocalSetting,
      }),
    dispose: () => {
      unbridge();
      unpersist();
      stopDevice();
    },
  };
}
