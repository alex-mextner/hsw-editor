/**
 * One owner of "is the daemon reachable?": the event stream feeds the connection monitor and the monitor drives
 * the stream.
 *
 *   stream opens          -> monitor.reportSuccess()  (the strongest "daemon answers" signal there is)
 *   stream goes down      -> monitor.reportFailure()
 *   monitor reconnects    -> stream.reconnectNow()    (a probe or API call got through: do not wait for the backoff)
 *
 * Without this link a daemon restart is seen by two independent state machines: the badge could stay "online" while
 * the stream is dead, and a recovered probe would leave the stream backing off for up to 30 s more. `monitor.onReconnect`
 * is also where the editor starts the queue replay, so the stream opening is what triggers it after a restart.
 */
import type { ConnectionMonitor } from './connection.ts';
import { ReconnectingSource, type ReconnectingSourceOptions } from './events.ts';

export interface LiveLink {
  readonly source: ReconnectingSource;
  /** Closes the stream and detaches from the monitor. */
  dispose(): void;
}

export function createLiveSource(
  options: ReconnectingSourceOptions,
  monitor: ConnectionMonitor,
): LiveLink {
  const source = new ReconnectingSource({
    ...options,
    onOpen: (resumed) => {
      monitor.reportSuccess();
      options.onOpen?.(resumed);
    },
    onDown: () => {
      monitor.reportFailure();
      options.onDown?.();
    },
  });
  const detach = monitor.onReconnect(() => source.reconnectNow());
  return {
    source,
    dispose: () => {
      detach();
      source.close();
    },
  };
}
