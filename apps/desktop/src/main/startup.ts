// startup.ts — the lightweight native startup surface shown while the local
// backend becomes ready. It intentionally has no renderer/backend dependency.

import { BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'

import startupLogoPath from '../renderer/src/assets/logo.svg?asset'
import { mainLocalization } from './localization'

const STARTUP_WINDOW_WIDTH = 440
const STARTUP_WINDOW_HEIGHT = 292
const STARTUP_WINDOW_BACKGROUND = '#F8F8F5'
const STARTUP_STATUS_ID = 'startup-status'
const STARTUP_LOGO_SOURCE = `data:image/svg+xml;base64,${readFileSync(startupLogoPath).toString('base64')}`
function startupDocument(): string {
  const locale = mainLocalization()
  const t = locale.getFixedT(null, 'foundation')
  return `<!doctype html>
<html lang="${locale.language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
    <title>${t('startup.brand')}</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; overflow: hidden; background: #f8f8f5; color: #171716; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
      main { width: min(100%, 360px); display: grid; justify-items: center; gap: 16px; text-align: center; }
      .mark { width: 46px; height: 46px; display: block; object-fit: contain; }
      h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.01em; }
      p { margin: 0; color: #4d4d49; font-size: 12px; line-height: 1.55; }
      .track { width: 154px; height: 3px; overflow: hidden; border-radius: 99px; background: #dededb; }
      .track::before { display: block; width: 42%; height: 100%; border-radius: inherit; background: #8faab6; content: ""; animation: travel 1.35s ease-in-out infinite; }
      @keyframes travel { 0% { transform: translateX(-110%); } 55%, 100% { transform: translateX(260%); } }
      @media (prefers-color-scheme: dark) { body { background: #202429; color: #f2f3f0; } p { color: #b9c0c4; } .track { background: #3c464b; } .track::before { background: #92aeb9; } }
      @media (prefers-reduced-motion: reduce) { .track::before { animation: none; } }
    </style>
  </head>
  <body>
    <main>
      <img class="mark" src="${STARTUP_LOGO_SOURCE}" alt="" aria-hidden="true" />
      <h1>${t('startup.brand')}</h1>
      <p id="${STARTUP_STATUS_ID}">${t('startup.preparing')}</p>
      <div class="track" aria-hidden="true"></div>
    </main>
  </body>
</html>`
}

export interface StartupScreen {
  setStatus(status: string): void
  close(): void
}

export function showStartupScreen(): StartupScreen {
  const screen = new BrowserWindow({
    width: STARTUP_WINDOW_WIDTH,
    height: STARTUP_WINDOW_HEIGHT,
    minWidth: STARTUP_WINDOW_WIDTH,
    minHeight: STARTUP_WINDOW_HEIGHT,
    resizable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: STARTUP_WINDOW_BACKGROUND,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.platform === 'win32') screen.setMenu(null)
  let status: string = mainLocalization().getFixedT(null, 'foundation')('startup.preparing')
  const renderStatus = (): void => {
    if (screen.isDestroyed()) return
    void screen.webContents.executeJavaScript(
      `document.getElementById(${JSON.stringify(STARTUP_STATUS_ID)}).textContent = ${JSON.stringify(status)}`
    ).catch(() => undefined)
  }

  screen.webContents.once('did-finish-load', () => {
    renderStatus()
    screen.show()
  })
  void screen.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupDocument())}`)

  return {
    setStatus(next: string): void {
      status = next
      renderStatus()
    },
    close(): void {
      if (!screen.isDestroyed()) screen.close()
    }
  }
}
