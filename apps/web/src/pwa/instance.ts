/**
 * The page's PWA controllers (update flow, install prompt), created once at start-up. UI components subscribe to
 * `pwa.updates` / `pwa.install`; `updates` is `null` where no service worker runs (dev server, unsupported browser).
 */
import { flushMirrorBeforeApply } from './beforeApply.ts';
import { startPwa } from './register.ts';

export const pwa = startPwa({
  beforeApply: flushMirrorBeforeApply(async () => (await import('@/offline/runtime.ts')).wallMirror),
});
