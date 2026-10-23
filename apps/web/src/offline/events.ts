/**
 * Server-sent events that survive a daemon restart.
 *
 * A bare `EventSource` reconnects by itself (sending `Last-Event-ID`) while the connection merely drops,
 * but it gives up for good when the reply is a non-200 (a reverse proxy answering 502 while the daemon
 * restarts) and it never notices a half-open socket. This wrapper
 *   - recreates the source after such a failure, resuming with `?since=<last rev>` so no op is missed
 *     (docs/api.md "Resume"),
 *   - treats silence longer than a few heartbeats (the daemon sends one every 15 s) as a dead connection,
 *   - reconnects at once when the browser reports the network is back or the tab becomes visible,
 *   - backs off exponentially (same curve as the connection probe) between attempts.
 */
import { backoffDelay, defaultSchedule, type Schedule } from './timers.ts';

/** The slice of `EventSource` this wrapper uses; tests pass a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export const EVENT_SOURCE_CLOSED = 2;
/** Three missed 15 s heartbeats. */
export const DEFAULT_STALE_AFTER_MS = 45_000;

export interface ReconnectingSourceOptions {
  /** Builds the stream URL; `since` is the last rev seen (`null` before the first event). */
  readonly url: (since: number | null) => string;
  readonly create: (url: string) => EventSourceLike;
  /** Named events to forward (`snapshot`, `op`, `heartbeat`, ...). */
  readonly events: readonly string[];
  readonly onEvent: (name: string, data: string) => void;
  /** The stream is open; `resumed` is true for every open after the first. */
  readonly onOpen?: (resumed: boolean) => void;
  /** The stream went down (error or silence); a reconnect is already scheduled. */
  readonly onDown?: () => void;
  readonly staleAfterMs?: number;
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  readonly random?: () => number;
}

export class ReconnectingSource {
  private source: EventSourceLike | null = null;
  private lastRev: number | null = null;
  private failures = 0;
  private opened = false;
  private everOpened = false;
  private closed = false;
  private cancelRetry: (() => void) | null = null;
  private cancelWatchdog: (() => void) | null = null;
  private readonly staleAfterMs: number;
  private readonly schedule: Schedule;
  private readonly random: () => number;

  constructor(private readonly options: ReconnectingSourceOptions) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** Last rev seen on the stream (`null` before the first event). */
  get lastEventRev(): number | null {
    return this.lastRev;
  }

  start(): void {
    if (this.closed || this.source || this.cancelRetry) return;
    this.connect();
  }

  /** Reconnect now (network came back, tab visible) unless a healthy stream is running. */
  reconnectNow(): void {
    if (this.closed) return;
    this.cancelRetryTimer();
    if (this.source && this.source.readyState !== EVENT_SOURCE_CLOSED && this.opened) return;
    this.teardownSource();
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.cancelRetryTimer();
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
    this.teardownSource();
  }

  private connect(): void {
    const source = this.options.create(this.options.url(this.lastRev));
    this.source = source;
    this.opened = false;
    this.armWatchdog();
    source.addEventListener('open', () => {
      if (this.source !== source) return;
      const resumed = this.everOpened;
      this.everOpened = true;
      this.opened = true;
      this.failures = 0;
      this.armWatchdog();
      this.options.onOpen?.(resumed);
    });
    source.addEventListener('error', () => {
      if (this.source !== source) return;
      // CONNECTING: the browser retries on its own (and sends Last-Event-ID). CLOSED: it gave up.
      if (source.readyState === EVENT_SOURCE_CLOSED) this.down();
    });
    for (const name of this.options.events) {
      source.addEventListener(name, (event) => {
        if (this.source !== source) return;
        this.armWatchdog();
        if (!(event instanceof MessageEvent) || typeof event.data !== 'string') return;
        const rev = Number.parseInt(event.lastEventId, 10);
        // A `snapshot` is the daemon's word for where the wall is now, even if that is *lower* than what we
        // saw (restored backup); otherwise only newer revs raise the resume position.
        if (
          Number.isInteger(rev) &&
          (name === 'snapshot' || this.lastRev === null || rev > this.lastRev)
        ) {
          this.lastRev = rev;
        }
        this.options.onEvent(name, event.data);
      });
    }
  }

  private armWatchdog(): void {
    this.cancelWatchdog?.();
    this.cancelWatchdog = this.schedule(() => {
      this.cancelWatchdog = null;
      if (!this.closed) this.down();
    }, this.staleAfterMs);
  }

  private down(): void {
    this.teardownSource();
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
    this.failures += 1;
    this.options.onDown?.();
    this.cancelRetryTimer();
    this.cancelRetry = this.schedule(
      () => {
        this.cancelRetry = null;
        if (!this.closed) this.connect();
      },
      backoffDelay(this.failures, this.random()),
    );
  }

  private teardownSource(): void {
    this.source?.close();
    this.source = null;
    this.opened = false;
  }

  private cancelRetryTimer(): void {
    this.cancelRetry?.();
    this.cancelRetry = null;
  }
}
