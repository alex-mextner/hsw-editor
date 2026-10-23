/**
 * Is the daemon reachable? One small state machine the whole UI reads (online/offline badge, replay
 * trigger) instead of every component guessing from its own failed fetch.
 *
 * Inputs: results of real API calls and of the event stream (`reportSuccess` / `reportFailure`), the browser's
 * online/offline events, and a cheap probe (`GET /api/health`) run with exponential backoff while offline.
 * `navigator.onLine` alone is not trusted: it says "connected to a network", not "the daemon answers", so a
 * stopped daemon on localhost is detected by failing calls and the probe.
 *
 * `failures` counts *probe* failures (plus the one that started the outage): it sets the backoff, so a burst
 * of failing fetches during an outage does not push the next probe to the cap.
 */
import { backoffDelay, defaultSchedule, type Schedule } from './timers.ts';

export type OfflineReason = 'network' | 'daemon';

export interface ConnectionState {
  readonly status: 'online' | 'offline';
  /** Why we think we are offline: no network at all, or the network is there but the daemon does not answer. */
  readonly reason: OfflineReason | null;
  /** Failed probes since the outage began (1 when it began). */
  readonly failures: number;
  /** Epoch ms of the last status change. */
  readonly since: number;
}

export interface ConnectionDeps {
  /** Resolves true when the daemon answered; false (or reject) when it did not. */
  readonly probe: () => Promise<boolean>;
  readonly browserOnline: () => boolean;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly schedule?: Schedule;
  /** A subscriber or reconnect listener threw; default `console.error`. Other listeners still run. */
  readonly onListenerError?: (error: unknown) => void;
}

export class ConnectionMonitor {
  private state: ConnectionState;
  private readonly listeners = new Set<() => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private cancel: (() => void) | null = null;
  private probing = false;
  private disposed = false;
  /** Bumped on every success: a probe that started before it must not undo the recovery. */
  private successEpoch = 0;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly schedule: Schedule;
  private readonly onListenerError: (error: unknown) => void;

  constructor(private readonly deps: ConnectionDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.onListenerError = deps.onListenerError ?? ((error) => console.error(error));
    this.state = { status: 'online', reason: null, failures: 0, since: this.now() };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ConnectionState => this.state;

  /** Called each time the daemon becomes reachable again after being offline. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /** A real request (or the event stream) reached the daemon. */
  reportSuccess(): void {
    this.successEpoch += 1;
    if (this.state.status === 'online') return;
    this.cancelTimer();
    this.set({ status: 'online', reason: null, failures: 0, since: this.now() });
    this.notify(this.reconnectListeners);
  }

  /** A real request failed because the daemon or the network was unreachable (not an API refusal). */
  reportFailure(): void {
    if (this.disposed) return;
    const reason = this.failureReason();
    if (this.state.status === 'offline' && this.state.reason === reason) return;
    this.set({
      status: 'offline',
      reason,
      failures: 1,
      since: this.state.status === 'offline' ? this.state.since : this.now(),
    });
    this.scheduleProbe();
  }

  /** `window` fired `offline`. */
  notifyBrowserOffline(): void {
    if (this.disposed) return;
    if (this.state.status === 'offline' && this.state.reason === 'network') return;
    this.set({
      status: 'offline',
      reason: 'network',
      failures: 1,
      since: this.state.status === 'offline' ? this.state.since : this.now(),
    });
    this.scheduleProbe();
  }

  /** `window` fired `online`: the network is back, find out whether the daemon is too. */
  notifyBrowserOnline(): void {
    if (this.state.status === 'offline') void this.probeNow();
  }

  /** Probes immediately (e.g. user pressed "retry"). */
  async probeNow(): Promise<void> {
    if (this.probing || this.disposed) return;
    this.probing = true;
    this.cancelTimer();
    const epoch = this.successEpoch;
    let ok = false;
    try {
      ok = await this.deps.probe();
    } catch {
      ok = false;
    } finally {
      this.probing = false;
    }
    if (this.disposed) return;
    if (ok) {
      this.reportSuccess();
    } else if (epoch === this.successEpoch) {
      this.probeFailed();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
    this.reconnectListeners.clear();
  }

  private failureReason(): OfflineReason {
    return this.deps.browserOnline() ? 'daemon' : 'network';
  }

  private probeFailed(): void {
    this.set({
      status: 'offline',
      reason: this.failureReason(),
      failures: this.state.failures + 1,
      since: this.state.status === 'offline' ? this.state.since : this.now(),
    });
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    this.cancelTimer();
    this.cancel = this.schedule(
      () => {
        this.cancel = null;
        void this.probeNow();
      },
      backoffDelay(this.state.failures, this.random()),
    );
  }

  private cancelTimer(): void {
    this.cancel?.();
    this.cancel = null;
  }

  private set(next: ConnectionState): void {
    this.state = next;
    this.notify(this.listeners);
  }

  private notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
