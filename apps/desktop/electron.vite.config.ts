import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { developmentLocalization } from './scripts/localization/dom.mjs'
import { RENDERER_OPTIMIZE_DEPS } from './renderer'
import {
  RENDERER_DEV_CACHE_DIRECTORY,
  RENDERER_DEV_HOST,
  RENDERER_DEV_PORT,
  RENDERER_DEV_STRICT_PORT
} from './endpoints'

export default defineConfig(({ command }) => ({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: 'src/renderer',
    base: './',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    plugins: [react({ babel: developmentLocalization(command) })],
    cacheDir: resolve(__dirname, RENDERER_DEV_CACHE_DIRECTORY),
    optimizeDeps: RENDERER_OPTIMIZE_DEPS,
    server: {
      host: RENDERER_DEV_HOST,
      port: RENDERER_DEV_PORT,
      strictPort: RENDERER_DEV_STRICT_PORT,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      }
    }
  }
}))
