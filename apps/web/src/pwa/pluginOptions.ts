/**
 * `vite-plugin-pwa` options, kept out of vite.config.ts so the manifest and the precache rules are plain data
 * the tests can inspect. Imported by vite.config.ts (runs in Node/Bun at build time: no browser globals here).
 */
import type { VitePWAOptions } from 'vite-plugin-pwa';

export const THEME_COLOR = '#0a0a0a';

/**
 * Precache ceiling. Workbox silently drops a file above its limit (2 MiB by default) from the precache, and
 * the app then fails to start offline with no build error; the three.js chunk of the editor is above 2 MiB.
 */
export const PRECACHE_MAX_FILE_BYTES = 8 * 1024 * 1024;

export const MANIFEST = {
  id: '/',
  name: 'HSW Editor',
  short_name: 'HSW',
  description: 'Local 3D editor for HSW honeycomb tool walls: works offline.',
  lang: 'ru',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  orientation: 'any',
  background_color: THEME_COLOR,
  theme_color: THEME_COLOR,
  categories: ['productivity', 'utilities'],
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: '/icons/icon-maskable-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
} as const;

/**
 * Everything the app shell needs offline. Source maps and the iOS splash images are left out: splash images are
 * read by iOS when the app is added to the home screen, and a precache that downloads them on every desktop
 * visit would be pure waste.
 */
export const PRECACHE_GLOBS = ['**/*.{js,css,html,svg,png,ico,woff2,webmanifest}'];
export const PRECACHE_IGNORES = ['**/*.map', 'icons/splash-*.png'];

export function pwaPluginOptions(): Partial<VitePWAOptions> {
  return {
    strategies: 'injectManifest',
    srcDir: 'src/pwa',
    filename: 'sw.ts',
    // `prompt`: a new worker waits until the user accepts (src/pwa/updates.ts), never reloads on its own.
    registerType: 'prompt',
    // Registered by src/pwa/register.ts (workbox-window) so the update flow and the offline state are ours.
    injectRegister: false,
    manifest: {
      ...MANIFEST,
      icons: [...MANIFEST.icons],
      display_override: [...MANIFEST.display_override],
      categories: [...MANIFEST.categories],
    },
    injectManifest: {
      globPatterns: PRECACHE_GLOBS,
      globIgnores: PRECACHE_IGNORES,
      maximumFileSizeToCacheInBytes: PRECACHE_MAX_FILE_BYTES,
    },
    devOptions: { enabled: false },
  };
}
