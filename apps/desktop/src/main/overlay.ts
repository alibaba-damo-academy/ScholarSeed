import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Session,
  WebContentsView,
  WebPreferences,
} from 'electron'
import { BROWSER_ERROR } from '../browser.ts'
import {
  OVERLAY_CHANNEL,
  TOOLTIP_OVERLAY_ARGUMENT,
  overlayBounds,
  parseBrowserOverlayEvent,
  parseBrowserOverlayModel,
} from '../overlay.ts'
import type { BrowserOverlayEvent, BrowserOverlayModel, OverlayReply } from '../overlay.ts'

const OVERLAY_ENTRY = 'overlay.html'
const OVERLAY_RESOURCE_DIRECTORIES = ['assets', 'fonts'] as const
const OVERLAY_DENIED = { action: 'deny' } as const
const SUCCESS = { ok: true } as const
const TRANSPARENT_BACKGROUND = '#00000000'
interface OverlayOptions {
  channels?: { [Key in keyof typeof OVERLAY_CHANNEL]: string }
  tooltip?: boolean
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>
  directory: string
  preload: string
  createSession(): Session
  createView(preferences: WebPreferences): WebContentsView
}
export interface BrowserOverlayOwner {
  publish(model: unknown): Promise<OverlayReply>
  dismiss(): void
  focus(): void
  dispose(): void
}
export function overlayResources(directory: string, entryName = OVERLAY_ENTRY): Set<string> {
  const root = realpathSync(directory)
  const entry = realpathSync(join(root, entryName))
  const entryRelative = relative(root, entry)
  if (entryRelative.startsWith('..') || isAbsolute(entryRelative))
    throw new Error(BROWSER_ERROR.operationFailed)
  const resources = new Set<string>([pathToFileURL(join(root, entryName)).href])
  const scan = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const child = join(path, entry.name)
      const resolved = realpathSync(child)
      const containment = relative(root, resolved)
      if (containment.startsWith('..') || isAbsolute(containment)) continue
      if (entry.isDirectory()) scan(child)
      else if (entry.isFile()) resources.add(pathToFileURL(resolved).href)
    }
  }
  for (const name of OVERLAY_RESOURCE_DIRECTORIES) {
    const directory = join(root, name)
    if (existsSync(directory)) scan(directory)
  }
  return resources
}
export function createBrowserOverlay(
  window: BrowserWindow,
  options: OverlayOptions
): BrowserOverlayOwner {
  const channels = options.channels ?? OVERLAY_CHANNEL
  const product = window.webContents
  const removers: (() => void)[] = []
  let disposed = false
  let current: BrowserOverlayModel | null = null
  let highestRevision = 0
  let view: WebContentsView | null = null
  let overlaySession: Session | null = null
  let loading: Promise<void> | null = null
  let ready = false
  let loaded = false
  const listen = (
    emitter: NodeJS.EventEmitter,
    name: string,
    listener: Parameters<NodeJS.EventEmitter['on']>[1]
  ): void => {
    emitter.on(name, listener)
    removers.push(() => emitter.removeListener(name, listener))
  }
  const notify = (event: BrowserOverlayEvent): void => {
    if (!disposed && !product.isDestroyed()) product.send(channels.event, event)
  }
  const dismiss = (): void => {
    const previous = current
    current = null
    view?.setVisible(false)
    if (previous) notify({ kind: 'dismiss', revision: previous.revision })
  }
  const eligible = (): boolean =>
    !disposed &&
    !window.isDestroyed() &&
    window.isFocused() &&
    window.isVisible() &&
    !window.isMinimized()
  const render = (): void => {
    if (!eligible()) {
      dismiss()
      return
    }
    if (!current || !view || !ready || !loaded) return
    const [width, height] = window.getContentSize()
    const zoom = product.getZoomFactor()
    const bounds = overlayBounds(current.bounds, zoom, { width, height })
    if (!bounds.width || !bounds.height) {
      dismiss()
      return
    }
    view.webContents.setZoomFactor(zoom)
    view.setBounds(bounds)
    view.webContents.send(channels.model, current)
    window.contentView.addChildView(view)
    view.setVisible(true)
  }
  const ensureView = (): Promise<void> => {
    if (loading) return loading
    const resources = overlayResources(options.directory)
    const entry = pathToFileURL(join(realpathSync(options.directory), OVERLAY_ENTRY)).href
    const isolated = options.createSession()
    overlaySession = isolated
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !resources.has(details.url) })
    )
    listen(isolated, 'will-download', (event) => event.preventDefault())
    view = options.createView({
      session: isolated,
      preload: options.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      ...(options.tooltip ? { additionalArguments: [TOOLTIP_OVERLAY_ARGUMENT] } : {}),
    })
    view.setVisible(false)
    if (options.tooltip) view.setBackgroundColor(TRANSPARENT_BACKGROUND)
    const contents = view.webContents
    contents.setWindowOpenHandler(() => OVERLAY_DENIED)
    for (const name of [
      'will-navigate',
      'will-frame-navigate',
      'will-redirect',
      'will-attach-webview',
    ]) {
      listen(contents, name, (event) => event.preventDefault())
    }
    listen(contents, 'render-process-gone', dismiss)
    loading = contents.loadURL(entry).then(() => {
      loaded = true
      render()
    })
    return loading
  }
  const publish = async (value: unknown): Promise<OverlayReply> => {
    let publishingRevision: number | null = null
    try {
      if (disposed) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
      const model = parseBrowserOverlayModel(value)
      if (Boolean(options.tooltip) !== (model.tooltip !== undefined))
        throw new Error(BROWSER_ERROR.invalidCommand)
      if (model.revision <= highestRevision) throw new Error(BROWSER_ERROR.invalidCommand)
      highestRevision = model.revision
      publishingRevision = model.revision
      current = model
      if (!eligible()) {
        dismiss()
        return SUCCESS
      }
      view?.setVisible(false)
      await ensureView()
      if (current?.revision === model.revision) render()
      return SUCCESS
    } catch (error) {
      if (publishingRevision !== null && current?.revision === publishingRevision) dismiss()
      return {
        ok: false,
        error:
          error instanceof Error && error.message === BROWSER_ERROR.invalidCommand
            ? BROWSER_ERROR.invalidCommand
            : BROWSER_ERROR.operationFailed,
      }
    }
  }
  const focus = (): void => {
    if (!eligible()) {
      dismiss()
      return
    }
    if (!options.tooltip && current && ready && !disposed && view?.getVisible()) {
      const revision = current.revision
      view.webContents.focus()
      if (current?.revision === revision && view.getVisible() && !disposed) {
        view.webContents.send(channels.focusRequest, revision)
      }
    }
  }
  const validate = (
    event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
    overlay = false
  ): void => {
    const expected = overlay ? view?.webContents : product
    if (
      disposed ||
      !expected ||
      expected.isDestroyed() ||
      event.sender !== expected ||
      event.senderFrame !== expected.mainFrame
    ) {
      throw new Error(BROWSER_ERROR.invalidSender)
    }
  }
  const handle = (
    channel: string,
    action: (event: IpcMainInvokeEvent, args: unknown[]) => unknown
  ): void => {
    options.ipc.handle(channel, (event, ...args: unknown[]) => action(event, args))
    removers.push(() => options.ipc.removeHandler(channel))
  }
  const dismissSynchronously = (event: IpcMainEvent, ...args: unknown[]): void => {
    try {
      validate(event)
      if (args.length) throw new Error(BROWSER_ERROR.invalidCommand)
      dismiss()
      event.returnValue = SUCCESS
    } catch (error) {
      event.returnValue = {
        ok: false,
        error:
          error instanceof Error && error.message === BROWSER_ERROR.invalidSender
            ? BROWSER_ERROR.invalidSender
            : BROWSER_ERROR.invalidCommand,
      }
    }
  }
  options.ipc.on(channels.dismissSync, dismissSynchronously)
  removers.push(() => options.ipc.removeListener(channels.dismissSync, dismissSynchronously))
  handle(channels.publish, (event, args) => {
    validate(event)
    if (args.length !== 1) return { ok: false, error: BROWSER_ERROR.invalidCommand }
    return publish(args[0])
  })
  handle(channels.seed, (event, args) => {
    validate(event)
    if (args.length) throw new Error(BROWSER_ERROR.invalidCommand)
    return highestRevision
  })
  for (const [channel, action] of [
    [channels.dismiss, dismiss],
    [channels.focus, focus],
  ] as const) {
    handle(channel, (event, args) => {
      validate(event)
      if (args.length) return { ok: false, error: BROWSER_ERROR.invalidCommand }
      action()
      return SUCCESS
    })
  }
  handle(channels.ready, (event, args) => {
    validate(event, true)
    if (args.length) return { ok: false, error: BROWSER_ERROR.invalidCommand }
    ready = true
    render()
    return SUCCESS
  })
  handle(channels.event, (event, args): OverlayReply => {
    validate(event, true)
    try {
      if (args.length !== 1) throw new Error(BROWSER_ERROR.invalidCommand)
      const response = parseBrowserOverlayEvent(args[0])
      if (options.tooltip && response.kind !== 'dismiss')
        throw new Error(BROWSER_ERROR.invalidCommand)
      if (!eligible()) dismiss()
      if (
        !current ||
        response.revision !== current.revision ||
        (response.kind === 'select' && !current.items.some((item) => item.id === response.itemId))
      ) {
        throw new Error(BROWSER_ERROR.invalidCommand)
      }
      current = null
      view?.setVisible(false)
      if (response.kind === 'focus-return' || options.tooltip) product.focus()
      notify(response)
      return SUCCESS
    } catch {
      return { ok: false, error: BROWSER_ERROR.invalidCommand }
    }
  })
  for (const name of ['blur', 'minimize', 'hide']) listen(window, name, dismiss)
  listen(window, 'resize', render)
  listen(product, 'did-start-loading', dismiss)
  listen(product, 'zoom-changed', render)
  const dispose = (): void => {
    if (disposed) return
    dismiss()
    disposed = true
    for (const remove of removers.splice(0)) remove()
    if (view) {
      if (!window.isDestroyed()) window.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    overlaySession?.webRequest.onBeforeRequest(null)
    overlaySession?.setPermissionRequestHandler(null)
    overlaySession?.setPermissionCheckHandler(null)
    void overlaySession?.clearStorageData().catch(() => undefined)
  }
  listen(window, 'closed', dispose)
  return { publish, dismiss, focus, dispose }
}
