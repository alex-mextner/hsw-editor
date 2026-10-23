/**
 * "A new version is ready" flow. A freshly built service worker installs and then *waits*; the old one keeps
 * controlling the page until the user accepts, so an update never reloads the tab in the middle of an edit.
 *
 *   idle --(new worker installed)--> ready --accept()--> applying --(new worker controls)--> reload
 *
 * `accept()` first runs `beforeApply` (the editor flushes its offline mirror and queue to IndexedDB), then asks
 * the waiting worker to `skipWaiting`, then reloads once it controls the page. A reload is only ever done for an
 * update the user accepted: the very first install claims the page without reloading it.
 *
 * Browser APIs come in through `UpdateChannel` (an adapter over `workbox-window`), so the state machine is
 * tested without a service worker.
 */

export interface UpdateChannel {
  /** Registers the worker; resolves with the registration (undefined when unsupported). */
  register(): Promise<ServiceWorkerRegistration | undefined>;
  /** A newer worker finished installing and waits. */
  onWaiting(listener: () => void): void;
  /** A worker became active; `isUpdate` is false for the very first install. */
  onActivated(listener: (isUpdate: boolean) => void): void;
  /** A worker took control of this page. */
  onControlling(listener: () => void): void;
  /** Is a newer worker still waiting? False once another tab already applied the update. */
  hasWaiting(): boolean;
  /** Tell the waiting worker to take over. */
  skipWaiting(): void;
}

export interface UpdateState {
  readonly status: 'idle' | 'ready' | 'applying';
  /** The toast was closed with "later"; the settings panel still offers the update. */
  readonly dismissed: boolean;
  /** The first install finished: the app now works offline ("ready to work offline" notice). */
  readonly offlineReady: boolean;
  readonly error: string | null;
}

export interface UpdateDeps {
  readonly channel: UpdateChannel;
  /** Runs before the new worker takes over (flush offline state). Failures abort the update. */
  readonly beforeApply?: () => Promise<void>;
  readonly reload: () => void;
}

export class UpdateController {
  private state: UpdateState = {
    status: 'idle',
    dismissed: false,
    offlineReady: false,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private registration: ServiceWorkerRegistration | undefined;

  constructor(private readonly deps: UpdateDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): UpdateState => this.state;

  async start(): Promise<void> {
    const { channel } = this.deps;
    channel.onWaiting(() => {
      if (this.state.status === 'applying') return;
      this.set({ status: 'ready', dismissed: false, error: null });
    });
    channel.onActivated((isUpdate) => {
      if (!isUpdate) this.set({ offlineReady: true });
    });
    channel.onControlling(() => {
      if (this.state.status === 'applying') this.deps.reload();
    });
    this.registration = await channel.register();
  }

  /** Asks the browser to look for a newer worker now (periodic check, "check for updates" button). */
  async checkForUpdate(): Promise<void> {
    await this.registration?.update();
  }

  /** The user accepted: persist offline state, then switch to the new version. */
  async accept(): Promise<void> {
    if (this.state.status !== 'ready') return;
    this.set({ status: 'applying', error: null });
    try {
      await this.deps.beforeApply?.();
    } catch (error) {
      this.set({
        status: 'ready',
        error: error instanceof Error ? error.message : 'could not save the offline state',
      });
      return;
    }
    // Another tab may already have applied this update: nothing is waiting any more and `controlling` will not fire
    // again here, so reload straight onto the new version instead of waiting for it.
    if (this.deps.channel.hasWaiting()) this.deps.channel.skipWaiting();
    else this.deps.reload();
  }

  /** "Later": hide the toast, keep the update pending. */
  dismiss(): void {
    if (this.state.status === 'ready') this.set({ dismissed: true });
  }

  acknowledgeOfflineReady(): void {
    this.set({ offlineReady: false });
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Looks for a new version every hour and whenever the tab becomes visible again, but only while online
 * (an offline `update()` would fail and spam the console). Returns a function that stops the checks.
 */
export function scheduleUpdateChecks(
  controller: Pick<UpdateController, 'checkForUpdate'>,
  env: {
    readonly isOnline: () => boolean;
    readonly isVisible: () => boolean;
    readonly every: (fn: () => void, ms: number) => () => void;
    readonly onVisibility: (fn: () => void) => () => void;
  },
): () => void {
  const check = (): void => {
    if (env.isOnline()) void controller.checkForUpdate().catch(() => undefined);
  };
  const stopTimer = env.every(check, UPDATE_CHECK_INTERVAL_MS);
  const stopVisibility = env.onVisibility(() => {
    if (env.isVisible()) check();
  });
  return () => {
    stopTimer();
    stopVisibility();
  };
}
