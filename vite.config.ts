/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
