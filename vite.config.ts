/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: {
    __APP_BUILD__: JSON.stringify(`${pkg.name}@${pkg.version}+${new Date().toISOString().slice(0, 16)}`),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Never swap code mid-match: a new build waits until the user accepts the update prompt.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Badminton scoreboard',
        short_name: 'Scoreboard',
        description: 'A big tappable badminton scoreboard that keeps score, serve and ends for you.',
        display: 'standalone',
        orientation: 'landscape',
        background_color: '#0b0d10',
        theme_color: '#0b0d10',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // wasm: the QR decoder for S2 (zxing-wasm, ~0.9 MB), so pairing works from the installed app offline-first.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,wasm}'],
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  // `pnpm dev` talks to a local helper (`pnpm serve:local`, port 8787) for pairing.
  server: {
    proxy: { '/api': process.env.SIGNAL_ORIGIN ?? 'http://127.0.0.1:8787' },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
