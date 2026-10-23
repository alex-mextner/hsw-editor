import { describe, expect, test } from 'bun:test';
import {
  scheduleUpdateChecks,
  UPDATE_CHECK_INTERVAL_MS,
  UpdateController,
  type UpdateChannel,
} from './updates.ts';

/** Service-worker double: the test decides when the browser reports each lifecycle event. */
function fakeChannel() {
  const handlers: {
    waiting: (() => void)[];
    activated: ((isUpdate: boolean) => void)[];
    controlling: (() => void)[];
  } = { waiting: [], activated: [], controlling: [] };
  let skipped = 0;
  const state = { waiting: false };
  const registration = { updates: 0 };
  const channel: UpdateChannel = {
    register: () =>
      Promise.resolve({
        update: () => {
          registration.updates += 1;
          return Promise.resolve();
        },
      } as unknown as ServiceWorkerRegistration),
    onWaiting: (fn) => handlers.waiting.push(fn),
    onActivated: (fn) => handlers.activated.push(fn),
    onControlling: (fn) => handlers.controlling.push(fn),
    hasWaiting: () => state.waiting,
    skipWaiting: () => {
      skipped += 1;
    },
  };
  return {
    channel,
    registration,
    skipped: () => skipped,
    waiting: () => {
      state.waiting = true;
      handlers.waiting.forEach((fn) => fn());
    },
    /** Another tab applied the update: nothing waits any more. */
    taken: () => {
      state.waiting = false;
    },
    activated: (isUpdate: boolean) => handlers.activated.forEach((fn) => fn(isUpdate)),
    controlling: () => handlers.controlling.forEach((fn) => fn()),
  };
}

async function started(beforeApply?: () => Promise<void>) {
  const fake = fakeChannel();
  let reloads = 0;
  const controller = new UpdateController({
    channel: fake.channel,
    ...(beforeApply ? { beforeApply } : {}),
    reload: () => {
      reloads += 1;
    },
  });
  await controller.start();
  return { controller, fake, reloads: () => reloads };
}

describe('UpdateController', () => {
  test('a waiting worker makes the update ready but nothing happens until the user accepts', async () => {
    const { controller, fake, reloads } = await started();
    expect(controller.getSnapshot().status).toBe('idle');
    fake.waiting();
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', dismissed: false });
    expect(fake.skipped()).toBe(0);
    expect(reloads()).toBe(0);
  });

  test('accepting flushes offline state first, then skips waiting, then reloads once the new worker controls', async () => {
    const order: string[] = [];
    const { controller, fake, reloads } = await started(() => {
      order.push('flush');
      return Promise.resolve();
    });
    fake.waiting();
    const accepting = controller.accept();
    expect(controller.getSnapshot().status).toBe('applying');
    await accepting;
    order.push(`skipped:${fake.skipped()}`);
    expect(order).toEqual(['flush', 'skipped:1']);
    expect(reloads()).toBe(0);
    fake.controlling();
    expect(reloads()).toBe(1);
  });

  test('the very first install claims the page without a reload', async () => {
    const { controller, fake, reloads } = await started();
    fake.activated(false);
    fake.controlling();
    expect(controller.getSnapshot().offlineReady).toBe(true);
    expect(controller.getSnapshot().status).toBe('idle');
    expect(reloads()).toBe(0);
  });

  test('a control change nobody asked for (another tab updated) does not reload this one', async () => {
    const { fake, reloads } = await started();
    fake.controlling();
    expect(reloads()).toBe(0);
  });

  test('a failing flush aborts the update and keeps it pending', async () => {
    const { controller, fake } = await started(() => Promise.reject(new Error('disk full')));
    fake.waiting();
    await controller.accept();
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', error: 'disk full' });
    expect(fake.skipped()).toBe(0);
  });

  test('"later" hides the toast but keeps the update pending, and a newer worker shows it again', async () => {
    const { controller, fake } = await started();
    fake.waiting();
    controller.dismiss();
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', dismissed: true });
    fake.waiting();
    expect(controller.getSnapshot().dismissed).toBe(false);
  });

  test('accept() is ignored unless an update is ready (no double apply)', async () => {
    const { controller, fake } = await started();
    await controller.accept();
    expect(fake.skipped()).toBe(0);
    fake.waiting();
    await controller.accept();
    await controller.accept();
    expect(fake.skipped()).toBe(1);
  });

  test('if another tab already applied the update, accepting reloads at once instead of hanging', async () => {
    const { controller, fake, reloads } = await started();
    fake.waiting();
    fake.taken();
    await controller.accept();
    expect(fake.skipped()).toBe(0);
    expect(reloads()).toBe(1);
  });

  test('checkForUpdate asks the registration to look for a new worker', async () => {
    const { controller, fake } = await started();
    await controller.checkForUpdate();
    expect(fake.registration.updates).toBe(1);
  });

  test('subscribers hear every change', async () => {
    const { controller, fake } = await started();
    let calls = 0;
    controller.subscribe(() => {
      calls += 1;
    });
    fake.waiting();
    controller.dismiss();
    expect(calls).toBe(2);
  });
});

describe('scheduleUpdateChecks', () => {
  function env(online: { value: boolean }, visible: { value: boolean }) {
    const timers: { fn: () => void; ms: number; stopped: boolean }[] = [];
    const visibility: { fn: () => void; stopped: boolean }[] = [];
    return {
      timers,
      visibility,
      env: {
        isOnline: () => online.value,
        isVisible: () => visible.value,
        every: (fn: () => void, ms: number) => {
          const timer = { fn, ms, stopped: false };
          timers.push(timer);
          return () => {
            timer.stopped = true;
          };
        },
        onVisibility: (fn: () => void) => {
          const entry = { fn, stopped: false };
          visibility.push(entry);
          return () => {
            entry.stopped = true;
          };
        },
      },
    };
  }

  test('checks hourly and when the tab becomes visible, only while online', () => {
    let checks = 0;
    const online = { value: true };
    const visible = { value: false };
    const { env: e, timers, visibility } = env(online, visible);
    const stop = scheduleUpdateChecks(
      {
        checkForUpdate: () => {
          checks += 1;
          return Promise.resolve();
        },
      },
      e,
    );
    expect(timers.map((t) => t.ms)).toEqual([UPDATE_CHECK_INTERVAL_MS]);
    timers[0]?.fn();
    expect(checks).toBe(1);
    visibility[0]?.fn(); // hidden: no check
    expect(checks).toBe(1);
    visible.value = true;
    visibility[0]?.fn();
    expect(checks).toBe(2);
    online.value = false;
    timers[0]?.fn();
    visibility[0]?.fn();
    expect(checks).toBe(2);
    stop();
    expect(timers[0]?.stopped && visibility[0]?.stopped).toBe(true);
  });

  test('a failed check is swallowed (offline race)', async () => {
    const { env: e, timers } = env({ value: true }, { value: true });
    scheduleUpdateChecks({ checkForUpdate: () => Promise.reject(new Error('offline')) }, e);
    timers[0]?.fn();
    await Promise.resolve();
  });
});
