import { randomUUID } from 'node:crypto'
import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  WebContentsView,
  WindowOpenHandlerResponse,
} from 'electron'
import {
  PORTAL_TIMEOUT,
  PORTAL_URL,
  parsePortalBounds,
  type PortalBounds,
  type PortalSurface,
} from '../portal.ts'
import { blocksRendererReload } from './reload.ts'
import { registerNativeLayer, raiseNativeLayers, isFrontmostNativeLayer } from './layers.ts'

const TRANSPARENT_BACKGROUND = '#00000000'
const DENIED = { ok: false } as const
const ACCEPTED = { ok: true } as const

interface PortalHostOptions {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  preload: string
  surface: PortalSurface
  createView(options: Electron.WebContentsViewConstructorOptions): WebContentsView
}
interface Presentation {
  sessionId: string
  view: WebContentsView | null
  keys: Set<string>
  closing: boolean
  shown: boolean
  bounds: PortalBounds | null
  returnFocus: boolean
  timer: ReturnType<typeof setTimeout>
  finish: ((reply: typeof ACCEPTED) => void)[]
}

export function createPortalHost(window: BrowserWindow, options: PortalHostOptions) {
  const product = window.webContents
  const { channels, modal, name } = options.surface
  let current: Presentation | null = null
  let disposed = false
  const valid = (event: IpcMainInvokeEvent): boolean =>
    !disposed &&
    !window.isDestroyed() &&
    !product.isDestroyed() &&
    event.sender === product &&
    event.senderFrame === product.mainFrame
  const retire = (notify = true): void => {
    const previous = current
    if (!previous) return
    current = null
    clearTimeout(previous.timer)
    const view = previous.view
    if (view) {
      if (!window.isDestroyed()) {
        view.setVisible(false)
        window.contentView.removeChildView(view)
      }
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    for (const finish of previous.finish) finish(ACCEPTED)
    if (notify && !product.isDestroyed() && !product.isCrashed())
      product.send(channels.revoked, previous.sessionId)
  }
  const layout = (): void => {
    if (!current?.view || window.isDestroyed()) return
    const bounds = window.getContentBounds()
    const zoom = product.getZoomFactor()
    const requested = current.bounds
    if (modal) current.view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
    else if (requested) {
      const left = Math.min(bounds.width, Math.floor(requested.x * zoom))
      const top = Math.min(bounds.height, Math.floor(requested.y * zoom))
      current.view.setBounds({
        x: left,
        y: top,
        width: Math.max(
          0,
          Math.min(bounds.width - left, Math.ceil((requested.x + requested.width) * zoom) - left)
        ),
        height: Math.max(
          0,
          Math.min(bounds.height - top, Math.ceil((requested.y + requested.height) * zoom) - top)
        ),
      })
    } else
      current.view.setBounds({
        x: Math.max(0, bounds.width - 1),
        y: Math.max(0, bounds.height - 1),
        width: 1,
        height: 1,
      })
    current.view.webContents.setZoomFactor(zoom)
  }
  options.ipc.handle(channels.reserve, (event, ...args: unknown[]) => {
    if (!valid(event) || args.length || current?.keys.size) return DENIED
    retire()
    const sessionId = randomUUID()
    const timer = setTimeout(() => {
      if (current?.sessionId === sessionId) retire()
    }, PORTAL_TIMEOUT)
    current = {
      sessionId,
      view: null,
      keys: new Set(),
      closing: false,
      shown: false,
      bounds: null,
      returnFocus: false,
      timer,
      finish: [],
    }
    return { ok: true, sessionId }
  })
  options.ipc.handle(channels.paint, (event, ...args: unknown[]) => {
    if (
      !valid(event) ||
      args.length !== 1 ||
      !current ||
      current.sessionId !== args[0] ||
      !current.view ||
      current.closing
    )
      return DENIED
    clearTimeout(current.timer)
    layout()
    current.view.setVisible(modal || current.bounds !== null)
    current.shown = true
    if (modal && window.isFocused()) current.view.webContents.focus()
    return ACCEPTED
  })
  if (channels.place)
    options.ipc.handle(channels.place, (event, ...args: unknown[]) => {
      if (
        !valid(event) ||
        args.length !== 2 ||
        !current ||
        current.sessionId !== args[0] ||
        current.closing
      )
        return DENIED
      const bounds = args[1] === null ? null : parsePortalBounds(args[1])
      if (args[1] !== null && !bounds) return DENIED
      current.bounds = bounds
      layout()
      if (current.view && current.shown) current.view.setVisible(bounds !== null)
      if (!bounds) current.keys.clear()
      return ACCEPTED
    })
  options.ipc.handle(channels.close, (event, ...args: unknown[]) => {
    if (!valid(event) || args.length !== 1 || !current || current.sessionId !== args[0])
      return DENIED
    current.closing = true
    current.returnFocus = modal || Boolean(current.view?.webContents.isFocused())
    if (!current.keys.size) {
      const restore = current.returnFocus
      retire(false)
      if (restore && window.isFocused()) product.focus()
      return ACCEPTED
    }
    return new Promise<typeof ACCEPTED>((resolve) => current!.finish.push(resolve))
  })
  const navigate = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame && !inPlace) retire()
  }
  const revoke = (): void => retire()
  const blur = (): void => {
    current?.keys.clear()
    if (current?.closing) retire(false)
  }
  const restoreFocus = (): void => {
    if (
      modal &&
      current?.shown &&
      !current.closing &&
      current.view &&
      !current.view.webContents.isDestroyed() &&
      isFrontmostNativeLayer(window, current.view) &&
      window.isFocused()
    )
      current.view.webContents.focus()
  }
  const guardProductInput = (event: Electron.Event): void => {
    if (modal && current) {
      event.preventDefault()
      restoreFocus()
    }
  }
  window.on('resize', layout)
  window.on('blur', blur)
  window.on('focus', restoreFocus)
  product.on('focus', restoreFocus)
  product.on('before-input-event', guardProductInput)
  product.on('did-start-navigation', navigate)
  product.on('render-process-gone', revoke)
  product.on('destroyed', revoke)
  return {
    owns(sessionId: unknown): boolean {
      return current !== null && current.sessionId === sessionId
    },
    raise(): void {
      raiseNativeLayers(window)
    },
    windowOpen(
      details: Pick<Electron.HandlerDetails, 'url' | 'frameName'>
    ): WindowOpenHandlerResponse | null {
      if (!details.frameName.startsWith(name)) return null
      const pending = current
      if (
        !pending ||
        pending.view ||
        pending.closing ||
        details.url !== PORTAL_URL ||
        details.frameName !== name + pending.sessionId
      )
        return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            preload: options.preload,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        },
        createWindow(preferences) {
          if (current !== pending || pending.view || disposed)
            throw new Error('settings_reservation_revoked')
          const view = options.createView(preferences)
          pending.view = view
          view.setBackgroundColor(TRANSPARENT_BACKGROUND)
          view.setVisible(false)
          window.contentView.addChildView(view)
          registerNativeLayer(window, view, options.surface.layer)
          layout()
          view.setVisible(true)
          raiseNativeLayers(window)
          const contents = view.webContents
          contents.setWindowOpenHandler(() => ({ action: 'deny' }))
          contents.on('will-navigate', (event) => event.preventDefault())
          contents.on('will-attach-webview', (event) => event.preventDefault())
          contents.on('render-process-gone', () => {
            if (current === pending) retire()
          })
          contents.on('destroyed', () => {
            if (current === pending) retire()
          })
          contents.on('before-input-event', (event, input) => {
            if (blocksRendererReload(input)) event.preventDefault()
            if (current !== pending) return
            if (
              !pending.shown ||
              pending.closing ||
              (!modal && !pending.bounds) ||
              (modal && !isFrontmostNativeLayer(window, view))
            )
              event.preventDefault()
            if (input.type === 'keyDown') pending.keys.add(input.code)
            if (input.type === 'keyUp') pending.keys.delete(input.code)
            if (pending.closing && !pending.keys.size) {
              retire(false)
              if (pending.returnFocus && !window.isDestroyed() && window.isFocused())
                product.focus()
            }
          })
          return contents
        },
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      retire(false)
      window.removeListener('resize', layout)
      window.removeListener('blur', blur)
      window.removeListener('focus', restoreFocus)
      product.removeListener('focus', restoreFocus)
      product.removeListener('before-input-event', guardProductInput)
      product.removeListener('did-start-navigation', navigate)
      product.removeListener('render-process-gone', revoke)
      product.removeListener('destroyed', revoke)
      for (const channel of [
        channels.reserve,
        channels.paint,
        channels.close,
        ...(channels.place ? [channels.place] : []),
      ])
        options.ipc.removeHandler(channel)
    },
  }
}

export function createPortalGroup(
  window: BrowserWindow,
  { capacity, ...options }: PortalHostOptions & { capacity: number }
) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('invalid_portal_capacity')
  let disposed = false
  const slots = Array.from({ length: capacity }, () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const host = createPortalHost(window, {
      ...options,
      ipc: {
        handle: (channel, listener) => {
          handlers.set(channel, listener)
        },
        removeHandler: (channel) => {
          handlers.delete(channel)
        },
      },
    })
    return { host, handlers, sessionId: null as string | null }
  })
  const { channels, name } = options.surface
  const owned = (sessionId: unknown) => slots.find((slot) => slot.host.owns(sessionId))
  options.ipc.handle(channels.reserve, (event, ...args: unknown[]) => {
    if (disposed) return DENIED
    const slot = slots.find((candidate) => !candidate.host.owns(candidate.sessionId))
    if (!slot) return DENIED
    const reply = slot.handlers.get(channels.reserve)!(event, ...args) as {
      ok: boolean
      sessionId?: string
    }
    if (reply.ok && reply.sessionId) slot.sessionId = reply.sessionId
    return reply
  })
  const routed = [channels.paint, channels.close, ...(channels.place ? [channels.place] : [])]
  for (const channel of routed)
    options.ipc.handle(channel, (event, ...args: unknown[]) => {
      if (disposed) return DENIED
      const slot = owned(args[0])
      return slot ? slot.handlers.get(channel)!(event, ...args) : DENIED
    })
  return {
    owns(sessionId: unknown): boolean {
      return !disposed && Boolean(owned(sessionId))
    },
    raise(): void {
      raiseNativeLayers(window)
    },
    windowOpen(
      details: Pick<Electron.HandlerDetails, 'url' | 'frameName'>
    ): WindowOpenHandlerResponse | null {
      if (!details.frameName.startsWith(name)) return null
      if (disposed) return { action: 'deny' }
      return (
        owned(details.frameName.slice(name.length))?.host.windowOpen(details) ?? { action: 'deny' }
      )
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const slot of slots) slot.host.dispose()
      for (const channel of [channels.reserve, ...routed]) options.ipc.removeHandler(channel)
    },
  }
}
