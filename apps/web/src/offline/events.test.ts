import { describe, expect, test } from 'bun:test';
import { ReconnectingSource } from './events.ts';
import { FakeSource, ManualScheduler } from './testing.ts';

function harness(staleAfterMs = 45_000) {
  const sources: FakeSource[] = [];
  const scheduler = new ManualScheduler();
  const received: [string, string][] = [];
  const opens: boolean[] = [];
  const log: string[] = [];
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
    onDown: () => log.push(`down:retry-scheduled=${scheduler.live(1000).length > 0}`),
    onInterrupted: () => log.push('interrupted'),
    staleAfterMs,
    random: () => 0,
    schedule: scheduler.schedule,
  });
  /** The i-th source created; throws if the test expected one that does not exist. */
  const src = (index: number): FakeSource => {
    const found = sources[index];
    if (!found) throw new Error(`source ${index} was never created`);
    return found;
  };
  return { source, sources, src, scheduler, received, opens, log };
}

describe('ReconnectingSource', () => {
  test('connects without since, forwards named events and tracks the last rev', () => {
    const h = harness();
    h.source.start();
    expect(h.sources.map((s) => s.url)).toEqual(['/events']);
    h.src(0).open();
    h.src(0).emit('op', '{"rev":4}', '4');
    h.src(0).emit('heartbeat', '{"rev":4}');
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
    h.src(0).open();
    h.src(0).emit('op', '{}', '7');
    h.src(0).fail();
    expect(h.sources).toHaveLength(1);
    // The retry is already scheduled when listeners hear about it, after the first backoff step.
    expect(h.log).toEqual(['down:retry-scheduled=true']);
    h.scheduler.fire(1000);
    expect(h.sources.map((s) => s.url)).toEqual(['/events', '/events?since=7']);
    h.src(1).open();
    expect(h.opens).toEqual([false, true]);
  });

  test('keeps backing off while the daemon stays down and resets after an open', () => {
    const h = harness();
    h.source.start();
    h.src(0).fail();
    h.scheduler.fire(1000);
    h.src(1).fail();
    expect(h.scheduler.live(2000)).toHaveLength(1);
    h.scheduler.fire(2000);
    h.src(2).open();
    h.src(2).fail();
    expect(h.scheduler.live(1000)).toHaveLength(1);
  });

  test('a browser-level retry (readyState CONNECTING) is left to the browser but reported as an interruption', () => {
    const h = harness();
    h.source.start();
    h.src(0).open();
    h.src(0).readyState = 0;
    h.src(0).emit('error');
    expect(h.log).toEqual(['interrupted']);
    expect(h.sources).toHaveLength(1);
  });

  test('silence longer than the stale limit is treated as a dead connection', () => {
    const h = harness(45_000);
    h.source.start();
    h.src(0).open();
    h.scheduler.fire(45_000);
    expect(h.src(0).closedByClient).toBe(true);
    expect(h.log).toEqual(['down:retry-scheduled=true']);
  });

  test('every event re-arms the watchdog', () => {
    const h = harness(45_000);
    h.source.start();
    h.src(0).open();
    const before = h.scheduler.live(45_000)[0];
    h.src(0).emit('heartbeat', '{"rev":1}');
    expect(before?.cancelled).toBe(true);
    expect(h.scheduler.live(45_000)).toHaveLength(1);
  });

  test('reconnectNow replaces a connecting source but leaves a healthy one alone', () => {
    const h = harness();
    h.source.start();
    h.source.reconnectNow();
    expect(h.sources).toHaveLength(2);
    expect(h.src(0).closedByClient).toBe(true);
    h.src(1).open();
    h.source.reconnectNow();
    expect(h.sources).toHaveLength(2);
  });

  test('after close() the events of the old source are ignored', () => {
    const h = harness();
    h.source.start();
    h.src(0).open();
    h.source.close();
    h.src(0).emit('op', '{}', '9');
    expect(h.received).toEqual([]);
  });

  test('close stops every timer and never reconnects', () => {
    const h = harness();
    h.source.start();
    h.src(0).fail();
    h.source.close();
    expect(h.scheduler.live()).toEqual([]);
    expect(h.sources).toHaveLength(1);
  });

  test('a snapshot resets the resume position even when it is lower (wall restored from a backup)', () => {
    const h = harness();
    h.source.start();
    h.src(0).open();
    h.src(0).emit('op', '{}', '50');
    h.src(0).emit('snapshot', '{}', '10');
    expect(h.source.lastEventRev).toBe(10);
    h.src(0).emit('op', '{}', '11');
    h.src(0).emit('op', '{}', '9'); // an older op never lowers the position
    expect(h.source.lastEventRev).toBe(11);
    h.src(0).fail();
    h.scheduler.fire(1000);
    expect(h.sources.at(-1)?.url).toBe('/events?since=11');
  });

  test('start() while a retry is pending does not open a second connection', () => {
    const h = harness();
    h.source.start();
    h.src(0).fail();
    h.source.start();
    expect(h.sources).toHaveLength(1);
    h.scheduler.fire(1000);
    expect(h.sources).toHaveLength(2);
    expect(h.sources.filter((s) => !s.closedByClient)).toHaveLength(1);
  });

  test('events without an id (heartbeats carry the rev in their data) leave the position alone', () => {
    const h = harness();
    h.source.start();
    h.src(0).open();
    h.src(0).emit('op', '{}', '5');
    h.src(0).emit('heartbeat', '{"rev":9}');
    expect(h.source.lastEventRev).toBe(5);
    expect(h.received.map(([name]) => name)).toEqual(['op', 'heartbeat']);
  });
});
