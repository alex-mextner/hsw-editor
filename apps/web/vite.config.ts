import { existsSync } from 'node:fs';
import { ServerResponse } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import {
  NAVIGATE_FALLBACK_DENYLIST,
  PRECACHE_MAX_FILE_BYTES,
  RUNTIME_CACHING,
} from './src/pwa/runtimeCaching.ts';

const stateLibDist = fileURLToPath(
  new URL('../../vendor/state-lib/dist/index.js', import.meta.url),
);

const DAEMON = 'http://127.0.0.1:8794';

/** Dev proxy that answers 502 (not Vite's bare 500) when the daemon is down, so the client goes offline. */
function proxyTo(target: string): ProxyOptions {
  return {
    target,
    configure: (proxy) => {
      proxy.on('error', (_error, _request, response) => {
        if (response instanceof ServerResponse && !response.headersSent) {
          response.writeHead(502).end();
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  // The private state-lib is optional: without vendor/state-lib (see `bun run setup:state-lib`)
  // or with VITE_STATE_BACKEND=baseline the app uses the dependency-free baseline store.
  const useStateLib = env['VITE_STATE_BACKEND'] !== 'baseline' && existsSync(stateLibDist);
  if (!useStateLib) console.info('vite: store backend = baseline (state-lib not used)');
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Precaches the app shell and runtime-caches the bank (rules + rationale: src/pwa/runtimeCaching.ts, docs/offline.md).
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: 'HSW Editor',
          short_name: 'HSW',
          display: 'standalone',
          background_color: '#0a0a0a',
          theme_color: '#0a0a0a',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        },
        workbox: {
          navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
          maximumFileSizeToCacheInBytes: PRECACHE_MAX_FILE_BYTES,
          cleanupOutdatedCaches: true,
          skipWaiting: true,
          clientsClaim: true,
          runtimeCaching: RUNTIME_CACHING,
        },
      }),
    ],
    define: { __STATE_BACKEND__: JSON.stringify(useStateLib ? 'state-lib' : 'baseline') },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '#state-backend': fileURLToPath(
          new URL(
            useStateLib ? './src/state/statelib.ts' : './src/state/baseline.ts',
            import.meta.url,
          ),
        ),
        ...(useStateLib ? { '@ultrabricks/state-lib': stateLibDist } : {}),
      },
    },
    server: {
      host: '127.0.0.1',
      port: Number.parseInt(env['HSW_WEB_PORT'] ?? '', 10) || 5194,
      strictPort: true,
      // The daemon serves the API and the bank assets; both are proxied in dev.
      proxy: {
        '/api/bank': proxyTo(env['HSW_BANK_TARGET'] ?? env['HSW_API_TARGET'] ?? DAEMON),
        '/api': proxyTo(env['HSW_API_TARGET'] ?? DAEMON),
        '/bank': proxyTo(env['HSW_BANK_TARGET'] ?? env['HSW_API_TARGET'] ?? DAEMON),
      },
    },
    build: { sourcemap: true, target: 'es2022' },
  };
});
