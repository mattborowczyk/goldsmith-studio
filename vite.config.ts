/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Prompt-to-reload, not autoUpdate: a session may hold unsaved gizmo edits,
      // so we surface an "update available" banner instead of reloading underfoot.
      registerType: 'prompt',
      // The service worker must never run under `pnpm dev` — it would cache the
      // dev bundle and break HMR. Only the production build/preview gets a SW.
      devOptions: { enabled: false },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'GoldSmith Studio',
        short_name: 'GoldSmith',
        description: 'Offline 3D assistant for bench jewellers — measure, repair, cost, deliver.',
        display: 'standalone',
        theme_color: '#232220',
        background_color: '#232220',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell plus the Manifold kernel .wasm and the repair
        // worker chunk so analyze/heal run fully offline after the first load.
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
        // The Manifold WASM kernel is several MB — lift Workbox's default 2 MB cap.
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // manifold-3d ships WASM; keep it out of dep optimization so the .wasm asset resolves correctly
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
