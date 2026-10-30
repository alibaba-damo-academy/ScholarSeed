import { resolve } from 'path'
import { defineConfig, type ElectronViteConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { nativeLease } from './scripts/shared/lease.mjs'
import { velopackLoader } from './scripts/cd/velopack.mjs'
import { build as buildPreload } from 'esbuild'
import { developmentLocalization } from './scripts/ci/localization/dom.mjs'
import { RENDERER_OPTIMIZE_DEPS, supportedFontSources } from './renderer'
import { buildProtected, protectedWatchPolicy, PROTECTED_DEFINE } from './protected'
import { PROTECTED_ASSETS } from './src/main/vaultipc'
import {
  RENDERER_DEV_CACHE_DIRECTORY,
  RENDERER_DEV_HOST,
  RENDERER_DEV_PORT,
  RENDERER_DEV_STRICT_PORT,
} from './endpoints'

const WEBSOCKET_NATIVE_ADDON_DISABLED = JSON.stringify('1')
const WEBSOCKET_NON_NATIVE_DEFINE = {
  'process.env.WS_NO_BUFFER_UTIL': WEBSOCKET_NATIVE_ADDON_DISABLED,
  'process.env.WS_NO_UTF_8_VALIDATE': WEBSOCKET_NATIVE_ADDON_DISABLED
}

export async function desktopConfiguration({ command, mode, protectedOutputRoot }: {
  command: 'serve' | 'build'; mode: string; protectedOutputRoot?: string
}): Promise<ElectronViteConfig> {
  const protectedBundle = await buildProtected({ desktopRoot: __dirname, command, mode, outputRoot: protectedOutputRoot })
  return {
  main: {
    define: { ...WEBSOCKET_NON_NATIVE_DEFINE,
      // Native assets are built for this host; erase other platforms' imports.
      'process.platform': JSON.stringify(process.platform),
      [PROTECTED_DEFINE.generation]: JSON.stringify(protectedBundle.generation), [PROTECTED_DEFINE.digest]: JSON.stringify(protectedBundle.manifestDigest),
      [PROTECTED_DEFINE.binding]: JSON.stringify(`${PROTECTED_ASSETS.binding}:${protectedBundle.generation}:${protectedBundle.manifestDigest}`) },
    plugins: [velopackLoader(), nativeLease({ command }), protectedWatchPolicy(), ...protectedBundle.compilation.vitePlugins()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: ['original-fs'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'data-inspection': resolve(__dirname, 'src/main/data-inspection.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [...protectedBundle.compilation.vitePlugins(), {
      name: 'standalone-overlay-preload',
      async generateBundle() {
        for (const name of ['overlay', 'menu']) {
          const entry = resolve(__dirname, `src/preload/${name}.ts`)
          const result = await buildPreload({ entryPoints: [entry], bundle: true, write: false,
            platform: 'node', format: 'cjs', external: ['electron'], metafile: true,
            plugins: [protectedBundle.compilation.esbuildPlugin(() => this.meta.watchMode)] })
          for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(resolve(input))
          this.emitFile({ type: 'asset', fileName: `${name}.js`, source: result.outputFiles[0].text })
        }
      }
    }],
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: 'src/renderer',
    base: './',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          menu: resolve(__dirname, 'src/renderer/menu.html'),
          monaco: resolve(__dirname, 'src/renderer/monaco.html')
        },
        output: {
          manualChunks(id: string) {
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'vendor-react'
            if (id.includes('node_modules/i18next') || id.includes('node_modules/react-i18next')) return 'vendor-i18n'
            if (id.includes('node_modules/@milkdown') || id.includes('node_modules/prosemirror')) return 'vendor-editor'
            if (id.includes('node_modules/katex') || id.includes('node_modules/rehype-katex')) return 'vendor-math'
            if (id.includes('node_modules/lucide-react')) return 'vendor-icons'
            if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-'))
              return 'vendor-charts'
          },
        },
      },
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
  }
}

export default defineConfig(({ command, mode }) => desktopConfiguration({ command, mode }))
