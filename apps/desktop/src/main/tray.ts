import { applicationResources } from './resources.ts'
import {
  app,
  type BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  type NativeImage,
  type MenuItemConstructorOptions,
} from 'electron'
import { existsSync } from 'fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'path'
import { desktopStorage } from './storage'
import { desktopDirectoryWriter } from './writer'
import { readRecord, writeJson } from './journal.ts'
import {
  defaultWindowCloseState,
  sanitizeWindowCloseState,
  decodeWindowCloseState,
  TRAY_STATE_FILENAME,
  TRAY_STATE_MAX_BYTES,
  type WindowCloseState,
} from './window-record.ts'
export {
  defaultWindowCloseState,
  sanitizeWindowCloseState,
  type WindowCloseState,
} from './window-record.ts'

import type { i18n } from 'i18next'
import {
  isTrayReply,
  TRAY_ACTION,
  TRAY_REFRESH_TIMEOUT_MS,
  type TrayNavigation,
  type TraySnapshot,
} from '../tray.ts'
import {
  WINDOW_CLOSE_PLATFORM,
  WINDOW_CLOSE_REQUEST_CHANNEL,
  WINDOW_CLOSE_ACTION,
  isWindowCloseReply,
  type WindowCloseRequest,
} from '../window'

const PACKAGED_TRAY_ICON = 'tray.ico'
const WINDOWS_DARK_TRAY_ICON = 'tray-white.ico'
const WINDOWS_THEME_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
const WINDOWS_THEME_VALUE = 'SystemUsesLightTheme'
const WINDOWS_REGISTRY_DIRECTORY = 'System32'
const WINDOWS_REGISTRY_EXECUTABLE = 'reg.exe'
const WINDOWS_THEME_QUERY_TIMEOUT_MS = 2000
const WINDOWS_THEME_DARK_VALUE = '0x0'
const WINDOWS_THEME_LIGHT_VALUE = '0x1'
const MACOS_PLATFORM = 'darwin'
const MACOS_TRAY_ICON = 'tray.png'
const MACOS_TRAY_ICON_SIZE = 18
const TRAY_LABEL_WIDTH = 48
const TRAY_ASCII_WIDTH = 1
const TRAY_WIDE_WIDTH = 2
const TRAY_LABEL_ELLIPSIS = '…'
const TRAY_LABEL_PREFIX_SHARE = 2 / 3
const trayLabelSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function labelWidth(value: string): number {
  return Array.from(trayLabelSegmenter.segment(value)).reduce(
    (width, { segment }) =>
      width + (/^[\x20-\x7e]$/u.test(segment) ? TRAY_ASCII_WIDTH : TRAY_WIDE_WIDTH),
    0
  )
}

function shortenLabel(value: string, budget: number): string {
  if (labelWidth(value) <= budget) return value
  const available = Math.max(0, budget - labelWidth(TRAY_LABEL_ELLIPSIS))
  const prefixBudget = Math.floor(available * TRAY_LABEL_PREFIX_SHARE)
  const segments = Array.from(trayLabelSegmenter.segment(value), ({ segment }) => segment)
  let prefix = ''
  let suffix = ''
  for (const segment of segments) {
    if (labelWidth(prefix + segment) > prefixBudget) break
    prefix += segment
  }
  const suffixBudget = available - labelWidth(prefix)
  for (const segment of segments.reverse()) {
    if (labelWidth(segment + suffix) > suffixBudget) break
    suffix = segment + suffix
  }
  return prefix + TRAY_LABEL_ELLIPSIS + suffix
}

interface WindowCloseStateStore {
  load(): WindowCloseState
  save(state: WindowCloseState): void
}

export interface WindowController {
  currentRequest(window: BrowserWindow): WindowCloseRequest
  respond(window: BrowserWindow, reply: unknown): boolean
  ensureTray(window: BrowserWindow): void
  handleClose(window: BrowserWindow, event: Electron.Event): void
  respondTray(window: BrowserWindow, reply: unknown): boolean
}

interface WindowControllerOptions {
  localizer: () => i18n
  revealWindow: (reason: string) => boolean
  markQuitting: () => void
  log: (line: string) => void
  requestSnapshot: (requestId: number) => boolean
  navigate: (target: TrayNavigation) => void
  stateStore?: WindowCloseStateStore
  platform?: NodeJS.Platform
}

function statePath(): string {
  return join(desktopStorage().userData, TRAY_STATE_FILENAME)
}

export function windowCloseStateStore(): WindowCloseStateStore {
  return {
    load(): WindowCloseState {
      const path = statePath()
      if (!existsSync(path)) return defaultWindowCloseState()
      try {
        return decodeWindowCloseState(readRecord(path, TRAY_STATE_MAX_BYTES))
      } catch {
        return defaultWindowCloseState()
      }
    },
    save(state: WindowCloseState): void {
      const path = statePath()
      const writer = desktopDirectoryWriter(dirname(path))
      try {
        writeJson(path, sanitizeWindowCloseState(state))
      } finally {
        writer.close()
      }
    },
  }
}

function windowsSystemDark(log: (line: string) => void): boolean {
  try {
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot is unavailable')
    const output = execFileSync(
      join(systemRoot, WINDOWS_REGISTRY_DIRECTORY, WINDOWS_REGISTRY_EXECUTABLE),
      ['query', WINDOWS_THEME_KEY, '/v', WINDOWS_THEME_VALUE],
      { encoding: 'utf8', windowsHide: true, timeout: WINDOWS_THEME_QUERY_TIMEOUT_MS }
    )
    const value = output
      .match(
        new RegExp(`^\\s*${WINDOWS_THEME_VALUE}\\s+REG_DWORD\\s+(0x[0-9a-f]+)\\s*$`, 'im')
      )?.[1]
      ?.toLowerCase()
    if (value === WINDOWS_THEME_DARK_VALUE) return true
    if (value === WINDOWS_THEME_LIGHT_VALUE) return false
    throw new Error('SystemUsesLightTheme is missing or invalid')
  } catch (error) {
    log(`[tray] Windows system theme query failed; using Electron theme: ${String(error)}\n`)
    return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
  }
}

function trayIconPath(platform: NodeJS.Platform, log: (line: string) => void): string {
  const filename =
    platform === WINDOW_CLOSE_PLATFORM && windowsSystemDark(log)
      ? WINDOWS_DARK_TRAY_ICON
      : PACKAGED_TRAY_ICON
  return app.isPackaged
    ? join(applicationResources(app), filename)
    : join(app.getAppPath(), 'resources', filename)
}

export function createTrayIcon(
  platform: NodeJS.Platform = process.platform,
  log: (line: string) => void = console.warn
): NativeImage {
  if (platform === MACOS_PLATFORM) {
    const root = app.isPackaged ? applicationResources(app) : join(app.getAppPath(), 'resources')
    const image = nativeImage
      .createFromPath(join(root, MACOS_TRAY_ICON))
      .resize({ width: MACOS_TRAY_ICON_SIZE, height: MACOS_TRAY_ICON_SIZE })
    image.setTemplateImage(true)
    return image
  }
  const image = nativeImage.createFromPath(trayIconPath(platform, log))
  return image.isEmpty() ? nativeImage.createFromNamedImage('NSApplicationIcon') : image
}

function hideWindowToTray(window: BrowserWindow, log: (line: string) => void): void {
  window.hide()
  log('[shell] Windows main window minimized to tray; renderer session remains attached\n')
}

export function createWindowController(options: WindowControllerOptions): WindowController {
  let tray: Tray | null = null
  let trayMenu: Menu | null = null
  let pendingWindow: BrowserWindow | null = null
  let requestId = 0
  let trayRequestId = 0
  let trayRequest: {
    window: BrowserWindow
    id: number
    timer: ReturnType<typeof setTimeout>
    show: (snapshot: TraySnapshot | null) => void
  } | null = null
  const stateStore = options.stateStore ?? windowCloseStateStore()
  const platform = options.platform ?? process.platform

  function ensureTray(window: BrowserWindow): void {
    if (
      (platform !== WINDOW_CLOSE_PLATFORM && platform !== MACOS_PLATFORM) ||
      tray ||
      window.isDestroyed()
    )
      return
    const windowId = window.id
    const ownedTray = new Tray(createTrayIcon(platform, options.log))
    tray = ownedTray
    // Native events can remain queued while Electron tears down the window.
    // Bind every action to this tray generation, not a later replacement.
    const active = (): boolean =>
      tray === ownedTray && !ownedTray.isDestroyed() && !window.isDestroyed()
    const updateTheme = (): void => {
      if (active()) ownedTray.setImage(createTrayIcon(platform, options.log))
    }
    if (platform === WINDOW_CLOSE_PLATFORM) nativeTheme.on('updated', updateTheme)
    options.log(`[tray] created window=${window.id} destroyed=${tray.isDestroyed()}\n`)
    const buildMenu = (snapshot: TraySnapshot | null): Menu => {
      const t = options.localizer().getFixedT(null, 'native')
      const title = (
        value: string,
        format = (name: string): string => name
      ): Pick<MenuItemConstructorOptions, 'label' | 'toolTip' | 'accessibilityLabel'> => {
        const normalized = value.replace(/\s+/gu, ' ').trim()
        const fullLabel = format(normalized)
        return {
          label: format(shortenLabel(normalized, TRAY_LABEL_WIDTH - labelWidth(format('')))),
          accessibilityLabel: fullLabel,
          ...(platform === MACOS_PLATFORM ? { toolTip: fullLabel } : {}),
        }
      }
      ownedTray.setToolTip(t('tray.tooltip'))
      trayMenu?.removeAllListeners()
      const items: MenuItemConstructorOptions[] = []
      const navigate = (target: TrayNavigation): void => {
        if (!active() || trayMenu !== menu) return
        if (reveal('tray navigation')) options.navigate(target)
      }
      if (snapshot?.project) {
        const projectId = snapshot.project.id
        items.push(
          {
            ...title(snapshot.project.name, (name) => t('tray.openProject', { name })),
            click: () => navigate({ kind: TRAY_ACTION.project, projectId }),
          },
          {
            label: t('tray.newSession'),
            click: () => navigate({ kind: TRAY_ACTION.create, projectId }),
          }
        )
        if (snapshot.sessions.length) {
          items.push({ label: t('tray.recentSessions'), enabled: false })
          for (const session of snapshot.sessions)
            items.push({
              ...title(session.title),
              click: () =>
                navigate({ kind: TRAY_ACTION.session, projectId, sessionId: session.id }),
            })
        }
      } else {
        items.push({
          label: t('tray.show'),
          click: () => {
            if (active() && trayMenu === menu) reveal('tray menu')
          },
        })
        if (!snapshot) items.push({ label: t('tray.unavailable'), enabled: false })
      }
      items.push(
        { type: 'separator' },
        { label: t('tray.literature'), click: () => navigate({ kind: TRAY_ACTION.literature }) },
        { type: 'separator' },
        {
          label: t('tray.quit'),
          click: () => {
            if (!active() || trayMenu !== menu) return
            options.log('[tray] quit selected\n')
            options.markQuitting()
            app.quit()
          },
        }
      )
      const menu = Menu.buildFromTemplate(items)
      menu.on('menu-will-show', () => options.log('[tray] context menu opening\n'))
      menu.on('menu-will-close', () => options.log('[tray] context menu closing\n'))
      trayMenu = menu
      return menu
    }
    buildMenu(null)
    const openMenu = (): void => {
      if (!active() || trayRequest) return
      trayMenu?.removeAllListeners()
      trayMenu = null
      const id = ++trayRequestId
      const show = (snapshot: TraySnapshot | null): void => {
        if (active()) ownedTray.popUpContextMenu(buildMenu(snapshot))
      }
      const timer = setTimeout(() => {
        if (trayRequest?.id !== id) return
        trayRequest = null
        options.log('[tray] refresh unavailable\n')
        show(null)
      }, TRAY_REFRESH_TIMEOUT_MS)
      timer.unref?.()
      trayRequest = { window, id, timer, show }
      if (!options.requestSnapshot(id)) {
        clearTimeout(timer)
        trayRequest = null
        show(null)
      }
    }
    window.once('closed', () => {
      if (tray !== ownedTray) return
      if (platform === WINDOW_CLOSE_PLATFORM) nativeTheme.removeListener('updated', updateTheme)
      // Revoke callbacks before releasing native resources (including any
      // menu callback retained by the OS during a pending quit).
      tray = null
      trayMenu?.removeAllListeners()
      trayMenu = null
      if (trayRequest?.window === window) {
        clearTimeout(trayRequest.timer)
        trayRequest = null
      }
      if (pendingWindow === window) pendingWindow = null
      ownedTray.removeAllListeners()
      if (!ownedTray.isDestroyed()) ownedTray.destroy()
      options.log(`[tray] disposed window=${windowId}\n`)
    })
    tray.on('mouse-enter', () => {
      if (active()) options.log('[tray] mouse entered\n')
    })
    tray.on('right-click', () => {
      if (!active()) return
      options.log(`[tray] right click window=${windowId} destroyed=${window.isDestroyed()}\n`)
      openMenu()
    })
    tray.on('click', () => {
      if (!active()) return
      options.log(`[tray] click window=${windowId} destroyed=${window.isDestroyed()}\n`)
      openMenu()
    })
  }

  function respondTray(window: BrowserWindow, reply: unknown): boolean {
    if (
      !isTrayReply(reply) ||
      !trayRequest ||
      trayRequest.window !== window ||
      window.isDestroyed() ||
      reply.requestId !== trayRequest.id
    )
      return false
    const pending = trayRequest
    trayRequest = null
    clearTimeout(pending.timer)
    pending.show(reply.snapshot)
    return true
  }

  function reveal(reason: string): boolean {
    options.log(`[tray] reveal requested reason=${reason}\n`)
    const restored = options.revealWindow(reason)
    options.log(`[tray] reveal completed restored=${restored}\n`)
    return restored
  }

  function currentRequest(window: BrowserWindow): WindowCloseRequest {
    return platform === WINDOW_CLOSE_PLATFORM && pendingWindow === window && !window.isDestroyed()
      ? requestId
      : null
  }

  function respond(window: BrowserWindow, reply: unknown): boolean {
    if (!isWindowCloseReply(reply) || currentRequest(window) !== reply.requestId) return false
    options.log(
      `[tray] close choice request=${reply.requestId} action=${reply.action} remember=${reply.remember}\n`
    )
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

  return { ensureTray, handleClose, currentRequest, respond, respondTray }
}
