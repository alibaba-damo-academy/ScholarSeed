import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { developmentLocalization } from './scripts/localization/dom.mjs'
import { RENDERER_OPTIMIZE_DEPS, supportedFontSources } from './renderer'
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
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          monaco: resolve(__dirname, 'src/renderer/monaco.html')
        },
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'vendor-react'
            if (id.includes('node_modules/i18next') || id.includes('node_modules/react-i18next')) return 'vendor-i18n'
            if (id.includes('node_modules/@milkdown') || id.includes('node_modules/prosemirror')) return 'vendor-editor'
            if (id.includes('node_modules/katex') || id.includes('node_modules/rehype-katex')) return 'vendor-math'
            if (id.includes('node_modules/lucide-react')) return 'vendor-icons'
            if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'vendor-charts'
          }
        }
      }
    },
    plugins: [react({ babel: developmentLocalization(command) }), supportedFontSources()],
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
