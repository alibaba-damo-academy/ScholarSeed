import { LOGIN_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM } from '../window.ts'

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

export function createLoginWindowSizing(window: ApplicationWindow): (visible: boolean) => void {
  let workspace: { bounds: WindowBounds; maximized: boolean } | null = null
  return (visible) => {
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
}
