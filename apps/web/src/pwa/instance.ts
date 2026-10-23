/**
 * The page's PWA controllers (update flow, install prompt), created once at start-up. UI components subscribe to
 * `pwa.updates` / `pwa.install`; `updates` is `null` where no service worker runs (dev server, unsupported browser).
 */
import { startPwa } from './register.ts';

export const pwa = startPwa();
