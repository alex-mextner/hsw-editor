import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
 * The tool models of the showcase wall are copied the same way (`/api/tools/assets/index`, `/tools/assets/glb/...`), with the
 * poses that seat its tools (`/api/demo/seats`). The Tool Library is static too: the class list is copied to
 * `/api/tools/assets/classes` (a file cannot sit at `/api/tools/classes` next to the per-class thumbnail directories; the page maps
 * `GET /api/tools/classes` onto it, `src/demo/staticApi.ts`) and the thumbnails to `/api/tools/classes/<id>/thumb.webp`.
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
      if (
        !existsSync(`${tools}/index.json`) ||
        !existsSync(`${tools}/seats.json`) ||
        !existsSync(`${tools}/classes.json`)
      ) {
        throw new Error(
          'demo build: run `bun scripts/tools/demo-assets.ts` first (tool model assets are missing)',
        );
      }
      mkdirSync(`${out}/api/tools/assets`, { recursive: true });
      cpSync(`${tools}/index.json`, `${out}/api/tools/assets/index`);
      // The poses that seat the showcase tools in their holders (the demo has no daemon to do it).
      mkdirSync(`${out}/api/demo`, { recursive: true });
      cpSync(`${tools}/seats.json`, `${out}/api/demo/seats`);
      cpSync(`${tools}/glb`, `${out}/tools/assets/glb`, { recursive: true });
      cpSync(`${tools}/classes.json`, `${out}/api/tools/assets/classes`);
      for (const file of readdirSync(`${tools}/thumbs`)) {
        const id = file.replace(/\.webp$/, '');
        mkdirSync(`${out}/api/tools/classes/${id}`, { recursive: true });
        cpSync(`${tools}/thumbs/${file}`, `${out}/api/tools/classes/${id}/thumb.webp`);
      }
    },
  };
}

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
  return {
    plugins: [
      react(),
      tailwindcss(),
      // App shell precache, runtime caches and the update flow: src/pwa (docs/offline.md).
      VitePWA(pwaPluginOptions()),
      ...(env['VITE_HSW_DEMO'] === '1' ? [demoSeedBank()] : []),
    ],
    resolve: {
      // tunnel-rat (drei) is linked from the shared ~/.bun store, where its react peer can be missing on an
      // old store entry; resolving react from the app root makes a fresh clone build on any machine.
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // The one store seam (44 call sites import it); a single backend, state-lib.
        '#state-backend': fileURLToPath(new URL('./src/state/statelib.ts', import.meta.url)),
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
