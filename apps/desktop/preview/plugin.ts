import type { IncomingMessage, ServerResponse } from 'node:http'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { createPreviewService } from './service.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const APP_ENTRY = '/src/main.tsx'
const APP_HTML = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url))
const PREVIEW_ENTRY = `/@fs/${fileURLToPath(new URL('./entry.tsx', import.meta.url)).split(sep).join('/')}`
const FORBIDDEN_STATUS = 403
const HTTP_SCHEME = 'http:'
const WEBSOCKET_SCHEME = 'ws:'

export function requirePreviewDevelopment(command: string): void {
  if (command !== 'serve') throw new Error('The mock workbench is development-only; use the real Web/Electron configuration for builds.')
}

export function previewEntryHtml(html: string, filename = APP_HTML): string {
  if (filename !== APP_HTML) return html
  if (!html.includes(APP_ENTRY)) throw new Error('The shared renderer entry is missing; preview cannot replace it.')
  return html.replace(APP_ENTRY, PREVIEW_ENTRY)
}

export function previewRequestAllowed(request: Pick<IncomingMessage, 'headers'>): boolean {
  try {
    const local = new URL(`${HTTP_SCHEME}//${request.headers.host ?? ''}`)
    if (!LOOPBACK_HOSTS.has(local.hostname)) return false
    const origin = request.headers.origin
    const referer = request.headers.referer
    if (origin && origin !== local.origin) return false
    if (referer && new URL(referer).origin !== local.origin) return false
    return true
  } catch { return false }
}

export function previewHeaders(host: string): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      `connect-src 'self' ${WEBSOCKET_SCHEME}//${host}`,
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
}

export function previewWorkbench(): Plugin {
  return {
    name: 'scholarseed-preview-workbench',
    enforce: 'pre',
    configResolved(config) { requirePreviewDevelopment(config.command) },
    transformIndexHtml: { order: 'pre', handler: (html, context) => previewEntryHtml(html, context.filename) },
    configureServer(server) {
      const service = createPreviewService()
      server.httpServer?.once('close', () => service.dispose())
      server.middlewares.use((request, response, next) => {
        if (!previewRequestAllowed(request)) {
          response.writeHead(FORBIDDEN_STATUS).end('Preview accepts same-origin loopback requests only.')
          return
        }
        for (const [name, value] of Object.entries(previewHeaders(request.headers.host ?? ''))) response.setHeader(name, value)
        service.middleware(request, response, next)
      })
    },
  }
}
