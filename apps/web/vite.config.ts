import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const stateLibDist = fileURLToPath(
  new URL('../../vendor/state-lib/dist/index.js', import.meta.url),
);

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
      // Placeholder PWA config: precaches the app shell. Offline op queue and model caching: see issues.
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
        workbox: { navigateFallbackDenylist: [/^\/api\//] },
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
      port: 5194,
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:8794' },
    },
    build: { sourcemap: true, target: 'es2022' },
  };
});
