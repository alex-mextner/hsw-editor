/** Wires paths, guard store, backends and settings into one runtime used by routes, jobs and the CLI. */
import {
  type DrawBackend,
  type DrawBackendId,
  DrawError,
  type DrawRequest,
  type DrawResult,
  type DrawSettings,
  toFailure,
} from '@hsw-editor/draw';
import { type BrowserOptions, browserOptions } from './browser-process.ts';
import { type ChatgptBrowserConfig, ChatgptBrowserBackend } from './backends/chatgpt-browser.ts';
import { ManualBackend } from './backends/manual.ts';
import { OmpBackend, type OmpConfig, ompConfig } from './backends/omp.ts';
import { type GuardConfig, GuardStore, applyFailure, gate, recordHealthy } from './guard.ts';
import { envInt } from './env.ts';
import { type DrawPaths, resolveDrawPaths } from './paths.ts';
import { loadSettings, saveSettings } from './settings.ts';

/** Order tried by `auto`: sanctioned codex path first, then the browser, then a human. */
export const AUTO_ORDER: readonly DrawBackendId[] = ['omp', 'chatgpt-browser', 'manual'];

/** In `auto`, only these failures fall through to the next backend. quota/challenge stop: the same
 * ChatGPT plan may sit behind both, and a captcha needs a human, never another try. */
const FALLTHROUGH: ReadonlySet<string> = new Set(['login_required', 'backend_unavailable']);

export interface DrawRuntime {
  readonly paths: DrawPaths;
  readonly store: GuardStore;
  readonly omp: OmpConfig;
  readonly chatgpt: ChatgptBrowserConfig;
  readonly backends: Readonly<Record<DrawBackendId, DrawBackend>>;
  getSettings(): Promise<DrawSettings>;
  setSettings(settings: DrawSettings): Promise<void>;
  /** Run one request through the chosen backend (or the auto chain); failures are values. */
  run(req: DrawRequest, signal: AbortSignal, forced?: DrawBackendId): Promise<DrawResult>;
}

export interface RuntimeOverrides {
  readonly env?: NodeJS.ProcessEnv;
  readonly browser?: Partial<BrowserOptions>;
  readonly baseUrl?: string;
  readonly chatgptGuard?: GuardConfig;
  readonly omp?: OmpConfig;
  readonly stopWhenDone?: boolean;
  /** Replace backends (unit tests inject fakes). */
  readonly backends?: Partial<Record<DrawBackendId, DrawBackend>>;
}

export function createDrawRuntime(overrides: RuntimeOverrides = {}): DrawRuntime {
  const env = overrides.env ?? process.env;
  const paths = resolveDrawPaths(env);
  const store = new GuardStore(paths.guardFile);
  const omp = overrides.omp ?? ompConfig(env);
  const chatgpt: ChatgptBrowserConfig = {
    browser: {
      ...browserOptions(paths.chatgptProfileDir, paths.drawDir, env),
      ...overrides.browser,
    },
    baseUrl: overrides.baseUrl ?? env['HSW_CHATGPT_BASE_URL'] ?? 'https://chatgpt.com',
    guard: overrides.chatgptGuard ?? {
      minIntervalMs: envInt(env, 'HSW_DRAW_MIN_INTERVAL_MS', 60_000),
      dailyCap: envInt(env, 'HSW_DRAW_DAILY_CAP', 30, 1),
    },
    ownerLockFile: paths.chatgptLockFile,
    stopWhenDone: overrides.stopWhenDone ?? true,
  };
  const backends: Record<DrawBackendId, DrawBackend> = {
    omp: new OmpBackend(store, omp),
    'chatgpt-browser': new ChatgptBrowserBackend(store, chatgpt),
    manual: new ManualBackend(),
    ...overrides.backends,
  };
  const guardConfigs: Record<DrawBackendId, GuardConfig> = {
    omp: omp.guard,
    'chatgpt-browser': chatgpt.guard,
    manual: { minIntervalMs: 0, dailyCap: Number.MAX_SAFE_INTEGER },
  };

  async function runOne(
    id: DrawBackendId,
    req: DrawRequest,
    signal: AbortSignal,
  ): Promise<DrawResult> {
    try {
      if (id !== 'manual') {
        const decision = gate(await store.get(id), guardConfigs[id], Date.now(), req.n);
        if (decision.kind === 'blocked') {
          throw new DrawError(decision.code, decision.message, {
            retryable: decision.code === 'quota_exhausted',
            ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
          });
        }
      }
      const result = await backends[id].draw(req, signal);
      if (result.ok && id !== 'manual') await store.update(id, (g) => recordHealthy(g, Date.now()));
      return result;
    } catch (error) {
      if (!(error instanceof DrawError)) throw error;
      if (id !== 'manual') await store.update(id, (g) => applyFailure(g, error, Date.now()));
      return toFailure(id, req.tag, error);
    }
  }

  return {
    paths,
    store,
    omp,
    chatgpt,
    backends,
    getSettings: () => loadSettings(paths.settingsFile),
    setSettings: (settings) => saveSettings(paths.settingsFile, settings),
    async run(req, signal, forced) {
      const choice = forced ?? (await loadSettings(paths.settingsFile)).backend;
      if (choice !== 'auto') return runOne(choice, req, signal);
      let last: DrawResult | undefined;
      for (const id of AUTO_ORDER) {
        last = await runOne(id, req, signal);
        if (last.ok || !FALLTHROUGH.has(last.error.code)) return last;
      }
      return (
        last ?? toFailure('manual', req.tag, new DrawError('backend_unavailable', 'no backend'))
      );
    },
  };
}
