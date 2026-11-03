import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  Session,
  WebContentsView,
  WebPreferences,
  WebFrameMain,
} from 'electron'
import {
  MENU_CHANNEL,
  MENU_ERROR,
  MENU_LIMIT,
  menuActions,
  parseMenuAck,
  parseMenuEvent,
  parseMenuModel,
  parseMenuReason,
  parseMenuSeedRequest,
  sameMenuTarget,
} from '../menu.ts'
import type {
  MenuAck,
  MenuActionResult,
  MenuDismissReason,
  MenuEvent,
  MenuModel,
  MenuPresentationReply,
  MenuReply,
  MenuSeed,
  MenuSeedRequest,
  MenuSurface,
  MenuTarget,
  MenuValue,
} from '../menu.ts'
import { overlayResources } from './overlay.ts'
import type { BrowserPageTarget, FindQuery, FindState } from '../browser.ts'

const MENU_ENTRY = 'menu.html'
const MENU_GEOMETRY_TOLERANCE = 1
const TRANSPARENT_BACKGROUND = '#00000000'
const DENY = { action: 'deny' } as const
const REVOKED: MenuReply = { ok: false, error: MENU_ERROR.revoked }
const HTTP_SUCCESS_START = 200
const HTTP_SUCCESS_END = 300
const PRESENTATION_REQUIRES_FOCUS: Record<MenuSurface, boolean> = {
  'account-menu': false,
  'browser-menu': true,
  'browser-find': true,
}
type MenuActionEvent = Extract<MenuEvent, { kind: 'action' }>
export interface MenuActionRegistration {
  surface: MenuSurface
  close: 'before' | 'keep-open'
  validateValue(value: MenuValue): boolean
  validateTarget?(target: MenuTarget): boolean
  execute(event: MenuActionEvent, target: MenuTarget): void | Promise<void>
}
export class MenuActionRegistry {
  private readonly actions = new Map<string, MenuActionRegistration>()
  register(actionId: string, registration: MenuActionRegistration): () => void {
    if (!actionId.length || actionId.length > MENU_LIMIT.id || this.actions.has(actionId))
      throw new Error(MENU_ERROR.invalid)
    this.actions.set(actionId, registration)
    return () => {
      if (this.actions.get(actionId) === registration) this.actions.delete(actionId)
    }
  }
  resolve(actionId: string, model: MenuModel, value: MenuValue): MenuActionRegistration | null {
    const registration = this.actions.get(actionId)
    return registration?.surface === model.surface &&
      registration.validateValue(value) &&
      (!registration.validateTarget || registration.validateTarget(model.target))
      ? registration
      : null
  }
  displays(item: ReturnType<typeof menuActions>[number], model: MenuModel): boolean {
    const registration = this.actions.get(item.actionId)
    return Boolean(
      registration?.surface === model.surface &&
      registration.validateValue(item.value) &&
      (item.disabled || !registration.validateTarget || registration.validateTarget(model.target))
    )
  }
}
export interface MenuOwner {
  publish(model: unknown): Promise<MenuReply>
  dismiss(reason: MenuDismissReason): void
  dispose(): void
  refreshPresentation(): void
}
interface MenuOptions {
  log?(line: string): void
  onBeforeInput?: (event: Electron.Event, input: Electron.Input) => void
  find?: {
    query(target: BrowserPageTarget, query: FindQuery, publish: (state: FindState) => void): void
    stop(target: BrowserPageTarget): void
    focus(target: BrowserPageTarget): void
  }
  rendererUrl: string
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>
  registry: MenuActionRegistry
  directory: string
  preload: string
  target(request: MenuSeedRequest): MenuTarget | null
  nativeVisible?(): boolean
  createSession(): Session
  createView(preferences: WebPreferences): WebContentsView
}
interface MenuPresentation {
  findState?: FindState
  model: MenuModel
  view: WebContentsView
  session: Session
  loaded: boolean
  painted: boolean
  shown: boolean
  pending: ((reply: MenuReply) => void) | null
  focusPending: ((reply: MenuReply) => void) | null
  timer: ReturnType<typeof setTimeout>
  removers: (() => void)[]
}
export function createMenuOwner(window: BrowserWindow, options: MenuOptions): MenuOwner {
  const product = window.webContents
  const removers: (() => void)[] = []
  let disposed = false
  let productAvailable = !product.isDestroyed() && !product.isCrashed()
  let productDestroyed = product.isDestroyed()
  let productGeneration = 0
  let crashGeneration = 0
  let navigationGeneration = 0
  let resultGeneration = 0
  let recovery: { generation: number; committed: WebFrameMain | null } | null = null
  const rendererProtocol = new URL(options.rendererUrl).protocol
  let current: MenuPresentation | null = null
  let lease: MenuSeed | null = null
  let highestRevision = 0
  const diagnose = (
    stage: string,
    fields: Record<string, string | number | boolean | undefined> = {}
  ): void => {
    options.log?.(
      `[menu] ${JSON.stringify({
        stage,
        sessionId: current?.model.sessionId ?? lease?.sessionId,
        revision: current?.model.revision ?? lease?.revision,
        surface: current?.model.surface,
        productAvailable,
        focused: !window.isDestroyed() && window.isFocused(),
        visible: !window.isDestroyed() && window.isVisible(),
        minimized: !window.isDestroyed() && window.isMinimized(),
        ...fields,
      })}\n`
    )
  }
  const requests = new Set<string>()
  const listen = (
    emitter: NodeJS.EventEmitter,
    name: string,
    listener: Parameters<NodeJS.EventEmitter['on']>[1],
    scope = removers
  ): void => {
    emitter.on(name, listener)
    scope.push(() => emitter.removeListener(name, listener))
  }
  const notify = (channel: string, value: unknown): void => {
    if (!disposed && productAvailable && !product.isDestroyed() && !product.isCrashed())
      product.send(channel, value)
  }
  const eligible = (requireFocus = true): boolean =>
    !disposed &&
    productAvailable &&
    !product.isDestroyed() &&
    !product.isCrashed() &&
    !window.isDestroyed() &&
    (!requireFocus || window.isFocused()) &&
    window.isVisible() &&
    !window.isMinimized()
  let presentationRevision = 0
  let presentationSignature = ''
  let presentationReply: MenuPresentationReply = {
    ok: false,
    revision: 1,
    error: MENU_ERROR.revoked,
  }
  const refreshPresentation = (): void => {
    const available = eligible(PRESENTATION_REQUIRES_FOCUS['account-menu'])
    const native = available && options.nativeVisible?.() === true
    const signature = available ? (native ? 'native' : 'inline') : MENU_ERROR.revoked
    if (signature === presentationSignature) return
    presentationSignature = signature
    presentationRevision += 1
    presentationReply = available
      ? { ok: true, revision: presentationRevision, presentation: native ? 'native' : 'inline' }
      : { ok: false, revision: presentationRevision, error: MENU_ERROR.revoked }
    diagnose('presentation', { available, native, presentationRevision })
    if (current?.model.surface === 'account-menu') dismiss('target')
    notify(MENU_CHANNEL.presentation, presentationReply)
  }
  const ack = (model: MenuModel): MenuAck => ({
    sessionId: model.sessionId,
    revision: model.revision,
  })
  const targetValid = (model: MenuModel): boolean => {
    if (model.surface === 'account-menu' && options.nativeVisible?.() !== true) return false
    const request: MenuSeedRequest =
      model.target.kind === 'account'
        ? { surface: 'account-menu', identityRevision: model.target.identityRevision }
        : model.surface === 'browser-find' && model.target.kind === 'browser'
          ? {
              surface: 'browser-find',
              target: {
                tabId: model.target.tabId,
                instanceId: model.target.instanceId,
                navigationId: model.target.navigationId,
              },
            }
          : {
              surface: 'browser-menu',
              tabId: model.target.kind === 'browser' ? model.target.tabId : null,
            }
    try {
      const target = options.target(request)
      return target !== null && sameMenuTarget(target, model.target)
    } catch {
      return false
    }
  }
  const geometryValid = (model: MenuModel): boolean => {
    const [width, height] = window.getContentSize()
    const zoom = product.getZoomFactor()
    return (
      Number.isFinite(zoom) &&
      zoom > 0 &&
      width > 0 &&
      height > 0 &&
      Math.abs(model.viewport.width * zoom - width) <= MENU_GEOMETRY_TOLERANCE &&
      Math.abs(model.viewport.height * zoom - height) <= MENU_GEOMETRY_TOLERANCE
    )
  }
  const settle = (presentation: MenuPresentation, reply: MenuReply): void => {
    clearTimeout(presentation.timer)
    const pending = presentation.pending
    presentation.pending = null
    pending?.(reply)
    const focusPending = presentation.focusPending
    presentation.focusPending = null
    focusPending?.(reply)
  }
  const releaseSession = (isolated: Session): void => {
    isolated.webRequest.onBeforeRequest(null)
    isolated.setPermissionRequestHandler(null)
    isolated.setPermissionCheckHandler(null)
    void isolated.clearStorageData().catch(() => undefined)
  }
  const dismiss = (reason: MenuDismissReason): void => {
    if (reason !== 'action') resultGeneration += 1
    const previous = current
    const returnFocus =
      reason === 'escape' &&
      Boolean(previous?.shown && previous.view.webContents.isFocused()) &&
      eligible()
    current = null
    lease = null
    if (!previous) return
    if (previous.model.surface === 'browser-find' && previous.model.target.kind === 'browser')
      options.find?.stop(previous.model.target)
    diagnose('dismissed', {
      sessionId: previous.model.sessionId,
      surface: previous.model.surface,
      reason,
      revision: previous.model.revision,
      loaded: previous.loaded,
      painted: previous.painted,
      shown: previous.shown,
    })
    settle(previous, REVOKED)
    previous.shown = false
    previous.view.setVisible(false)
    if (!window.isDestroyed()) window.contentView.removeChildView(previous.view)
    for (const remove of previous.removers.splice(0)) remove()
    if (!previous.view.webContents.isDestroyed())
      previous.view.webContents.close({ waitForBeforeUnload: false })
    releaseSession(previous.session)
    notify(MENU_CHANNEL.revoked, { ...ack(previous.model), reason })
    if (returnFocus && !current && !lease && eligible()) {
      if (previous.model.find?.origin === 'page' && previous.model.target.kind === 'browser') {
        if (targetValid(previous.model)) options.find?.focus(previous.model.target)
      } else product.focus()
    }
  }
  const confirmFocus = (presentation: MenuPresentation): void => {
    if (
      current !== presentation ||
      !presentation.loaded ||
      !presentation.painted ||
      !presentation.view.getVisible()
    )
      return
    if (
      !eligible(PRESENTATION_REQUIRES_FOCUS[presentation.model.surface]) ||
      !targetValid(presentation.model) ||
      !geometryValid(presentation.model) ||
      presentation.view.webContents.isDestroyed()
    ) {
      dismiss('invalid')
      return
    }
    if (!presentation.view.webContents.isFocused()) return
    presentation.shown = true
    if (presentation.findState)
      presentation.view.webContents.send(MENU_CHANNEL.findState, {
        ...ack(presentation.model),
        ...presentation.findState,
      })
    diagnose('focused', { revision: presentation.model.revision })
    settle(presentation, { ok: true, ack: ack(presentation.model) })
  }
  const show = (presentation: MenuPresentation): MenuReply | Promise<MenuReply> => {
    if (
      current !== presentation ||
      !eligible(PRESENTATION_REQUIRES_FOCUS[presentation.model.surface]) ||
      !targetValid(presentation.model) ||
      !geometryValid(presentation.model)
    ) {
      if (current === presentation) dismiss('invalid')
      return REVOKED
    }
    if (!presentation.loaded || !presentation.painted || presentation.focusPending) return REVOKED
    const [width, height] = window.getContentSize()
    try {
      presentation.view.webContents.setZoomFactor(product.getZoomFactor())
      presentation.view.setBounds({ x: 0, y: 0, width, height })
      window.contentView.addChildView(presentation.view)
      presentation.view.setVisible(true)
      if (!presentation.view.getVisible()) throw new Error(MENU_ERROR.failed)
      const focused = new Promise<MenuReply>((resolve) => {
        presentation.focusPending = resolve
      })
      if (!presentation.view.webContents.isFocused()) presentation.view.webContents.focus()
      if (
        current !== presentation ||
        !eligible(PRESENTATION_REQUIRES_FOCUS[presentation.model.surface]) ||
        !targetValid(presentation.model) ||
        !presentation.view.getVisible()
      ) {
        if (current === presentation) dismiss('invalid')
        return REVOKED
      }
      confirmFocus(presentation)
      return focused
    } catch {
      diagnose('show-failed')
      dismiss('invalid')
      return { ok: false, error: MENU_ERROR.failed }
    }
  }
  const publish = async (value: unknown): Promise<MenuReply> => {
    let model: MenuModel
    try {
      model = parseMenuModel(value)
      const validation = {
        eligible: eligible(PRESENTATION_REQUIRES_FOCUS[model.surface]),
        revisionValid: model.revision > highestRevision,
        target: targetValid(model),
        geometry: geometryValid(model),
      }
      if (!Object.values(validation).every(Boolean)) {
        diagnose('validation-rejected', {
          sessionId: model.sessionId,
          surface: model.surface,
          revision: model.revision,
          ...validation,
          focused: window.isFocused(),
          visible: window.isVisible(),
          minimized: window.isMinimized(),
        })
        throw new Error(MENU_ERROR.invalid)
      }
      const actions = menuActions(model.items)
      if (
        model.surface === 'browser-find'
          ? !options.find || model.target.kind !== 'browser'
          : actions.some((item) => !options.registry.displays(item, model)) || !actions.length
      )
        throw new Error(MENU_ERROR.invalid)
    } catch {
      dismiss('invalid')
      return { ok: false, error: MENU_ERROR.invalid }
    }
    const previous = current
    diagnose('accepted', {
      sessionId: model.sessionId,
      revision: model.revision,
      surface: model.surface,
    })
    const continuing =
      previous?.model.sessionId === model.sessionId &&
      sameMenuTarget(previous.model.target, model.target)
    highestRevision = model.revision
    if (!continuing) requests.clear()
    if (continuing && previous) {
      settle(previous, REVOKED)
      previous.model = model
      previous.painted = false
      previous.shown = false
      return new Promise<MenuReply>((resolve) => {
        previous.pending = resolve
        previous.timer = setTimeout(() => {
          if (current === previous) dismiss('timeout')
        }, MENU_LIMIT.paintTimeout)
        if (previous.loaded) previous.view.webContents.send(MENU_CHANNEL.model, model)
      })
    }
    dismiss('replaced')
    let createdSession: Session | null = null
    let createdView: WebContentsView | null = null
    try {
      const resources = overlayResources(options.directory, MENU_ENTRY)
      const isolated = options.createSession()
      createdSession = isolated
      isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      isolated.setPermissionCheckHandler(() => false)
      isolated.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !resources.has(details.url) })
      )
      const view = options.createView({
        session: isolated,
        preload: options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
        backgroundThrottling: false,
      })
      createdView = view
      view.setVisible(false)
      view.setBackgroundColor(TRANSPARENT_BACKGROUND)
      const contents = view.webContents
      const [width, height] = window.getContentSize()
      view.setBounds({ x: 0, y: 0, width, height })
      contents.setZoomFactor(product.getZoomFactor())
      contents.setWindowOpenHandler(() => DENY)
      const result = new Promise<MenuReply>((resolve) => {
        const presentation: MenuPresentation = {
          model,
          view,
          session: isolated,
          loaded: false,
          painted: false,
          shown: false,
          pending: resolve,
          focusPending: null,
          timer: setTimeout(() => {
            if (current === presentation) dismiss('timeout')
          }, MENU_LIMIT.paintTimeout),
          removers: [],
        }
        current = presentation
        listen(
          contents,
          'console-message',
          (details) => {
            if (details.level === 'error') console.error('Menu renderer error', details.message)
            else console.info('Menu renderer console', details.level, details.message)
          },
          presentation.removers
        )
        listen(contents, 'focus', () => confirmFocus(presentation), presentation.removers)
        listen(
          contents,
          'blur',
          () => {
            if (current === presentation) dismiss('blur')
          },
          presentation.removers
        )
        listen(
          contents,
          'before-input-event',
          (event, input) => {
            if (current === presentation && presentation.shown)
              options.onBeforeInput?.(event, input)
          },
          presentation.removers
        )
        listen(isolated, 'will-download', (event) => event.preventDefault(), presentation.removers)
        for (const name of [
          'will-navigate',
          'will-frame-navigate',
          'will-redirect',
          'will-attach-webview',
        ]) {
          listen(contents, name, (event) => event.preventDefault(), presentation.removers)
        }
        listen(
          contents,
          'render-process-gone',
          () => {
            if (current === presentation) dismiss('crash')
          },
          presentation.removers
        )
        listen(
          contents,
          'destroyed',
          () => {
            if (current === presentation) dismiss('crash')
          },
          presentation.removers
        )
        void contents
          .loadURL(pathToFileURL(join(realpathSync(options.directory), MENU_ENTRY)).href)
          .then(() => {
            if (current !== presentation) return
            presentation.loaded = true
            window.contentView.addChildView(view)
            contents.setBackgroundThrottling(false)
            diagnose('loaded', { revision: presentation.model.revision })
            contents.send(MENU_CHANNEL.model, presentation.model)
          })
          .catch(() => {
            if (current !== presentation) return
            diagnose('load-failed')
            settle(presentation, { ok: false, error: MENU_ERROR.failed })
            dismiss('invalid')
          })
      })
      return result
    } catch {
      diagnose('create-failed', {
        sessionId: model.sessionId,
        revision: model.revision,
        surface: model.surface,
      })
      if (current) dismiss('invalid')
      else {
        if (createdView && !createdView.webContents.isDestroyed())
          createdView.webContents.close({ waitForBeforeUnload: false })
        if (createdSession) releaseSession(createdSession)
      }
      return { ok: false, error: MENU_ERROR.failed }
    }
  }
  const validate = (event: IpcMainInvokeEvent, menu = false): void => {
    const contents = menu ? current?.view.webContents : product
    if (
      disposed ||
      !productAvailable ||
      product.isDestroyed() ||
      product.isCrashed() ||
      !contents ||
      contents.isDestroyed() ||
      event.sender !== contents ||
      event.senderFrame !== contents.mainFrame
    )
      throw new Error(MENU_ERROR.sender)
  }
  const handle = (
    channel: string,
    callback: (event: IpcMainInvokeEvent, args: unknown[]) => unknown
  ): void => {
    options.ipc.handle(channel, async (event, ...args: unknown[]) => {
      try {
        return await callback(event, args)
      } catch (error) {
        diagnose('ipc-rejected', {
          channel,
          error:
            error instanceof Error && error.message === MENU_ERROR.sender
              ? MENU_ERROR.sender
              : MENU_ERROR.invalid,
        })
        return {
          ok: false,
          error:
            error instanceof Error && error.message === MENU_ERROR.sender
              ? MENU_ERROR.sender
              : MENU_ERROR.invalid,
        }
      }
    })
    removers.push(() => options.ipc.removeHandler(channel))
  }
  handle(MENU_CHANNEL.seed, (event, args) => {
    if (event.sender === current?.view.webContents) {
      validate(event, true)
      if (args.length) throw new Error(MENU_ERROR.invalid)
      return current?.loaded ? current.model : null
    }
    validate(event)
    if (args.length !== 1) throw new Error(MENU_ERROR.invalid)
    const request = parseMenuSeedRequest(args[0])
    diagnose('seed-requested', {
      surface: request.surface,
      eligible: eligible(PRESENTATION_REQUIRES_FOCUS[request.surface]),
      native: options.nativeVisible?.() === true,
    })
    if (
      request.surface === 'account-menu' &&
      (!eligible(PRESENTATION_REQUIRES_FOCUS[request.surface]) ||
        options.nativeVisible?.() !== true)
    )
      throw new Error(MENU_ERROR.revoked)
    const target = options.target(request)
    if (!target) throw new Error(MENU_ERROR.invalid)
    dismiss('replaced')
    lease = { sessionId: randomUUID(), revision: highestRevision + 1, target }
    return { ok: true, seed: lease }
  })
  handle(MENU_CHANNEL.publish, (event, args) => {
    validate(event)
    if (args.length !== 1) throw new Error(MENU_ERROR.invalid)
    let model: MenuModel
    try {
      model = parseMenuModel(args[0])
    } catch {
      dismiss('invalid')
      throw new Error(MENU_ERROR.invalid)
    }
    const approved =
      lease ?? (current ? { ...ack(current.model), target: current.model.target } : null)
    if (
      !approved ||
      approved.sessionId !== model.sessionId ||
      !sameMenuTarget(approved.target, model.target)
    )
      throw new Error(MENU_ERROR.invalid)
    return publish(model)
  })
  handle(MENU_CHANNEL.presentation, (event, args) => {
    validate(event)
    if (args.length) throw new Error(MENU_ERROR.invalid)
    refreshPresentation()
    return presentationReply
  })
  handle(MENU_CHANNEL.dismiss, (event, args) => {
    validate(event)
    if (args.length !== 1) throw new Error(MENU_ERROR.invalid)
    dismiss(parseMenuReason(args[0]))
  })
  handle(MENU_CHANNEL.refocus, (event, args) => {
    validate(event)
    if (args.length !== 1) throw new Error(MENU_ERROR.invalid)
    const expected = parseMenuAck(args[0])
    if (
      !current ||
      current.model.surface !== 'browser-find' ||
      !current.shown ||
      !eligible() ||
      !targetValid(current.model) ||
      !geometryValid(current.model) ||
      current.model.sessionId !== expected.sessionId ||
      current.model.revision !== expected.revision
    )
      return REVOKED
    current.view.webContents.focus()
    current.view.webContents.send(MENU_CHANNEL.refocus, expected)
    return { ok: true, ack: expected }
  })
  handle(MENU_CHANNEL.paintReady, (event, args) => {
    validate(event, true)
    if (args.length !== 1) throw new Error(MENU_ERROR.invalid)
    const painted = parseMenuAck(args[0])
    const presentation = current
    diagnose('paint', {
      revision: painted.revision,
      loaded: presentation?.loaded,
      matching: presentation?.model.sessionId === painted.sessionId,
    })
    if (
      !presentation ||
      !presentation.loaded ||
      painted.sessionId !== presentation.model.sessionId ||
      painted.revision !== presentation.model.revision
    )
      return REVOKED
    presentation.painted = true
    return show(presentation)
  })
  handle(MENU_CHANNEL.event, async (event, args) => {
    validate(event, true)
    if (args.length !== 1) throw new Error(MENU_ERROR.invalid)
    const request = parseMenuEvent(args[0])
    const presentation = current
    if (
      !presentation ||
      request.sessionId !== presentation.model.sessionId ||
      request.revision !== presentation.model.revision
    )
      return REVOKED
    const reply = { ok: true, ack: ack(presentation.model) } as const
    if (request.kind === 'dismiss' && presentation.view.getVisible()) {
      dismiss(request.reason)
      return reply
    }
    if (!presentation.shown) return REVOKED
    if (!eligible() || !targetValid(presentation.model) || !geometryValid(presentation.model)) {
      dismiss('target')
      return REVOKED
    }
    if (!presentation.view.webContents.isFocused()) {
      dismiss('blur')
      return REVOKED
    }
    if (request.kind === 'dismiss') {
      dismiss(request.reason)
      return reply
    }
    if (requests.has(request.requestId) || requests.size >= MENU_LIMIT.requests)
      return { ok: false, error: MENU_ERROR.invalid }
    if (request.kind === 'find') {
      if (
        presentation.model.surface !== 'browser-find' ||
        presentation.model.target.kind !== 'browser' ||
        !options.find
      )
        return { ok: false, error: MENU_ERROR.invalid }
      requests.add(request.requestId)
      const target = presentation.model.target
      options.find.query(
        target,
        { text: request.text, direction: request.direction, querySequence: request.querySequence },
        (state) => {
          if (current !== presentation || !targetValid(presentation.model) || !eligible()) return
          presentation.findState = state
          if (presentation.shown)
            presentation.view.webContents.send(MENU_CHANNEL.findState, {
              ...ack(presentation.model),
              ...state,
            })
        }
      )
      return reply
    }
    const item = menuActions(presentation.model.items).find(
      (item) =>
        item.actionId === request.actionId &&
        !item.disabled &&
        JSON.stringify(item.value) === JSON.stringify(request.value)
    )
    const registration =
      item && options.registry.resolve(request.actionId, presentation.model, request.value)
    if (!registration) return { ok: false, error: MENU_ERROR.invalid }
    requests.add(request.requestId)
    const target = presentation.model.target
    const authorizedGeneration = productGeneration
    const authorizedResultGeneration = resultGeneration
    const completed = (outcome: MenuActionResult['outcome']): void => {
      if (productGeneration !== authorizedGeneration) return
      notify(MENU_CHANNEL.result, {
        sessionId: request.sessionId,
        revision: request.revision,
        requestId: request.requestId,
        actionId: request.actionId,
        outcome:
          resultGeneration === authorizedResultGeneration && targetValid(presentation.model)
            ? outcome
            : 'revoked',
      } satisfies MenuActionResult)
    }
    if (registration.close === 'before') dismiss('action')
    try {
      await registration.execute(request, target)
      completed('succeeded')
      if (!eligible() || productGeneration !== authorizedGeneration) return REVOKED
      if (
        registration.close === 'keep-open' &&
        (current !== presentation ||
          presentation.model.revision !== request.revision ||
          !presentation.view.webContents.isFocused() ||
          !targetValid(presentation.model) ||
          !geometryValid(presentation.model))
      ) {
        if (current === presentation && presentation.model.revision === request.revision)
          dismiss('target')
        return REVOKED
      }
      return reply
    } catch {
      completed('failed')
      return { ok: false, error: MENU_ERROR.failed }
    }
  })
  for (const reason of ['blur', 'minimize', 'hide', 'resize'] as const)
    listen(window, reason, () => {
      dismiss(reason)
      refreshPresentation()
    })
  for (const event of ['focus', 'show', 'restore'] as const)
    listen(window, event, refreshPresentation)
  listen(product, 'did-start-loading', () => dismiss('navigation'))
  listen(product, 'zoom-changed', () => dismiss('resize'))
  for (const name of ['render-process-gone', 'destroyed'])
    listen(product, name, () => {
      productAvailable = false
      productDestroyed ||= name === 'destroyed'
      productGeneration += 1
      crashGeneration = navigationGeneration
      recovery = null
      dismiss('crash')
      refreshPresentation()
    })
  listen(product, 'did-start-navigation', (details) => {
    if (disposed || productDestroyed || product.isDestroyed()) return
    if (!details.isMainFrame || details.frame !== product.mainFrame || details.isSameDocument)
      return
    navigationGeneration += 1
    recovery =
      !productAvailable && !productDestroyed && details.url === options.rendererUrl
        ? { generation: navigationGeneration, committed: null }
        : null
  })
  listen(
    product,
    'did-frame-navigate',
    (_event, url, responseCode, _status, isMainFrame, processId, routingId) => {
      if (!recovery || disposed || productDestroyed || product.isDestroyed()) return
      const frame = product.mainFrame
      const successful =
        rendererProtocol === 'http:' || rendererProtocol === 'https:'
          ? responseCode >= HTTP_SUCCESS_START && responseCode < HTTP_SUCCESS_END
          : rendererProtocol === 'file:'
      if (
        !recovery ||
        recovery.generation !== navigationGeneration ||
        !isMainFrame ||
        processId !== frame.processId ||
        routingId !== frame.routingId
      )
        return
      if (url !== options.rendererUrl || !successful) {
        recovery = null
        return
      }
      recovery.committed = frame
    }
  )
  for (const name of ['did-fail-load', 'did-fail-provisional-load'])
    listen(product, name, (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) recovery = null
    })
  listen(product, 'did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (
      !recovery ||
      productAvailable ||
      productDestroyed ||
      disposed ||
      window.isDestroyed() ||
      window.webContents !== product ||
      product.isDestroyed() ||
      product.isCrashed() ||
      !isMainFrame ||
      navigationGeneration <= crashGeneration ||
      recovery.generation !== navigationGeneration
    )
      return
    const frame = product.mainFrame
    if (
      recovery.committed !== frame ||
      processId !== frame.processId ||
      routingId !== frame.routingId ||
      frame.url !== options.rendererUrl ||
      product.getURL() !== options.rendererUrl
    )
      return
    recovery = null
    lease = null
    requests.clear()
    productAvailable = true
    productGeneration += 1
    refreshPresentation()
  })
  const dispose = (): void => {
    if (disposed) return
    dismiss('dispose')
    disposed = true
    for (const remove of removers.splice(0)) remove()
    requests.clear()
  }
  listen(window, 'closed', dispose)
  refreshPresentation()
  return { publish, dismiss, dispose, refreshPresentation }
}
