import type { SettingsStore, SettingValue } from '@hsw-editor/commands';

/** One setting mirrored by an existing app store (theme, locale, snap, units, view, panels). */
export interface SettingBinding {
  readonly id: string;
  readonly read: () => SettingValue;
  readonly write: (value: SettingValue) => void;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Whether the app store holds a value the user chose (a saved theme) rather than one the
   * environment picked (the browser language). Only the former may become a synced setting.
   */
  readonly userChoice?: () => boolean;
}

/**
 * Keeps the settings store and the app stores that already own these values in step, both ways.
 * Every write is guarded by an equality check, which is what stops the two sides echoing forever.
 *
 * Stored settings win at start; the app stores' own values are only adopted later, once the
 * server has had its say ({@link adoptAppValues}).
 */
export function bridgeSettings(
  store: SettingsStore,
  bindings: readonly SettingBinding[],
): () => void {
  const byId = new Map(bindings.map((binding) => [binding.id, binding] as const));
  // Several settings can live in one app store (snap and view mode share the editor store), and
  // `SettingsStore.load` announces them one by one. While a write into the app is in progress the
  // app stores' notifications are not user edits: acting on them would read the app's half-updated
  // state and revert the value that is still on its way.
  let applying = false;
  const toApp = (binding: SettingBinding, value: SettingValue): void => {
    const was = applying;
    applying = true;
    try {
      binding.write(value);
    } finally {
      applying = was;
    }
  };
  for (const binding of bindings) {
    if (!store.isDefault(binding.id)) toApp(binding, store.get(binding.id));
  }
  const stopStore = store.subscribe((id) => {
    const binding = byId.get(id);
    if (binding === undefined) return;
    const value = store.get(id);
    if (binding.read() !== value) toApp(binding, value);
  });
  const stopBindings = bindings.map((binding) =>
    binding.subscribe(() => {
      if (applying) return;
      const value = binding.read();
      if (store.get(binding.id) !== value) store.set(binding.id, value);
    }),
  );
  return () => {
    stopStore();
    for (const stop of stopBindings) stop();
  };
}

/** What is known about the synced `settings` namespace when the app's own values are reconciled. */
export type DocumentState = 'none' | 'present' | 'unknown';

export interface AdoptOptions {
  /**
   * `present`: the namespace exists (server or this device's mirror). `none`: the server was
   * reached and has none. `unknown`: the server was never reached, so one may exist.
   */
  readonly document: DocumentState;
  /** Stores a value that must stay on this device until the user changes it (or the server has one). */
  readonly storeOnDevice: (id: string, value: SettingValue) => void;
  /** Device-only settings (panel layout) are adopted whatever the server holds. */
  readonly isDeviceOnly: (id: string) => boolean;
}

/**
 * After the first contact with the server: reconciles settings still at their default with the app
 * stores, which hold the value the user actually sees.
 *
 * - The server has no document and the user chose the app value earlier (a saved theme): it becomes
 *   a setting and is synced, so choices made before settings existed are not lost.
 * - The value comes from the environment (the browser language), or the server could not be asked
 *   (a synced write could erase what it holds): it is shown as the setting but stays on this
 *   device until the user changes it.
 * - A document exists and says "default": the server wins and the app store follows.
 */
export function adoptAppValues(
  store: SettingsStore,
  bindings: readonly SettingBinding[],
  options: AdoptOptions,
): void {
  for (const binding of bindings) {
    if (!store.isDefault(binding.id)) continue;
    const value = binding.read();
    if (store.get(binding.id) === value) continue;
    const chosen = binding.userChoice?.() === true;
    if (options.isDeviceOnly(binding.id)) store.set(binding.id, value);
    else if (chosen && options.document === 'none') store.set(binding.id, value);
    else if (chosen && options.document === 'present') binding.write(store.get(binding.id));
    else options.storeOnDevice(binding.id, value);
  }
}
