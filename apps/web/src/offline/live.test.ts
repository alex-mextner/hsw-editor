import { describe, expect, test } from 'bun:test';
import { ConnectionMonitor } from './connection.ts';
import { createLiveSource } from './live.ts';
import { FakeSource } from './testing.ts';

function setup() {
  const sources: FakeSource[] = [];
  const stream: { cancel: (() => void) | null; fire: (() => void) | null } = {
    cancel: null,
    fire: null,
  };
  const monitor = new ConnectionMonitor({
    probe: () => Promise.resolve(false),
    browserOnline: () => true,
    schedule: () => () => undefined,
  });
  let reconnects = 0;
  monitor.onReconnect(() => {
    reconnects += 1;
  });
  const link = createLiveSource(
    {
      url: (since) => `/events${since === null ? '' : `?since=${since}`}`,
      create: (url) => {
        const source = new FakeSource(url);
        sources.push(source);
        return source;
      },
      events: ['op'],
      onEvent: () => undefined,
      schedule: (fn) => {
        stream.fire = fn;
        return () => {
          stream.fire = null;
        };
      },
    },
    monitor,
  );
  return { sources, monitor, link, stream, reconnects: () => reconnects };
}

describe('createLiveSource', () => {
  test('the stream going down marks the daemon unreachable', () => {
    const { sources, monitor, link } = setup();
    link.source.start();
    sources[0]?.open();
    expect(monitor.getSnapshot().status).toBe('online');
    sources[0]?.fail();
    expect(monitor.getSnapshot()).toMatchObject({ status: 'offline', reason: 'daemon' });
  });

  test('the stream opening again recovers the monitor and triggers the reconnect listeners (replay)', () => {
    const { sources, monitor, link, stream, reconnects } = setup();
    link.source.start();
    sources[0]?.open();
    sources[0]?.emit('op', '{}', '5');
    sources[0]?.fail();
    stream.fire?.();
    sources[1]?.open();
    expect(monitor.getSnapshot().status).toBe('online');
    expect(reconnects()).toBe(1);
    expect(sources[1]?.url).toBe('/events?since=5');
  });

  test('a recovered monitor (probe or API call) reconnects the stream at once instead of waiting for its backoff', () => {
    const { sources, monitor, link } = setup();
    link.source.start();
    sources[0]?.fail();
    expect(sources).toHaveLength(1);
    monitor.reportSuccess();
    expect(sources).toHaveLength(2);
  });

  test('dispose closes the stream and detaches from the monitor', () => {
    const { sources, monitor, link } = setup();
    link.source.start();
    sources[0]?.fail();
    link.dispose();
    monitor.reportSuccess();
    expect(sources).toHaveLength(1);
  });
});
