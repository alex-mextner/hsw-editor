import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { ServerResponse } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { pwaPluginOptions } from './src/pwa/pluginOptions.ts';

/**
 * Demo build (`VITE_HSW_DEMO=1`, GitHub Pages): the committed seed bank is copied next to the app at the URLs the daemon would
 * serve (`/api/bank/index`, `/api/bank/search-index`, `/bank/assets/...`), so the bank browser needs no code path of its own.
 * The tool models of the showcase wall are copied the same way (`/api/tools/assets/index`, `/tools/assets/glb/...`).
 */
function demoSeedBank() {
  const seed = fileURLToPath(new URL('../../packages/bank/seed', import.meta.url));
  return {
    name: 'hsw-demo-seed-bank',
    closeBundle() {
      const out = fileURLToPath(new URL('./dist', import.meta.url));
      mkdirSync(`${out}/api/bank`, { recursive: true });
      cpSync(`${seed}/index.json`, `${out}/api/bank/index`);
      cpSync(`${seed}/search-index.json`, `${out}/api/bank/search-index`);
      for (const dir of ['glb', 'thumb']) {
        cpSync(`${seed}/${dir}`, `${out}/bank/assets/${dir}`, { recursive: true });
      }
      // Generated tool models of the showcase wall (`bun scripts/tools/demo-assets.ts`, run by `bun run build`).
      const tools = fileURLToPath(new URL('./.generated/tools-assets', import.meta.url));
      if (!existsSync(`${tools}/index.json`)) {
        throw new Error(
          'demo build: run `bun scripts/tools/demo-assets.ts` first (tool model assets are missing)',
        );
      }
      mkdirSync(`${out}/api/tools/assets`, { recursive: true });
      cpSync(`${tools}/index.json`, `${out}/api/tools/assets/index`);
      cpSync(`${tools}/glb`, `${out}/tools/assets/glb`, { recursive: true });
    },
  };
}

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
      // App shell precache, runtime caches and the update flow: src/pwa (docs/offline.md).
      VitePWA(pwaPluginOptions()),
      ...(env['VITE_HSW_DEMO'] === '1' ? [demoSeedBank()] : []),
    ],
    define: { __STATE_BACKEND__: JSON.stringify(useStateLib ? 'state-lib' : 'baseline') },
    resolve: {
      // tunnel-rat (drei) is linked from the shared ~/.bun store, where its react peer can be missing on an
      // old store entry; resolving react from the app root makes a fresh clone build on any machine.
      dedupe: ['react', 'react-dom'],
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
        '/api': { ...proxyTo(env['HSW_API_TARGET'] ?? DAEMON), ws: true },
        '/bank': proxyTo(env['HSW_BANK_TARGET'] ?? env['HSW_API_TARGET'] ?? DAEMON),
        // Content-hashed tool model GLBs of the daemon's asset store (the index is under /api).
        '/tools': proxyTo(env['HSW_API_TARGET'] ?? DAEMON),
      },
    },
    build: { sourcemap: true, target: 'es2022' },
  };
});
