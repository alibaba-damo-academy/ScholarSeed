// startup.ts — the lightweight native startup surface shown while the local
// backend becomes ready. It intentionally has no renderer/backend dependency.

import { app, BrowserWindow } from 'electron'
import { applicationIcon } from './resources.ts'
import { readFileSync } from 'node:fs'

import startupLogoPath from '../renderer/src/assets/logo.svg?asset'
import { mainLocalization } from './localization'

const STARTUP_WINDOW_WIDTH = 440
const STARTUP_WINDOW_HEIGHT = 292
const WINDOWS_STARTUP_WINDOW_HEIGHT = 330
const STARTUP_WINDOW_BACKGROUND = '#F8F8F5'
const STARTUP_STATUS_ID = 'startup-status'
const STARTUP_PROGRESS_ID = 'startup-progress'
const STARTUP_ELAPSED_ID = 'startup-elapsed'
const STARTUP_TITLE_ID = 'startup-title'
const STARTUP_FAILURE_ATTRIBUTE = 'data-failed'
const STARTUP_ELAPSED_INTERVAL_MS = 1000
const STARTUP_LOGO_SOURCE = `data:image/svg+xml;base64,${readFileSync(startupLogoPath).toString('base64')}`
function startupDocument(): string {
  const locale = mainLocalization()
  const t = locale.getFixedT(null, 'foundation')
  const native = locale.getFixedT(null, 'native')
  const windows = process.platform === 'win32'
  return `<!doctype html>
<html lang="${locale.language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:" />
    <title>${windows ? native('startup.title') : t('startup.brand')}</title>
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
      .track[data-progress]::before { width: var(--progress); animation: none; transform: none; }
      body[data-failed] .track, body[data-failed] #startup-elapsed { display: none; }
      body[data-failed] main { max-height: 100vh; overflow-y: auto; }
      body[data-failed] p { white-space: pre-wrap; overflow-wrap: anywhere; }
      body.windows[data-failed] main { display: grid; align-content: center; gap: 16px; padding: 24px; }
      body.windows[data-failed] .mark, body.windows[data-failed] h1, body.windows[data-failed] #startup-status { position: static; width: auto; height: auto; }
      @keyframes travel { 0% { transform: translateX(-110%); } 55%, 100% { transform: translateX(260%); } }
      @media (prefers-color-scheme: dark) { body { background: #202429; color: #f2f3f0; } p { color: #b9c0c4; } .track { background: #3c464b; } .track::before { background: #92aeb9; } }
      @media (prefers-reduced-motion: reduce) { .track::before { animation: none; } }
      body.windows { height: 100vh; display: block; background: #f8f8f5; color: #171716; }
      body.windows p { color: #4d4d49; }
      body.windows .track { background: #dededb; }
      body.windows .track::before { background: #8faab6; }
      body.windows main { position: relative; display: block; width: 100%; height: 100%; max-width: none; }
      body.windows .mark { position: absolute; top: 30px; left: calc(50% - 23px); }
      body.windows h1 { position: absolute; top: 92px; left: 32px; right: 32px; height: 30px; font-size: 20px; font-weight: 600; }
      body.windows #${STARTUP_STATUS_ID} { position: absolute; top: 138px; left: 32px; right: 32px; height: 52px; margin: 0; font-size: 14px; line-height: 24px; }
      body.windows .track { position: absolute; top: 206px; left: calc(50% - 77px); }
      body.windows #${STARTUP_ELAPSED_ID} { position: absolute; top: 230px; left: 32px; right: 32px; margin: 0; font-size: 14px; line-height: 24px; }
    </style>
  </head>
  <body class="${windows ? 'windows' : ''}">
    <main>
      <img class="mark" src="${STARTUP_LOGO_SOURCE}" alt="" aria-hidden="true" />
      <h1 id="${STARTUP_TITLE_ID}">${t('startup.brand')}</h1>
      <p id="${STARTUP_STATUS_ID}">${t('startup.preparing')}</p>
      <div id="${STARTUP_PROGRESS_ID}" class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
      ${windows ? `<p id="${STARTUP_ELAPSED_ID}">${native('startup.elapsed')}0s</p>` : ''}
    </main>
  </body>
</html>`
}

export interface StartupScreen {
  setStatus(status: string, fraction?: number): void
  fail(title: string, message: string): boolean
  failed(): boolean
  isClosing(): boolean
  reveal(): boolean
  close(): Promise<void>
}

export function showStartupScreen(
  onVisible?: () => void,
  onDismiss?: () => void,
  log: (message: string) => void = () => undefined,
  allowed: () => boolean = () => true
): StartupScreen {
  const windows = process.platform === 'win32'
  const screen = new BrowserWindow({
    ...(windows ? { icon: applicationIcon(app) } : {}),
    width: STARTUP_WINDOW_WIDTH,
    height: windows ? WINDOWS_STARTUP_WINDOW_HEIGHT : STARTUP_WINDOW_HEIGHT,
    minWidth: STARTUP_WINDOW_WIDTH,
    minHeight: windows ? WINDOWS_STARTUP_WINDOW_HEIGHT : STARTUP_WINDOW_HEIGHT,
    resizable: false,
    minimizable: windows,
    maximizable: false,
    title: windows ? mainLocalization().getFixedT(null, 'native')('startup.title') : undefined,
    titleBarStyle: windows ? 'default' : 'hiddenInset',
    backgroundColor: STARTUP_WINDOW_BACKGROUND,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  if (process.platform === 'win32') screen.setMenu(null)
  let status: string = mainLocalization().getFixedT(null, 'foundation')('startup.preparing')
  let fraction: number | undefined
  let failure: { title: string; message: string } | undefined
  let loaded = false
  let closing = false
  let programmaticClose = false
  let closed = false
  let completeClose: () => void
  const completion = new Promise<void>((resolve) => {
    completeClose = resolve
  })
  let elapsedTimer: ReturnType<typeof setInterval> | undefined
  const stopTimer = (): void => {
    if (elapsedTimer !== undefined) clearInterval(elapsedTimer)
    elapsedTimer = undefined
  }
  const record = (event: string): void => {
    log(
      `[startup] window=${screen.id} event=${event} closing=${closing} failed=${!!failure} visible=${!screen.isDestroyed() && screen.isVisible()}\n`
    )
  }
  const elapsedLabel = mainLocalization().getFixedT(null, 'native')('startup.elapsed')
  const started = Date.now()
  const reveal = (): boolean => {
    if (closing || closed || screen.isDestroyed() || !allowed()) return false
    if (loaded) {
      if (screen.isMinimized()) screen.restore()
      screen.show()
    }
    return true
  }
  const renderStatus = (): void => {
    if (!loaded || closing || closed || screen.isDestroyed()) return
    void screen.webContents
      .executeJavaScript(
        `(() => {
        document.body.toggleAttribute(${JSON.stringify(STARTUP_FAILURE_ATTRIBUTE)}, ${!!failure});
        document.getElementById(${JSON.stringify(STARTUP_TITLE_ID)}).textContent = ${JSON.stringify(failure?.title ?? mainLocalization().getFixedT(null, 'foundation')('startup.brand'))};
        document.getElementById(${JSON.stringify(STARTUP_STATUS_ID)}).textContent = ${JSON.stringify(failure?.message ?? status)};
        const progress = document.getElementById(${JSON.stringify(STARTUP_PROGRESS_ID)});
        const fraction = ${fraction === undefined ? 'null' : JSON.stringify(fraction)};
        progress.setAttribute('aria-label', ${JSON.stringify(status)});
        if (fraction === null) {
          progress.removeAttribute('data-progress'); progress.removeAttribute('aria-valuenow');
        } else {
          progress.setAttribute('data-progress', '');
          progress.style.setProperty('--progress', (fraction * 100) + '%');
          progress.setAttribute('aria-valuenow', String(Math.floor(fraction * 100)));
        }
      })()`
      )
      .catch((error: unknown) => log(`[startup] status render failed: ${String(error)}\n`))
  }

  screen.webContents.once('did-finish-load', () => {
    record('loaded')
    if (closing || closed || screen.isDestroyed()) return
    loaded = true
    renderStatus()
    if (reveal()) {
      record('shown')
      onVisible?.()
    }
  })
  screen.on('focus', () => record('focus'))
  screen.on('blur', () => record('blur'))
  screen.on('close', () => {
    closing = true
    stopTimer()
    record('close-request')
  })
  screen.once('closed', () => {
    closing = true
    closed = true
    stopTimer()
    record('closed')
    completeClose()
    if (!programmaticClose) onDismiss?.()
  })
  record('created')
  void screen
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupDocument())}`)
    .catch((error: unknown) => {
      log(`[startup] document load failed: ${String(error)}\n`)
      stopTimer()
      if (!closing && !closed) {
        screen.destroy()
      }
    })
  if (windows)
    elapsedTimer = setInterval(() => {
      if (!loaded || closing || failure || screen.isDestroyed()) return
      const elapsed = `${elapsedLabel}${Math.floor((Date.now() - started) / 1000)}s`
      void screen.webContents
        .executeJavaScript(
          `document.getElementById(${JSON.stringify(STARTUP_ELAPSED_ID)}).textContent = ${JSON.stringify(elapsed)}`
        )
        .catch((error: unknown) => log(`[startup] elapsed render failed: ${String(error)}\n`))
    }, STARTUP_ELAPSED_INTERVAL_MS)

  return {
    setStatus(next: string, nextFraction?: number): void {
      if (failure || closing || closed) return
      status = next
      fraction =
        nextFraction !== undefined && Number.isFinite(nextFraction)
          ? Math.max(0, Math.min(1, nextFraction))
          : undefined
      renderStatus()
    },
    fail(title: string, message: string): boolean {
      if (closing || closed || screen.isDestroyed()) return false
      failure = { title, message }
      stopTimer()
      record('failed')
      renderStatus()
      reveal()
      return true
    },
    failed(): boolean {
      return failure !== undefined
    },
    isClosing(): boolean {
      return closing || closed
    },
    reveal,
    close(): Promise<void> {
      if (closing || closed) return completion
      programmaticClose = true
      closing = true
      stopTimer()
      if (!screen.isDestroyed()) screen.close()
      else completeClose()
      return completion
    },
  }
}
