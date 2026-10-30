/**
 * 纯前端（浏览器）配置 —— 不启动 Electron，只跑 renderer。
 *
 * 用途：Electron 二进制装不上、或只想改界面/调样式时，用 `npm run dev:web` 直接在浏览器里
 * 打开产品界面。业务链路仍是真实的 `scholarseed serve`：所有 /api 请求由 Vite 同源反代转发，
 * SSE 与会话 cookie 因此不需要跨源特例。
 *
 * 与 Electron 的唯一差别是没有 preload，所以这里把浏览器版 `window.scholarseed` 桥
 * （src/renderer/src/browser.ts）注入到 index.html，且必须排在 main.tsx 之前。
 */

import { resolve } from 'path'
import { defineConfig } from 'vite'
import type { PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import { developmentLocalization } from './scripts/ci/localization/dom.mjs'
import { DEFAULT_SERVE_URL, RENDERER_DEV_PORT } from './endpoints'
import { RENDERER_OPTIMIZE_DEPS, supportedFontSources } from './renderer'

// 指向任意已在运行的 serve，与 `scholarseed-desktop --attach` 共用同一个环境变量。
const SERVE_URL = process.env.SCHOLARSEED_SERVE_URL || DEFAULT_SERVE_URL
const API_PREFIX = '/api'
const BRIDGE_ENTRY = '/src/browser.ts'
const WEB_OUT_DIR = 'out/web'
// 运行在 npm/pnpm script 下时由包管理器注入；直接调 vite 时退化成占位符。
const WEB_VERSION = process.env.npm_package_version || 'dev'

/** 把浏览器桥插到入口脚本之前：应用代码一挂载就得看见 window.scholarseed。 */
function browserBridge(): PluginOption {
  return {
    name: 'scholarseed-browser-bridge',
    transformIndexHtml: {
      // pre：早于 Vite 的 HTML 分析，注入的模块脚本才会被正常打包/转换。
      order: 'pre',
      handler: () => [
        {
          tag: 'script',
          attrs: { type: 'module', src: BRIDGE_ENTRY },
          injectTo: 'head-prepend' as const
        }
      ]
    }
  }
}

export default defineConfig(({ command }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [react({ babel: developmentLocalization(command) }), supportedFontSources(), browserBridge()],
  optimizeDeps: RENDERER_OPTIMIZE_DEPS,
  define: { __SCHOLARSEED_WEB_VERSION__: JSON.stringify(WEB_VERSION) },
  build: { outDir: resolve(__dirname, WEB_OUT_DIR), emptyOutDir: true },
  server: {
    port: RENDERER_DEV_PORT,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    },
    proxy: { [API_PREFIX]: { target: SERVE_URL, changeOrigin: true, ws: true } }
  }
}))
