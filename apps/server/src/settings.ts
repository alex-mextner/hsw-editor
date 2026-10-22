/**
 * Per-user settings file (`<home>/settings.json`). The daemon is the single writer: PUTs are serialized through one
 * promise chain, the document is cached in memory after the first load, and every write is atomic (tmp + fsync +
 * rename, mode 0600). A corrupt file is moved aside to `settings.json.corrupt-<ts>` and defaults are served.
 */
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  applySettingsPut,
  defaultSettingsDocument,
  parseSettingsDocument,
  SettingsContractError,
  type SettingsDocument,
  type SettingsPutBody,
} from '@hsw-editor/user-settings';
import { atomicWrite, isNotFound } from './store/fsutil.ts';

/** Settings are per-user: owner read/write only. */
const SETTINGS_FILE_MODE = 0o600;

export class SettingsConflictError extends Error {
  constructor(readonly settings: SettingsDocument) {
    super(`settings are at rev ${settings.rev}, baseRev was stale`);
  }
}

export interface SettingsStoreOptions {
  home: string;
  now?: () => Date;
}

export class SettingsStore {
  readonly path: string;
  private readonly now: () => Date;
  private cached: SettingsDocument | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(document: SettingsDocument) => void>();

  constructor(options: SettingsStoreOptions) {
    this.path = join(options.home, 'settings.json');
    this.now = options.now ?? (() => new Date());
  }

  get(): Promise<SettingsDocument> {
    // The cache is only replaced after a successful write, so a reader never needs to queue behind an fsync.
    if (this.cached !== undefined) return Promise.resolve(this.cached);
    return this.serialize(() => this.load());
  }

  /** Merges `body` into the document; rejects with `SettingsConflictError` on a stale `baseRev`. */
  put(body: SettingsPutBody): Promise<SettingsDocument> {
    return this.serialize(async () => {
      const current = await this.load();
      if (body.baseRev !== undefined && body.baseRev !== current.rev) {
        throw new SettingsConflictError(current);
      }
      const next = applySettingsPut(current, body, this.now());
      if (next === current) return current;
      await atomicWrite(this.path, `${JSON.stringify(next, null, 2)}\n`, {
        mode: SETTINGS_FILE_MODE,
      });
      this.cached = next;
      for (const listener of this.listeners) {
        try {
          listener(next);
        } catch (error) {
          console.error('hsw-editor: settings listener threw', error);
        }
      }
      return next;
    });
  }

  /** Calls `listener` after every accepted write. Returns the unsubscribe function. */
  subscribe(listener: (document: SettingsDocument) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<SettingsDocument> {
    if (this.cached !== undefined) return this.cached;
    let text: string;
    try {
      text = await Bun.file(this.path).text();
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.cached = defaultSettingsDocument();
      return this.cached;
    }
    try {
      this.cached = parseSettingsDocument(JSON.parse(text));
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof SettingsContractError)) throw error;
      const aside = `${this.path}.corrupt-${this.now().toISOString().replace(/[:.]/g, '-')}`;
      await rename(this.path, aside);
      console.error(`hsw-editor: settings file is corrupt, moved to ${aside}; serving defaults`);
      this.cached = defaultSettingsDocument();
    }
    return this.cached;
  }
}
