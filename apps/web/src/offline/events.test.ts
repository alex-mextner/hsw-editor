import { describe, expect, test } from 'bun:test';
import { ReconnectingSource } from './events.ts';
import { FakeSource } from './testing.ts';

function harness(staleAfterMs = 45_000) {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const received: [string, string][] = [];
  const opens: boolean[] = [];
  let downs = 0;
  const source = new ReconnectingSource({
    url: (since) => `/events${since === null ? '' : `?since=${since}`}`,
    create: (url) => {
      const fake = new FakeSource(url);
      sources.push(fake);
      return fake;
    },
    events: ['snapshot', 'op', 'heartbeat'],
    onEvent: (name, data) => received.push([name, data]),
    onOpen: (resumed) => opens.push(resumed),
    onDown: () => {
      downs += 1;
    },
    staleAfterMs,
    random: () => 0,
    schedule: (fn, ms) => {
      const timer = {
        ms,
        cancelled: false,
        fn: () => {
          timer.cancelled = true;
          fn();
        },
      };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const live = (ms?: number) =>
    timers.filter((t) => !t.cancelled && (ms === undefined || t.ms === ms));
  return { source, sources, timers, received, opens, downs: () => downs, live };
}

describe('ReconnectingSource', () => {
  test('connects without since, forwards named events and tracks the last rev', () => {
    const h = harness();
    h.source.start();
    expect(h.sources.map((s) => s.url)).toEqual(['/events']);
    h.sources[0]?.open();
    h.sources[0]?.emit('op', '{"rev":4}', '4');
    h.sources[0]?.emit('heartbeat', '{"rev":4}');
    expect(h.received).toEqual([
      ['op', '{"rev":4}'],
      ['heartbeat', '{"rev":4}'],
    ]);
    expect(h.source.lastEventRev).toBe(4);
    expect(h.opens).toEqual([false]);
  });

  test('when the browser gives up (502 while the daemon restarts) it reconnects with ?since=<last rev>', () => {
    const h = harness();
    h.source.start();
    h.sources[0]?.open();
    h.sources[0]?.emit('op', '{}', '7');
    h.sources[0]?.fail();
    expect(h.downs()).toBe(1);
    expect(h.sources).toHaveLength(1);
    // Retry after the first backoff step.
    const retry = h.live(1000)[0];
    expect(retry).toBeDefined();
    retry?.fn();
    expect(h.sources.map((s) => s.url)).toEqual(['/events', '/events?since=7']);
    h.sources[1]?.open();
    expect(h.opens).toEqual([false, true]);
  });

  test('keeps backing off while the daemon stays down and resets after an open', () => {
    const h = harness();
    h.source.start();
    h.sources[0]?.fail();
    h.live(1000)[0]?.fn();
    h.sources[1]?.fail();
    expect(h.live(2000)).toHaveLength(1);
    h.live(2000)[0]?.fn();
    h.sources[2]?.open();
    h.sources[2]?.fail();
    expect(h.live(1000)).toHaveLength(1);
  });

  test('a browser-level retry (readyState CONNECTING) is left to the browser', () => {
    const h = harness();
    h.source.start();
    const [first] = h.sources;
    if (!first) throw new Error('no source');
    first.open();
    first.readyState = 0;
    first.emit('error');
    expect(h.downs()).toBe(0);
    expect(h.sources).toHaveLength(1);
  });

  test('silence longer than the stale limit is treated as a dead connection', () => {
    const h = harness(45_000);
    h.source.start();
    h.sources[0]?.open();
    const watchdog = h.live(45_000)[0];
    watchdog?.fn();
    expect(h.sources[0]?.closedByClient).toBe(true);
    expect(h.downs()).toBe(1);
  });

  test('every event re-arms the watchdog', () => {
    const h = harness(45_000);
    h.source.start();
    h.sources[0]?.open();
    const before = h.live(45_000)[0];
    h.sources[0]?.emit('heartbeat', '{"rev":1}');
    expect(before?.cancelled).toBe(true);
    expect(h.live(45_000)).toHaveLength(1);
  });

  test('reconnectNow replaces a connecting source but leaves a healthy one alone', () => {
    const h = harness();
    h.source.start();
    h.source.reconnectNow();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0]?.closedByClient).toBe(true);
    h.sources[1]?.open();
    h.source.reconnectNow();
    expect(h.sources).toHaveLength(2);
  });

  test('after close() the events of the old source are ignored', () => {
    const h = harness();
    h.source.start();
    h.sources[0]?.open();
    h.source.close();
    h.sources[0]?.emit('op', '{}', '9');
    expect(h.received).toEqual([]);
  });

  test('close stops every timer and never reconnects', () => {
    const h = harness();
    h.source.start();
    h.sources[0]?.fail();
    h.source.close();
    expect(h.live()).toEqual([]);
    expect(h.sources).toHaveLength(1);
  });

  test('a snapshot resets the resume position even when it is lower (wall restored from a backup)', () => {
    const h = harness();
    h.source.start();
    h.sources[0]?.open();
    h.sources[0]?.emit('op', '{}', '50');
    h.sources[0]?.emit('snapshot', '{}', '10');
    expect(h.source.lastEventRev).toBe(10);
    h.sources[0]?.emit('op', '{}', '11');
    h.sources[0]?.emit('op', '{}', '9'); // an older op never lowers the position
    expect(h.source.lastEventRev).toBe(11);
    h.sources[0]?.fail();
    h.live(1000)[0]?.fn();
    expect(h.sources.at(-1)?.url).toBe('/events?since=11');
  });

  test('start() while a retry is pending does not open a second connection', () => {
    const h = harness();
    h.source.start();
    h.sources[0]?.fail();
    h.source.start();
    expect(h.sources).toHaveLength(1);
    h.live(1000)[0]?.fn();
    expect(h.sources).toHaveLength(2);
    expect(h.sources.filter((s) => !s.closedByClient)).toHaveLength(1);
  });

  test('events without an id (heartbeats carry the rev in their data) leave the position alone', () => {
    const h = harness();
    h.source.start();
    h.sources[0]?.open();
    h.sources[0]?.emit('op', '{}', '5');
    h.sources[0]?.emit('heartbeat', '{"rev":9}');
    expect(h.source.lastEventRev).toBe(5);
    expect(h.received.map(([name]) => name)).toEqual(['op', 'heartbeat']);
  });
});
