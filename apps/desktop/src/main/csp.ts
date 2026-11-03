import type { BrowserWindow } from 'electron'
import { PLUGIN_SCHEME } from '../plugins.ts'

const MAIN_FRAME_RESOURCE_TYPE = 'mainFrame'
const CONTENT_SECURITY_POLICY_HEADER = 'Content-Security-Policy'
const LOOPBACK_HTTP_SOURCE = 'http://127.0.0.1:*'

export function mainWindowContentSecurityPolicy(accountBaseUrl: string): string {
  const accountOrigin = accountBaseUrl ? new URL(accountBaseUrl).origin : ''
  const connectSources = ["'self'", LOOPBACK_HTTP_SOURCE, 'ws://127.0.0.1:*', accountOrigin].filter(
    Boolean
  )
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' ${LOOPBACK_HTTP_SOURCE} data: blob:`,
    "font-src 'self' data:",
    `connect-src ${connectSources.join(' ')}`,
    `frame-src 'self' ${PLUGIN_SCHEME}:`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
  ].join('; ')
}

export function installContentSecurityPolicy(
  win: Pick<BrowserWindow, 'webContents'>,
  policy: string
): void {
  const { id: webContentsId, session } = win.webContents
  session.webRequest.onHeadersReceived((details, callback) => {
    if (
      details.webContentsId !== webContentsId ||
      details.resourceType !== MAIN_FRAME_RESOURCE_TYPE
    ) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    const headers = { ...details.responseHeaders }
    headers[CONTENT_SECURITY_POLICY_HEADER] = [policy]
    callback({ responseHeaders: headers })
  })
}
