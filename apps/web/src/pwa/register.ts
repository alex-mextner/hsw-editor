/**
 * Starts the PWA on the page: registers the service worker (production builds only: a worker in `vite dev`
 * would serve stale modules against HMR) and creates the controllers the UI reads.
 */
import { Workbox } from 'workbox-window';
import { InstallController, type InstallEnv } from './install.ts';
import { scheduleUpdateChecks, UpdateController, type UpdateChannel } from './updates.ts';

export interface Pwa {
  readonly updates: UpdateController | null;
  readonly install: InstallController;
}

function workboxChannel(wb: Workbox): UpdateChannel {
  let registration: ServiceWorkerRegistration | undefined;
  return {
    register: async () => {
      registration = await wb.register();
      return registration;
    },
    onWaiting: (listener) => wb.addEventListener('waiting', () => listener()),
    onActivated: (listener) =>
      wb.addEventListener('activated', (event) => listener(event.isUpdate === true)),
    onControlling: (listener) => wb.addEventListener('controlling', () => listener()),
    hasWaiting: () => registration?.waiting != null,
    skipWaiting: () => wb.messageSkipWaiting(),
  };
}

function browserInstallEnv(): InstallEnv {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone: () =>
      window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in navigator && navigator.standalone === true),
    listen: (type, fn) => window.addEventListener(type, fn),
  };
}

/**
 * The install controller works everywhere (it only listens for events); the service worker and the update flow
 * exist only when the browser supports workers and this is a production build, otherwise `updates` is `null`.
 *
 * `beforeApply` runs before an accepted update takes over: the editor flushes its offline mirror there.
 */
export function startPwa(options: { beforeApply?: () => Promise<void> } = {}): Pwa {
  const install = new InstallController(browserInstallEnv());
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) {
    return { updates: null, install };
  }
  const updates = new UpdateController({
    channel: workboxChannel(new Workbox('/sw.js', { scope: '/' })),
    ...(options.beforeApply ? { beforeApply: options.beforeApply } : {}),
    reload: () => window.location.reload(),
  });
  void updates.start();
  scheduleUpdateChecks(updates, {
    isOnline: () => navigator.onLine,
    isVisible: () => document.visibilityState === 'visible',
    every: (fn, ms) => {
      const handle = window.setInterval(fn, ms);
      return () => window.clearInterval(handle);
    },
    onVisibility: (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
  });
  return { updates, install };
}
