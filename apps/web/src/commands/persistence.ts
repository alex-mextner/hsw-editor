/**
 * Links in-memory stores to namespaces of the per-user settings document (offline-first client:
 * local mirror now, server when reachable). Each link is two-way and guarded by JSON equality, so
 * a value arriving from the server never bounces back as a new edit.
 */
import type { JsonValue } from '@hsw-editor/core';
import {
  jsonEqual,
  SettingsValueSchema,
  type SettingsClient,
  type SettingsValue,
  type SyncStatus,
} from '@hsw-editor/user-settings';

export interface PersistedNamespace {
  readonly namespace: string;
  /** The value to store, or undefined when the store holds nothing but defaults. */
  readonly read: () => unknown;
  /** Applies a stored value; undefined means the namespace is gone and defaults apply. */
  readonly write: (value: JsonValue | undefined) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/** Drops what JSON cannot carry (undefined members) and proves the result is a settings value. */
export function toSettingsValue(value: unknown): SettingsValue {
  return SettingsValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

function link(client: SettingsClient, entry: PersistedNamespace): () => void {
  let applying = false;
  // What the last remote apply left in the store. A backend that delivers notifications later (state-lib,
  // in a microtask) runs push after `applying` is cleared, so an unchanged store is still "not a user edit".
  let applied: { readonly value: SettingsValue | undefined } | null = null;
  const settled = (): SettingsValue | undefined => {
    const value = entry.read();
    return value === undefined ? undefined : toSettingsValue(value);
  };
  const push = (): void => {
    if (applying) return;
    if (applied !== null) {
      if (jsonEqual(settled(), applied.value)) return;
      applied = null;
    }
    const value = entry.read();
    const stored = client.get(entry.namespace);
    if (value === undefined) {
      if (stored !== undefined) client.remove(entry.namespace);
      return;
    }
    const next = toSettingsValue(value);
    if (!jsonEqual(next, stored)) client.set(entry.namespace, next);
  };
  const apply = (value: JsonValue | undefined): void => {
    applying = true;
    try {
      entry.write(value);
      applied = { value: settled() };
    } finally {
      applying = false;
    }
  };
  const stored = client.get(entry.namespace);
  if (stored !== undefined) apply(stored);
  applied = null;
  // What only this device knows (an old localStorage theme, usage before the first sync) is stored.
  push();
  const stopClient = client.subscribe(entry.namespace, apply);
  const stopEntry = entry.subscribe(push);
  return () => {
    stopClient();
    stopEntry();
  };
}

/** Links every namespace; the returned function unlinks them all. */
export function persistNamespaces(
  client: SettingsClient,
  entries: readonly PersistedNamespace[],
): () => void {
  const stops = entries.map((entry) => link(client, entry));
  return () => {
    for (const stop of stops) stop();
  };
}

export interface ServerSync {
  /** Settles when the first contact with the server has finished, answered or failed. */
  readonly ready: Promise<SyncStatus>;
  readonly dispose: () => void;
}

export interface ServerSyncEnvironment {
  readonly eventsUrl: string;
  readonly createEventSource: (url: string) => EventSource;
  readonly addWindowListener: (type: 'online', listener: () => void) => () => void;
}

function readRev(raw: Event): number | null {
  if (!(raw instanceof MessageEvent) || typeof raw.data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw.data);
    const rev = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'rev') : null;
    return typeof rev === 'number' && Number.isInteger(rev) ? rev : null;
  } catch {
    return null;
  }
}

/** Pulls on start and on `online`, and follows the server's change events; an absent server is fine. */
export function startServerSync(client: SettingsClient, env: ServerSyncEnvironment): ServerSync {
  const ready = client.sync();
  const stopOnline = env.addWindowListener('online', () => void client.sync());
  let source: EventSource | null = null;
  try {
    source = env.createEventSource(env.eventsUrl);
    source.addEventListener('settings', (raw) => {
      const rev = readRev(raw);
      if (rev !== null) void client.notifyServerRev(rev);
    });
  } catch {
    // No EventSource (or a blocked one): the start and online syncs still keep the document fresh.
  }
  return {
    ready,
    dispose: () => {
      stopOnline();
      source?.close();
    },
  };
}
