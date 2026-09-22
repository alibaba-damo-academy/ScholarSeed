import {
  app,
  type BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type NativeImage
} from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import type { i18n } from 'i18next'
import { WINDOW_CLOSE_PLATFORM, WINDOW_CLOSE_REQUEST_CHANNEL, WINDOW_CLOSE_ACTION, isWindowCloseReply, type WindowCloseRequest } from '../window'

const TRAY_STATE_FILENAME = 'window-close-state.json'
const TEMPORARY_FILE_SUFFIX = '.tmp'
const PACKAGED_TRAY_ICON = 'windows-tray.ico'
const DEVELOPMENT_TRAY_ICON_SEGMENTS = ['resources', 'windows.ico'] as const
export interface WindowCloseState {
  askOnClose: boolean
}

interface WindowCloseStateStore {
  load(): WindowCloseState
  save(state: WindowCloseState): void
}

export interface WindowsCloseController {
  currentRequest(window: BrowserWindow): WindowCloseRequest
  respond(window: BrowserWindow, reply: unknown): boolean
  ensureTray(window: BrowserWindow): void
  handleClose(window: BrowserWindow, event: Electron.Event): void
}

interface WindowsCloseControllerOptions {
  localizer: () => i18n
  revealWindow: (reason: string) => boolean
  markQuitting: () => void
  log: (line: string) => void
  stateStore?: WindowCloseStateStore
  platform?: NodeJS.Platform
}

export function defaultWindowCloseState(): WindowCloseState {
  return { askOnClose: true }
}

export function sanitizeWindowCloseState(value: unknown): WindowCloseState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultWindowCloseState()
  const parsed = value as Partial<WindowCloseState>
  return { askOnClose: parsed.askOnClose !== false }
}

function statePath(): string {
  return join(app.getPath('userData'), TRAY_STATE_FILENAME)
}

export function windowCloseStateStore(): WindowCloseStateStore {
  return {
    load(): WindowCloseState {
      const path = statePath()
      if (!existsSync(path)) return defaultWindowCloseState()
      try {
        return sanitizeWindowCloseState(JSON.parse(readFileSync(path, 'utf8')))
      } catch {
        return defaultWindowCloseState()
      }
    },
    save(state: WindowCloseState): void {
      const path = statePath()
      const temporaryPath = path + TEMPORARY_FILE_SUFFIX
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temporaryPath, JSON.stringify(sanitizeWindowCloseState(state)), 'utf8')
      renameSync(temporaryPath, path)
    }
  }
}

function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, PACKAGED_TRAY_ICON)
    : join(app.getAppPath(), ...DEVELOPMENT_TRAY_ICON_SEGMENTS)
}

export function createWindowsTrayIcon(): NativeImage {
  const image = nativeImage.createFromPath(trayIconPath())
  return image.isEmpty() ? nativeImage.createFromNamedImage('NSApplicationIcon') : image
}

function hideWindowToTray(window: BrowserWindow, log: (line: string) => void): void {
  window.hide()
  log('[shell] Windows main window minimized to tray; renderer session remains attached\n')
}

export function createWindowsCloseController(options: WindowsCloseControllerOptions): WindowsCloseController {
  let tray: Tray | null = null
  let trayMenu: Menu | null = null
  let pendingWindow: BrowserWindow | null = null
  let requestId = 0
  const stateStore = options.stateStore ?? windowCloseStateStore()
  const platform = options.platform ?? process.platform

  function ensureTray(window: BrowserWindow): void {
    if (platform !== WINDOW_CLOSE_PLATFORM || tray) return
    const t = options.localizer().getFixedT(null, 'native')
    tray = new Tray(createWindowsTrayIcon())
    options.log(`[tray] created window=${window.id} destroyed=${tray.isDestroyed()}\n`)
    tray.setToolTip(t('tray.tooltip'))
    trayMenu = Menu.buildFromTemplate([
      {
        label: t('tray.show'),
        click: () => reveal('tray menu')
      },
      {
        label: t('tray.quit'),
        click: () => {
          options.log('[tray] quit selected\n')
          options.markQuitting()
          app.quit()
        }
      }
    ])
    trayMenu.on('menu-will-show', () => options.log('[tray] context menu opening\n'))
    trayMenu.on('menu-will-close', () => options.log('[tray] context menu closing\n'))
    tray.on('mouse-enter', () => options.log('[tray] mouse entered\n'))
    tray.on('right-click', () => {
      options.log(`[tray] right click window=${window.id} destroyed=${window.isDestroyed()}\n`)
      tray?.popUpContextMenu(trayMenu ?? undefined)
    })
    tray.on('double-click', () => reveal('tray double click'))
    tray.on('click', () => {
      options.log(`[tray] click window=${window.id} destroyed=${window.isDestroyed()}\n`)
      if (!window.isVisible()) reveal('tray click')
      else options.log('[tray] click skipped because window is visible\n')
    })
  }

  function reveal(reason: string): void {
    options.log(`[tray] reveal requested reason=${reason}\n`)
    const restored = options.revealWindow(reason)
    options.log(`[tray] reveal completed restored=${restored}\n`)
  }

  function currentRequest(window: BrowserWindow): WindowCloseRequest {
    return platform === WINDOW_CLOSE_PLATFORM && pendingWindow === window && !window.isDestroyed()
      ? requestId : null
  }

  function respond(window: BrowserWindow, reply: unknown): boolean {
    if (!isWindowCloseReply(reply) || currentRequest(window) !== reply.requestId) return false
    options.log(`[tray] close choice request=${reply.requestId} action=${reply.action} remember=${reply.remember}\n`)
    pendingWindow = null
    window.webContents.send(WINDOW_CLOSE_REQUEST_CHANNEL, null)
    if (reply.action === WINDOW_CLOSE_ACTION.cancel) return true
    if (reply.remember) {
      try {
        stateStore.save({ askOnClose: false })
      } catch (error) {
        options.log(`[shell] Windows close preference could not be saved: ${String(error)}\n`)
      }
    }
    if (reply.action === WINDOW_CLOSE_ACTION.minimize) {
      hideWindowToTray(window, options.log)
    } else {
      options.markQuitting()
      app.quit()
    }
    return true
  }

  function handleClose(window: BrowserWindow, event: Electron.Event): void {
    if (platform !== WINDOW_CLOSE_PLATFORM) return
    options.log(`[tray] close requested window=${window.id}\n`)
    event.preventDefault()
    ensureTray(window)
    if (pendingWindow === window) return
    const state = stateStore.load()
    if (!state.askOnClose) {
      hideWindowToTray(window, options.log)
      return
    }
    pendingWindow = window
    requestId += 1
    window.webContents.send(WINDOW_CLOSE_REQUEST_CHANNEL, requestId)
  }

  return { ensureTray, handleClose, currentRequest, respond }
}
