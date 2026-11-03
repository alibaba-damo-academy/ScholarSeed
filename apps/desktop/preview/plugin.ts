import type { IncomingMessage, ServerResponse } from 'node:http'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { createPreviewService } from './service.ts'
import { PREVIEW_OFFICE_FRAME_PATH, previewOfficeFrameParameters } from './frames.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const APP_ENTRY = '/src/main.tsx'
const APP_HTML = fileURLToPath(new URL('../src/renderer/index.html', import.meta.url))
const PREVIEW_ENTRY = `/@fs/${fileURLToPath(new URL('./entry.tsx', import.meta.url)).split(sep).join('/')}`
const PREVIEW_OFFICE_BOOTSTRAP = `/@fs/${fileURLToPath(new URL('./office.ts', import.meta.url)).split(sep).join('/')}`
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

export function previewOfficeHeaders(host: string): Record<string, string> {
  const headers = previewHeaders(host)
  return { ...headers, 'Content-Security-Policy': headers['Content-Security-Policy'].replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'") }
}

export function servePreviewOfficeFrame(request: IncomingMessage, response: ServerResponse): boolean {
  if (!previewRequestAllowed(request)) { response.writeHead(FORBIDDEN_STATUS).end(); return true }
  const origin = new URL(`${HTTP_SCHEME}//${request.headers.host}`).origin
  let url: URL
  try { url = new URL(request.url ?? '/', origin) } catch { response.writeHead(400).end(); return true }
  if (url.origin !== origin || url.username || url.password) { response.writeHead(FORBIDDEN_STATUS).end(); return true }
  if (url.pathname !== PREVIEW_OFFICE_FRAME_PATH) return false
  if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return true }
  try { previewOfficeFrameParameters(url) } catch { response.writeHead(400).end('Invalid preview Office frame request.'); return true }
  response.writeHead(200, { ...previewOfficeHeaders(request.headers.host ?? ''), 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="${PREVIEW_OFFICE_BOOTSTRAP}"></script></body></html>`)
  return true
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
        if (servePreviewOfficeFrame(request, response)) return
        service.middleware(request, response, next)
      })
    },
  }
}
