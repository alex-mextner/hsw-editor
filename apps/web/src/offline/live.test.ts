import { describe, expect, test } from 'bun:test';
import { ConnectionMonitor } from './connection.ts';
import { createLiveSource } from './live.ts';
import { FakeSource, ManualScheduler, settle } from './testing.ts';

function setup(daemonUp = { value: true }) {
  const sources: FakeSource[] = [];
  const probes = { count: 0 };
  const monitorTimers = new ManualScheduler();
  const streamTimers = new ManualScheduler();
  const monitor = new ConnectionMonitor({
    probe: () => {
      probes.count += 1;
      return Promise.resolve(daemonUp.value);
    },
    browserOnline: () => true,
    schedule: monitorTimers.schedule,
    random: () => 0,
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
      schedule: streamTimers.schedule,
      random: () => 0,
    },
    monitor,
  );
  const src = (index: number): FakeSource => {
    const found = sources[index];
    if (!found) throw new Error(`source ${index} was never created`);
    return found;
  };
  return {
    sources,
    src,
    monitor,
    link,
    probes,
    monitorTimers,
    streamTimers,
    reconnects: () => reconnects,
  };
}

describe('createLiveSource', () => {
  test('a broken stream with a dead daemon: the probe finds it out and the monitor goes offline', async () => {
    const daemonUp = { value: true };
    const { src, monitor, link } = setup(daemonUp);
    link.source.start();
    src(0).open();
    daemonUp.value = false;
    src(0).fail();
    await settle();
    expect(monitor.getSnapshot()).toMatchObject({ status: 'offline', reason: 'daemon' });
  });

  test('a stream that keeps failing while the daemon is healthy (wall deleted: 404) never flips the badge', async () => {
    const { src, monitor, link, streamTimers, reconnects } = setup({ value: true });
    link.source.start();
    const states: string[] = [];
    monitor.subscribe(() => states.push(monitor.getSnapshot().status));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      src(attempt).fail();
      await settle();
      streamTimers.fire();
    }
    expect(states).toEqual([]);
    expect(monitor.getSnapshot().status).toBe('online');
    expect(reconnects()).toBe(0);
    // ... and the stream kept its own, growing, backoff instead of being reset by the monitor.
    expect(streamTimers.tasks.filter((t) => t.ms >= 1000).map((t) => t.ms)).toContain(4000);
  });

  test('the stream opening again after an outage recovers the monitor and triggers the reconnect listeners (replay)', async () => {
    const daemonUp = { value: true };
    const { src, monitor, link, streamTimers, reconnects } = setup(daemonUp);
    link.source.start();
    src(0).open();
    src(0).emit('op', '{}', '5');
    daemonUp.value = false;
    src(0).fail();
    await settle();
    expect(monitor.getSnapshot().status).toBe('offline');
    daemonUp.value = true;
    streamTimers.fire(1000);
    src(1).open();
    expect(monitor.getSnapshot().status).toBe('online');
    expect(reconnects()).toBe(1);
    expect(src(1).url).toBe('/events?since=5');
  });

  test('an interruption the browser retries by itself triggers one probe, and none while already offline', async () => {
    const daemonUp = { value: true };
    const { src, monitor, link, probes } = setup(daemonUp);
    link.source.start();
    src(0).open();
    src(0).readyState = 0;
    src(0).emit('error');
    await settle();
    expect(probes.count).toBe(1);
    daemonUp.value = false;
    src(0).emit('error');
    await settle();
    expect(monitor.getSnapshot().status).toBe('offline');
    const before = probes.count;
    src(0).emit('error'); // offline now: the monitor's own backoff probes
    await settle();
    expect(probes.count).toBe(before);
  });

  test('a recovered monitor (probe or API call) reconnects the stream at once instead of waiting for its backoff', () => {
    const { sources, src, monitor, link } = setup({ value: false });
    link.source.start();
    monitor.reportFailure();
    src(0).fail();
    expect(sources).toHaveLength(1);
    monitor.reportSuccess();
    expect(sources).toHaveLength(2);
  });

  test('dispose closes the stream and detaches from the monitor', () => {
    const { sources, src, monitor, link } = setup({ value: false });
    link.source.start();
    monitor.reportFailure();
    src(0).fail();
    link.dispose();
    monitor.reportSuccess();
    expect(sources).toHaveLength(1);
  });
});
