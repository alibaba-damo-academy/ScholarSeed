import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  nativeImage,
  type MessageBoxReturnValue,
  type NativeImage
} from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import type { i18n } from 'i18next'

const WINDOWS_PLATFORM = 'win32'
const TRAY_STATE_FILENAME = 'window-close-state.json'
const TEMPORARY_FILE_SUFFIX = '.tmp'
const PACKAGED_TRAY_ICON = 'windows-tray.png'
const DEVELOPMENT_TRAY_ICON_SEGMENTS = ['resources', 'windows.png'] as const
const CLOSE_DIALOG_MINIMIZE_INDEX = 0
const CLOSE_DIALOG_QUIT_INDEX = 1

export interface WindowCloseState {
  askOnClose: boolean
}

interface WindowCloseStateStore {
  load(): WindowCloseState
  save(state: WindowCloseState): void
}

export interface WindowsCloseController {
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

async function askWindowsCloseAction(window: BrowserWindow, localizer: () => i18n): Promise<MessageBoxReturnValue> {
  const t = localizer().getFixedT(null, 'native')
  return dialog.showMessageBox(window, {
    type: 'question',
    title: t('tray.closeTitle'),
    message: t('tray.closeMessage'),
    detail: t('tray.closeDetail'),
    buttons: [t('tray.minimize'), t('tray.quit'), t('tray.cancel')],
    defaultId: CLOSE_DIALOG_MINIMIZE_INDEX,
    cancelId: 2,
    checkboxLabel: t('tray.doNotAskAgain'),
    checkboxChecked: false,
    noLink: true
  })
}

export function createWindowsCloseController(options: WindowsCloseControllerOptions): WindowsCloseController {
  let tray: Tray | null = null
  const stateStore = options.stateStore ?? windowCloseStateStore()
  const platform = options.platform ?? process.platform

  function ensureTray(window: BrowserWindow): void {
    if (platform !== WINDOWS_PLATFORM || tray) return
    const t = options.localizer().getFixedT(null, 'native')
    tray = new Tray(createWindowsTrayIcon())
    tray.setToolTip(t('tray.tooltip'))
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: t('tray.show'),
        click: () => options.revealWindow('tray menu')
      },
      {
        label: t('tray.quit'),
        click: () => {
          options.markQuitting()
          app.quit()
        }
      }
    ]))
    tray.on('double-click', () => options.revealWindow('tray double click'))
    tray.on('click', () => {
      if (!window.isVisible()) options.revealWindow('tray click')
    })
  }

  function handleClose(window: BrowserWindow, event: Electron.Event): void {
    if (platform !== WINDOWS_PLATFORM) return
    ensureTray(window)
    const state = stateStore.load()
    if (!state.askOnClose) {
      event.preventDefault()
      hideWindowToTray(window, options.log)
      return
    }

    event.preventDefault()
    void askWindowsCloseAction(window, options.localizer).then((result) => {
      if (window.isDestroyed()) return
      if (result.response === CLOSE_DIALOG_MINIMIZE_INDEX) {
        if (result.checkboxChecked) stateStore.save({ askOnClose: false })
        hideWindowToTray(window, options.log)
        return
      }
      if (result.response === CLOSE_DIALOG_QUIT_INDEX) {
        if (result.checkboxChecked) stateStore.save({ askOnClose: false })
        options.markQuitting()
        app.quit()
      }
    }).catch((error) => options.log(`[shell] Windows close confirmation failed: ${String(error)}\n`))
  }

  return { ensureTray, handleClose }
}
