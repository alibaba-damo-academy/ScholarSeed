import type { BrowserWindowConstructorOptions } from 'electron'
import { LOGIN_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM, WORKSPACE_WINDOW_SIZE } from '../window.ts'

export const WINDOWS_PLATFORM = 'win32'
const WORKSPACE_WINDOW_BACKGROUND = '#F8F8F5'
const WORKSPACE_TRAFFIC_LIGHT_POSITION = { x: 14, y: 16 } as const

export function createWorkspaceWindowOptions({
  platform,
  preload,
  icon,
}: {
  platform: NodeJS.Platform
  preload: string
  icon?: BrowserWindowConstructorOptions['icon']
}): BrowserWindowConstructorOptions {
  return {
    ...WORKSPACE_WINDOW_SIZE,
    useContentSize: true,
    minWidth: WORKSPACE_WINDOW_MINIMUM.width,
    minHeight: WORKSPACE_WINDOW_MINIMUM.height,
    ...(platform === WINDOWS_PLATFORM
      ? { icon }
      : {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { ...WORKSPACE_TRAFFIC_LIGHT_POSITION },
        }),
    backgroundColor: WORKSPACE_WINDOW_BACKGROUND,
    show: false,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  }
}

export function createStartupWindowHandoff(current: () => boolean, show: () => void) {
  let painted = false
  let permitted = false
  let shown = false
  const reveal = (): void => {
    if (!painted || !permitted || shown || !current()) return
    shown = true
    show()
  }
  return {
    painted(): void {
      painted = true
      reveal()
    },
    reused(): void {
      permitted = true
      reveal()
    },
    settled(): void {
      permitted = true
      reveal()
    },
  }
}

interface WindowHidingTarget {
  isDestroyed(): boolean
  isFullScreen(): boolean
  setFullScreen(fullscreen: boolean): void
  hide(): void
  once(event: 'leave-full-screen' | 'closed', listener: () => void): unknown
  removeListener(event: 'leave-full-screen', listener: () => void): unknown
}

export function createWindowHiding(
  window: WindowHidingTarget,
  allowed: () => boolean,
  onHidden?: () => void
) {
  let pending = false

  function cancel(): void {
    pending = false
    window.removeListener('leave-full-screen', finish)
  }

  function finish(): void {
    cancel()
    if (window.isDestroyed() || !allowed()) return
    window.hide()
    onHidden?.()
  }

  window.once('closed', cancel)

  return {
    cancel,
    hide(): void {
      if (window.isDestroyed() || !allowed() || pending) return
      if (!window.isFullScreen()) {
        finish()
        return
      }
      pending = true
      window.once('leave-full-screen', finish)
      try {
        window.setFullScreen(false)
      } catch (error) {
        cancel()
        throw error
      }
    },
  }
}

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

interface ApplicationWindow {
  getNormalBounds(): WindowBounds
  isMaximized(): boolean
  unmaximize(): void
  maximize(): void
  setMinimumSize(width: number, height: number): void
  setSize(width: number, height: number): void
  setBounds(bounds: WindowBounds): void
  center(): void
}

export function createLoginWindowSizing(
  window: ApplicationWindow,
  allowed: () => boolean = () => true
) {
  let workspace: { bounds: WindowBounds; maximized: boolean } | null = null
  let requested = false
  const apply = (): void => {
    if (!allowed()) return
    const visible = requested
    if (visible === Boolean(workspace)) return
    if (visible) {
      workspace = { bounds: window.getNormalBounds(), maximized: window.isMaximized() }
      if (workspace.maximized) window.unmaximize()
      window.setMinimumSize(LOGIN_WINDOW_SIZE.width, LOGIN_WINDOW_SIZE.height)
      window.setSize(LOGIN_WINDOW_SIZE.width, LOGIN_WINDOW_SIZE.height)
      window.center()
    } else if (workspace) {
      window.setMinimumSize(WORKSPACE_WINDOW_MINIMUM.width, WORKSPACE_WINDOW_MINIMUM.height)
      window.setBounds(workspace.bounds)
      if (workspace.maximized) window.maximize()
      workspace = null
    }
  }
  return Object.assign(
    (visible: boolean): void => {
      requested = visible
      apply()
    },
    { flush: apply }
  )
}
