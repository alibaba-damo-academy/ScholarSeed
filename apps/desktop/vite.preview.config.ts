import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { RENDERER_DEV_HOST } from './endpoints'
import { RENDERER_OPTIMIZE_DEPS, supportedFontSources } from './renderer'
import { previewWorkbench } from './preview/plugin'
import { PREVIEW_DEV_PORT, PREVIEW_CACHE_DIRECTORY } from './preview/constants'
import { developmentLocalization } from './scripts/ci/localization/dom.mjs'
import { styles } from './scripts/shared/styles.cjs'

const PREVIEW_VERSION = 'preview'

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  css: { postcss: styles('pdfe') },
  cacheDir: resolve(__dirname, PREVIEW_CACHE_DIRECTORY),
  plugins: [react({ babel: developmentLocalization(command) }), supportedFontSources(), previewWorkbench()],
  optimizeDeps: RENDERER_OPTIMIZE_DEPS,
  define: { __SCHOLARSEED_WEB_VERSION__: JSON.stringify(PREVIEW_VERSION) },
  server: {
    host: RENDERER_DEV_HOST,
    port: PREVIEW_DEV_PORT,
    strictPort: true,
    warmup: {
      clientFiles: [
        resolve(__dirname, 'preview/entry.tsx'),
        resolve(__dirname, 'preview/host.tsx'),
        resolve(__dirname, 'preview/Console.tsx'),
        './src/app/root.tsx',
        './src/App.tsx',
        './src/store.tsx',
        './src/components/business/AccountPanel.tsx',
      ],
    },
    fs: {
      strict: true,
      allow: [resolve(__dirname)],
      deny: ['**/.env', '**/.env.*', '**/*.{crt,pem,key}', '**/.git/**'],
    },
  },
}))
