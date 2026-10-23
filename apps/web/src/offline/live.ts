/**
 * One owner of "is the daemon reachable?": the event stream informs the connection monitor and the monitor
 * drives the stream.
 *
 *   stream opens          -> monitor.reportSuccess()  (the strongest "daemon answers" signal there is)
 *   stream breaks         -> monitor.probeNow()       (ask the daemon; a stream error alone does not say why it failed)
 *   monitor reconnects    -> stream.reconnectNow()    (a probe or API call got through: do not wait for the backoff)
 *
 * A broken stream is *not* reported as "daemon down" directly: a wall deleted on the server makes its stream answer
 * 404 forever while the daemon is perfectly healthy, and calling that an outage would flip the badge and restart the
 * replay in a loop. The probe (`/api/health`) tells the two apart; the stream keeps its own backoff meanwhile.
 *
 * `monitor.onReconnect` is also where the editor starts the queue replay, so the stream opening after a daemon
 * restart is what triggers it.
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
  // While offline the monitor probes on its own schedule; extra probes would only defeat its backoff.
  const check = (): void => {
    if (monitor.getSnapshot().status === 'online') void monitor.probeNow();
  };
  const source = new ReconnectingSource({
    ...options,
    onOpen: (resumed) => {
      monitor.reportSuccess();
      options.onOpen?.(resumed);
    },
    onDown: () => {
      check();
      options.onDown?.();
    },
    onInterrupted: () => {
      check();
      options.onInterrupted?.();
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
