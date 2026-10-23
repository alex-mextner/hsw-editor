import { describe, expect, test } from 'bun:test';
import { ConnectionMonitor } from './connection.ts';
import { ManualScheduler, settle } from './testing.ts';
import { BACKOFF_MAX_MS, backoffDelay } from './timers.ts';

function monitor(options: { daemonUp: { value: boolean }; online?: { value: boolean } }) {
  const scheduler = new ManualScheduler();
  const online = options.online ?? { value: true };
  const errors: unknown[] = [];
  const instance = new ConnectionMonitor({
    probe: () => Promise.resolve(options.daemonUp.value),
    browserOnline: () => online.value,
    schedule: scheduler.schedule,
    random: () => 0,
    now: () => 0,
    onListenerError: (error) => errors.push(error),
  });
  return { instance, scheduler, online, errors };
}

describe('backoffDelay', () => {
  test('doubles from one second up to the cap, with bounded jitter', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, 0))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000,
    ]);
    expect(backoffDelay(50, 0)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(1, 1)).toBe(1200);
  });
});

describe('ConnectionMonitor', () => {
  test('starts online', () => {
    const { instance } = monitor({ daemonUp: { value: true } });
    expect(instance.getSnapshot()).toMatchObject({ status: 'online', reason: null, failures: 0 });
  });

  test('a failed call with the network up blames the daemon, and probing begins', () => {
    const { instance, scheduler } = monitor({ daemonUp: { value: false } });
    instance.reportFailure();
    expect(instance.getSnapshot()).toMatchObject({
      status: 'offline',
      reason: 'daemon',
      failures: 1,
    });
    expect(scheduler.live().map((t) => t.ms)).toEqual([1000]);
  });

  test('a burst of failing calls does not push the probe towards the backoff cap', () => {
    const { instance, scheduler } = monitor({ daemonUp: { value: false } });
    for (let i = 0; i < 10; i += 1) instance.reportFailure();
    expect(instance.getSnapshot().failures).toBe(1);
    expect(scheduler.live().map((t) => t.ms)).toEqual([1000]);
  });

  test('the browser going offline blames the network', () => {
    const { instance } = monitor({ daemonUp: { value: true }, online: { value: false } });
    instance.notifyBrowserOffline();
    expect(instance.getSnapshot().reason).toBe('network');
  });

  test('probes back off while the daemon stays down, then reconnect listeners fire once on recovery', async () => {
    const daemonUp = { value: false };
    const { instance, scheduler } = monitor({ daemonUp });
    let reconnects = 0;
    instance.onReconnect(() => {
      reconnects += 1;
    });
    instance.reportFailure();
    scheduler.fire();
    await settle();
    scheduler.fire();
    await settle();
    expect(scheduler.live().map((t) => t.ms)).toEqual([4000]);
    expect(instance.getSnapshot().failures).toBe(3);

    daemonUp.value = true;
    scheduler.fire();
    await settle();
    expect(instance.getSnapshot()).toMatchObject({ status: 'online', reason: null, failures: 0 });
    expect(reconnects).toBe(1);
    expect(scheduler.live()).toEqual([]);
  });

  test('any successful call recovers without waiting for the probe', () => {
    const { instance, scheduler } = monitor({ daemonUp: { value: false } });
    let reconnects = 0;
    instance.onReconnect(() => {
      reconnects += 1;
    });
    instance.reportFailure();
    instance.reportSuccess();
    expect(instance.getSnapshot().status).toBe('online');
    expect(reconnects).toBe(1);
    expect(scheduler.live()).toEqual([]);
    // A success while already online is not a reconnect.
    instance.reportSuccess();
    expect(reconnects).toBe(1);
  });

  test('a probe that fails after a real call already succeeded does not undo the recovery', async () => {
    const gate: { release: (ok: boolean) => void } = { release: () => undefined };
    const scheduler = new ManualScheduler();
    let reconnects = 0;
    const instance = new ConnectionMonitor({
      probe: () => new Promise<boolean>((resolve) => (gate.release = resolve)),
      browserOnline: () => true,
      schedule: scheduler.schedule,
      random: () => 0,
    });
    instance.onReconnect(() => {
      reconnects += 1;
    });
    instance.reportFailure();
    scheduler.fire(); // probe starts and hangs
    instance.reportSuccess(); // a real request gets through meanwhile
    expect(reconnects).toBe(1);
    gate.release(false); // the older probe now reports failure
    await settle();
    expect(instance.getSnapshot().status).toBe('online');
    expect(scheduler.live()).toEqual([]);
    expect(reconnects).toBe(1);
  });

  test('probeNow on an online monitor: an answering daemon changes nothing, a silent one means offline', async () => {
    const daemonUp = { value: true };
    const { instance } = monitor({ daemonUp });
    let notified = 0;
    instance.subscribe(() => {
      notified += 1;
    });
    await instance.probeNow();
    expect(notified).toBe(0);
    daemonUp.value = false;
    await instance.probeNow();
    expect(instance.getSnapshot()).toMatchObject({ status: 'offline', failures: 1 });
  });

  test('the browser coming back online probes immediately', async () => {
    const daemonUp = { value: true };
    const { instance } = monitor({ daemonUp });
    instance.reportFailure();
    instance.notifyBrowserOnline();
    await settle();
    expect(instance.getSnapshot().status).toBe('online');
  });

  test('a probe that throws counts as a failure', async () => {
    const scheduler = new ManualScheduler();
    const instance = new ConnectionMonitor({
      probe: () => Promise.reject(new Error('refused')),
      browserOnline: () => true,
      schedule: scheduler.schedule,
      random: () => 0,
    });
    instance.reportFailure();
    scheduler.fire();
    await settle();
    expect(instance.getSnapshot()).toMatchObject({ status: 'offline', failures: 2 });
  });

  test('subscribers are notified on changes only', () => {
    const { instance } = monitor({ daemonUp: { value: false } });
    let calls = 0;
    instance.subscribe(() => {
      calls += 1;
    });
    instance.reportFailure();
    instance.reportFailure();
    instance.reportSuccess();
    instance.reportSuccess();
    expect(calls).toBe(2);
  });

  test('a throwing listener does not stop the others', () => {
    const { instance, errors } = monitor({ daemonUp: { value: false } });
    const seen: string[] = [];
    instance.onReconnect(() => {
      throw new Error('first listener fails');
    });
    instance.onReconnect(() => {
      seen.push('second');
    });
    instance.reportFailure();
    instance.reportSuccess();
    expect(seen).toEqual(['second']);
    expect(errors).toHaveLength(1);
  });

  test('after dispose nothing changes and nothing is scheduled', () => {
    const { instance, scheduler } = monitor({ daemonUp: { value: false } });
    instance.reportFailure();
    instance.dispose();
    expect(scheduler.live()).toEqual([]);
    instance.reportSuccess();
    instance.reportFailure();
    expect(instance.getSnapshot().status).toBe('offline');
    expect(scheduler.live()).toEqual([]);
  });
});
