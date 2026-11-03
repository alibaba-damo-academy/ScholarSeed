import { ChromiumProtocolError, type ChromiumMessage, type ChromiumPipe } from './chromium.ts'

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
const MAX_VIEWPORT_EDGE = 4096
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const MAX_TEXT_LENGTH = 4096
const MAX_URL_LENGTH = 8192
const MAX_WHEEL_DELTA = 4096
const MAX_KEY_LENGTH = 64
const MAX_VIRTUAL_KEY_CODE = 255
const MAX_KEY_MODIFIERS = 15
const MAX_CLICK_COUNT = 3
const MAX_HISTORY_ENTRIES = 10_000
const MAX_DOCUMENT_INIT_IDENTITIES = 128
const MAX_ATTACH_EVENTS = 1024
const MAX_ATTACH_CANDIDATE_SESSIONS = 128
const DEFAULT_DOCUMENT_INIT_TIMEOUT_MS = 30_000
const MAX_DOCUMENT_INIT_TIMEOUT_MS = 120_000
const READINESS_EXPRESSION = 'document.readyState'
const READINESS_WORLD = 'ScholarSeedReadiness'
const AGENT_PAGE_METHODS = new Set([
  'Accessibility.getFullAXTree', 'DOM.describeNode', 'DOM.enable', 'DOM.focus', 'DOM.getBoxModel',
  'DOM.getDocument', 'DOM.getNodeForLocation', 'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchKeyEvent', 'Input.dispatchMouseEvent', 'Input.insertText',
  'Network.enable', 'Page.enable', 'Page.getFrameTree'
])
const ACTIVE_ELEMENT_EXPRESSION = 'document.activeElement'
const EDITABLE_FOCUS_FUNCTION = 'function() { return this === this.ownerDocument.activeElement && this.ownerDocument.hasFocus() && (this.isContentEditable || this instanceof HTMLInputElement && !this.disabled && !this.readOnly || this instanceof HTMLTextAreaElement && !this.disabled && !this.readOnly) }'
const SCREENCAST_QUALITY = 75
const SCREENCAST_EVERY_NTH_FRAME = 1
const JPEG_START_MARKER = 0xd8
const JPEG_PREFIX = 0xff
const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

type ChromiumTransport = Pick<ChromiumPipe, 'command' | 'onEvent' | 'close'>
type FrameFormat = 'jpeg' | 'png'

export interface ChromiumViewport {
  width: number
  height: number
}

export interface ChromiumFrame {
  targetId: string
  sequence: number
  data: string
  format: FrameFormat
  width: number
  height: number
}

export interface ChromiumTargetInfo {
  targetId: string
  url: string
  title: string
}

export interface ChromiumTargetEvent {
  kind: 'created' | 'updated' | 'navigated' | 'same-document' | 'ready' | 'response' | 'detached' | 'destroyed'
  info: ChromiumTargetInfo
  navigationType?: 'Navigation' | 'BackForwardCacheRestore'
  documentEpoch?: number
  loaderId?: string
  frameId?: string
  status?: number
}

export interface ChromiumNavigationReceipt { frameId: string; loaderId: string | null }

export interface ChromiumAgentPageEvent {
  targetId: string
  method: string
  params: Record<string, unknown>
}

export interface ChromiumAgentPageState {
  loading: boolean
  navigationEpoch: number
  documentEpoch: number
  mainFrameId: string | null
}

export type ChromiumMouseInput = {
  kind: 'mouse'
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
  x: number
  y: number
  button: 'none' | 'left' | 'middle' | 'right'
  clickCount?: number
} | {
  kind: 'wheel'
  x: number
  y: number
  deltaX: number
  deltaY: number
}

export type ChromiumKeyInput = {
  kind: 'key'
  type: 'keyDown' | 'keyUp' | 'char'
  key: string
  code: string
  windowsVirtualKeyCode: number
  modifiers?: number
} | {
  kind: 'text'
  text: string
}

export type ChromiumCompositionInput = {
  kind: 'composition'
  phase: 'begin' | 'update'
  text: string
  selectionStart: number
  selectionEnd: number
} | {
  kind: 'composition'
  phase: 'commit'
  text: string
} | {
  kind: 'composition'
  phase: 'cancel'
}

interface PageTarget {
  targetId: string
  sessionId: string
  viewport: ChromiumViewport
  active: boolean
  screencasting: boolean
  pendingFrame?: { sequence: number; chromeSessionId: number; acknowledgement?: Promise<void> }
  nextSequence: number
  closed: boolean
  closing: boolean
  detached: boolean
  compositionObjectId?: string
  navigationEpoch: number
  documentEpoch: number
  acceptedInitTimestamps: Map<string, number>
  lifecycleDocument?: { frameId: string; loaderId: string; epoch: number; initTimestamp: number }
  pendingCommit?: { frameId: string; loaderId: string; url: string; timer: ReturnType<typeof setTimeout> }
  lastCommit?: { frameId: string; loaderId: string; url: string; documentEpoch?: number }
  pressedKeys: Map<string, { key: string; code: string; windowsVirtualKeyCode: number; modifiers: number }>
  mainFrameId?: string
  awaitingNavigationFrameId: boolean
  mainFrameLoadDepth: number
  mainFrameLoadUnconfirmed: boolean
  mainFrameLoadLoaderId?: string
  pendingMainDocumentRequest: boolean
  agentNavigationPending: boolean
  agentLoadingRevision: number
}

interface ChromiumFrameTreeNode {
  frame?: { id?: unknown; loaderId?: unknown; url?: unknown; urlFragment?: unknown }
  childFrames?: ChromiumFrameTreeNode[]
}

function validViewport(viewport: ChromiumViewport): boolean {
  return Number.isInteger(viewport.width) && Number.isInteger(viewport.height) &&
    viewport.width > 0 && viewport.height > 0 &&
    viewport.width <= MAX_VIEWPORT_EDGE && viewport.height <= MAX_VIEWPORT_EDGE
}

function validCoordinate(value: number, edge: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < edge
}

function pageUrl(value: string): string {
  if (value === 'about:blank') return value
  if (value.length > MAX_URL_LENGTH) throw new Error('Chromium page URL is too long')
  const url = new URL(value)
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Chromium page URL is not allowed')
  }
  return url.href
}

function jpegDimensions(data: Buffer): ChromiumViewport | undefined {
  if (data.length < 4 || data[0] !== JPEG_PREFIX || data[1] !== JPEG_START_MARKER) return undefined
  for (let offset = 2; offset + 4 < data.length;) {
    if (data[offset++] !== JPEG_PREFIX) return undefined
    while (data[offset] === JPEG_PREFIX) offset++
    const marker = data[offset++]
    if (marker === undefined || marker === 0xda || marker === 0xd9) return undefined
    const length = data.readUInt16BE(offset)
    if (length < 2 || offset + length > data.length) return undefined
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 7) return undefined
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return undefined
}

export class ChromiumTargets {
  private readonly pages = new Map<string, PageTarget>()
  private readonly bySession = new Map<string, PageTarget>()
  private readonly targetInfos = new Map<string, ChromiumTargetInfo>()
  private readonly targetListeners = new Set<(event: ChromiumTargetEvent) => void>()
  private readonly agentPageListeners = new Set<(event: ChromiumAgentPageEvent) => void>()
  private readonly registrations = new Map<string, Promise<PageTarget | undefined>>()
  private readonly destroyedTargets = new Set<string>()
  private readonly detachedSessions = new Set<string>()
  private readonly frameListeners = new Set<(frame: ChromiumFrame) => void>()
  private readonly creations = new Set<Promise<string>>()
  private readonly detachEvent: () => void
  private activeTargetId?: string
  private transition = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private discovery?: Promise<void>
  private discoveryBuffer?: ChromiumMessage[]
  private discovering = false
  private readonly documentInitTimeoutMs: number

  constructor(private readonly transport: ChromiumTransport, options: { documentInitTimeoutMs?: number } = {}) {
    this.documentInitTimeoutMs = options.documentInitTimeoutMs ?? DEFAULT_DOCUMENT_INIT_TIMEOUT_MS
    if (!Number.isSafeInteger(this.documentInitTimeoutMs) || this.documentInitTimeoutMs <= 0 ||
      this.documentInitTimeoutMs > MAX_DOCUMENT_INIT_TIMEOUT_MS) throw new Error('Invalid Chromium document init timeout')
    this.detachEvent = transport.onEvent(message => this.handleEvent(message))
  }

  onTarget(listener: (event: ChromiumTargetEvent) => void): () => void {
    this.assertOpen()
    this.targetListeners.add(listener)
    return () => { this.targetListeners.delete(listener) }
  }

  onAgentPageEvent(listener: (event: ChromiumAgentPageEvent) => void): () => void {
    this.assertOpen()
    this.agentPageListeners.add(listener)
    return () => { this.agentPageListeners.delete(listener) }
  }

  agentPageState(targetId: string): ChromiumAgentPageState {
    const page = this.page(targetId)
    return { loading: page.mainFrameLoadDepth > 0 || page.mainFrameLoadUnconfirmed
      || page.awaitingNavigationFrameId || page.agentNavigationPending || page.pendingMainDocumentRequest,
    navigationEpoch: page.navigationEpoch, documentEpoch: page.documentEpoch,
    mainFrameId: page.mainFrameId ?? null }
  }

  agentPageSession(targetId: string): string {
    return this.page(targetId).sessionId
  }

  async agentCommand(targetId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!AGENT_PAGE_METHODS.has(method) || !params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error('Chromium Agent page method is not allowed')
    }
    const page = this.page(targetId)
    const result = await this.transport.command(method, params, page.sessionId)
    if (this.pages.get(targetId) !== page || page.closed || page.closing || page.detached || this.closed) {
      throw new Error('Chromium Agent page target changed')
    }
    return result
  }

  listTargets(): ChromiumTargetInfo[] {
    this.assertOpen()
    return [...this.pages.keys()].flatMap(targetId => {
      const info = this.targetInfos.get(targetId)
      return info ? [{ ...info }] : []
    })
  }

  discover(): Promise<void> {
    this.assertOpen()
    if (!this.discovery) this.discovery = this.discoverPages()
    return this.discovery
  }

  private async discoverPages(): Promise<void> {
    this.discoveryBuffer = []
    try {
      await this.transport.command('Target.setDiscoverTargets', { discover: true })
      const result = await this.transport.command('Target.getTargets', {}) as { targetInfos?: unknown }
      if (!Array.isArray(result?.targetInfos)) throw new Error('Chromium target discovery returned invalid targets')
      for (const value of result.targetInfos) this.recordTarget(value)
      for (const message of this.discoveryBuffer) this.applyTargetEvent(message, false)
      this.discovering = true
      this.discoveryBuffer = undefined
      await Promise.all([...this.targetInfos.keys()].map(targetId => this.register(targetId)))
      this.clearTransientMarkers()
    } catch (error) {
      this.discoveryBuffer = undefined
      this.discovering = false
      this.discovery = undefined
      this.failClosed(error)
      await this.closing
      throw error
    }
  }

  onFrame(listener: (frame: ChromiumFrame) => void): () => void {
    this.assertOpen()
    if (this.frameListeners.size) throw new Error('Chromium frames already have a consumer')
    this.frameListeners.add(listener)
    return () => {
      if (!this.frameListeners.delete(listener)) return
      for (const page of this.pages.values()) {
        void this.ackPending(page).catch(error => this.failClosed(error))
      }
    }
  }

  async create(viewport: ChromiumViewport = DEFAULT_VIEWPORT): Promise<string> {
    const creation = this.createPage(viewport)
    this.creations.add(creation)
    try { return await creation } finally {
      this.creations.delete(creation)
      this.clearTransientMarkers()
    }
  }

  private async createPage(viewport: ChromiumViewport): Promise<string> {
    this.assertOpen()
    if (!validViewport(viewport)) throw new Error('Invalid Chromium viewport')
    const result = await this.transport.command('Target.createTarget', { url: 'about:blank' }) as { targetId?: unknown }
    if (typeof result?.targetId !== 'string' || !result.targetId) throw new Error('Chromium did not create a page target')
    const targetId = result.targetId
    if (this.destroyedTargets.has(targetId)) throw new Error('Chromium returned a destroyed target')
    if (!this.targetInfos.has(targetId)) this.targetInfos.set(targetId, { targetId, url: 'about:blank', title: '' })
    try {
      this.assertOpen()
      const page = await this.register(targetId)
      if (!page) throw new Error('Chromium page target was destroyed during creation')
      if (page.viewport.width !== viewport.width || page.viewport.height !== viewport.height) {
        await this.resize(targetId, viewport)
      }
      return targetId
    } catch (error) {
      try {
        await this.transport.command('Target.closeTarget', { targetId })
      } catch (cleanupError) {
        await this.transport.close()
        throw new AggregateError([error, cleanupError], 'Chromium target creation and cleanup failed')
      }
      throw error
    }
  }

  private register(targetId: string): Promise<PageTarget | undefined> {
    const page = this.pages.get(targetId)
    if (page) return Promise.resolve(page)
    const pending = this.registrations.get(targetId)
    if (pending) return pending
    const registration = Promise.resolve().then(() => this.attachPage(targetId))
    this.registrations.set(targetId, registration)
    void registration.finally(() => {
      if (this.registrations.get(targetId) === registration) this.registrations.delete(targetId)
      this.clearTransientMarkers()
    }).catch(() => undefined)
    return registration
  }

  private async attachPage(targetId: string): Promise<PageTarget | undefined> {
    const eventsBySession = new Map<string, ChromiumMessage[]>()
    const overflowedSessions = new Set<string>()
    let attachedSessionId: string | undefined
    let candidateLimitExceeded = false
    let currentSessionUntracked = false
    const unsubscribe = this.transport.onEvent(message => {
      if (!message.sessionId || !this.isAgentNavigationEvent(message)) return
      if (attachedSessionId ? message.sessionId !== attachedSessionId : this.bySession.has(message.sessionId)) return
      let sessionEvents = eventsBySession.get(message.sessionId)
      if (!sessionEvents) {
        if (eventsBySession.size === MAX_ATTACH_CANDIDATE_SESSIONS) {
          candidateLimitExceeded = true
          return
        }
        sessionEvents = []
        eventsBySession.set(message.sessionId, sessionEvents)
      }
      if (sessionEvents.length === MAX_ATTACH_EVENTS) overflowedSessions.add(message.sessionId)
      else sessionEvents.push(message)
    })
    try {
      return await this.attachPageWithEvents(targetId, sessionId => {
        currentSessionUntracked = candidateLimitExceeded && !eventsBySession.has(sessionId)
        attachedSessionId = sessionId
        const sessionEvents = eventsBySession.get(sessionId) ?? []
        eventsBySession.clear()
        eventsBySession.set(sessionId, sessionEvents)
        return sessionEvents
      }, () => currentSessionUntracked || !!attachedSessionId && overflowedSessions.has(attachedSessionId))
    } finally { unsubscribe() }
  }

  private async attachPageWithEvents(targetId: string, setSessionId: (sessionId: string) => ChromiumMessage[],
    eventsOverflowed: () => boolean): Promise<PageTarget | undefined> {
    let attached: { sessionId?: unknown }
    try {
      attached = await this.transport.command('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: unknown }
    } catch (error) {
      if (this.destroyedTargets.has(targetId)) return undefined
      throw error
    }
    if (typeof attached?.sessionId !== 'string' || !attached.sessionId || this.bySession.has(attached.sessionId)) {
      throw new Error('Chromium did not attach an isolated page session')
    }
    const sessionId = attached.sessionId
    const attachEvents = setSessionId(sessionId)
    if (this.destroyedTargets.has(targetId)) {
      await this.releaseAttachment(sessionId, true)
      return undefined
    }
    if (this.detachedSessions.has(sessionId)) {
      await this.transport.command('Target.closeTarget', { targetId })
      this.forget(targetId)
      this.detachedSessions.delete(sessionId)
      return undefined
    }
    await this.transport.command('Page.enable', {}, sessionId)
    await this.transport.command('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId)
    await this.transport.command('Network.enable', {}, sessionId)
    await this.transport.command('Emulation.setDeviceMetricsOverride', {
      width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height, deviceScaleFactor: 1, mobile: false
    }, sessionId)
    const tree = await this.transport.command('Page.getFrameTree', {}, sessionId) as { frameTree?: ChromiumFrameTreeNode }
    const preTreeEventCount = attachEvents.length
    const frame = tree?.frameTree?.frame
    const childFrameIds = new Set<string>()
    const childFrames = [...(tree?.frameTree?.childFrames ?? [])]
    while (childFrames.length) {
      const childFrame = childFrames.pop()
      if (typeof childFrame?.frame?.id === 'string') childFrameIds.add(childFrame.frame.id)
      if (childFrame?.childFrames) childFrames.push(...childFrame.childFrames)
    }
    const frameId = typeof frame?.id === 'string' && frame.id ? frame.id : undefined
    const loaderId = typeof frame?.loaderId === 'string' && frame.loaderId ? frame.loaderId : undefined
    const committedUrl = typeof frame?.url === 'string' && frame.url
      ? frame.url + (typeof frame.urlFragment === 'string' && frame.urlFragment.startsWith('#') ? frame.urlFragment : '')
      : undefined
    const navigationActivity = () => eventsOverflowed() || attachEvents.some((message, index) =>
      message.sessionId === sessionId && this.isMainFrameNavigationEvent(message, frameId, loaderId,
        index < preTreeEventCount, childFrameIds))
    const readyAtAttach = committedUrl === 'about:blank' && !navigationActivity() || await this.probeAttachedReadiness(
      sessionId, frameId, loaderId, committedUrl, navigationActivity)
    if (eventsOverflowed()) throw new Error('Chromium page bootstrap events overflowed')
    if (this.destroyedTargets.has(targetId)) {
      await this.releaseAttachment(sessionId, true)
      return undefined
    }
    if (!this.targetInfos.has(targetId) || this.closed) {
      await this.releaseAttachment(sessionId, false)
      return undefined
    }
    if (this.detachedSessions.has(sessionId)) {
      await this.transport.command('Target.closeTarget', { targetId })
      this.forget(targetId)
      this.detachedSessions.delete(sessionId)
      return undefined
    }
    const page: PageTarget = {
      targetId, sessionId, viewport: { ...DEFAULT_VIEWPORT }, active: false,
      screencasting: false, nextSequence: 1, closed: false, closing: false, detached: false,
      navigationEpoch: 0, documentEpoch: 0, acceptedInitTimestamps: new Map(), pressedKeys: new Map(),
      awaitingNavigationFrameId: false, mainFrameId: frameId, mainFrameLoadDepth: 0,
      mainFrameLoadUnconfirmed: !readyAtAttach, mainFrameLoadLoaderId: loaderId,
      agentNavigationPending: false, pendingMainDocumentRequest: false, agentLoadingRevision: 0
    }
    this.pages.set(targetId, page)
    this.bySession.set(sessionId, page)
    const info = this.targetInfos.get(targetId)
    if (info && committedUrl) this.targetInfos.set(targetId, {
      ...info, url: committedUrl, title: info.url === committedUrl ? info.title : ''
    })
    this.emitTarget('created', targetId, { frameId, loaderId })
    for (const message of attachEvents) {
      if (message.sessionId === sessionId) this.handleEvent(message)
    }
    return page
  }

  private async probeAttachedReadiness(sessionId: string, frameId?: string, loaderId?: string,
    url?: string, navigationActivity: () => boolean = () => false): Promise<boolean> {
    if (!frameId || !loaderId || !url || url === 'about:blank') return false
    try {
      const world = await this.transport.command('Page.createIsolatedWorld', {
        frameId, worldName: READINESS_WORLD, grantUniveralAccess: false
      }, sessionId) as { executionContextId?: unknown }
      if (!Number.isSafeInteger(world?.executionContextId) || Number(world.executionContextId) <= 0) return false
      const evaluated = await this.transport.command('Runtime.evaluate', {
        expression: READINESS_EXPRESSION, contextId: world.executionContextId,
        returnByValue: true, throwOnSideEffect: true, silent: true
      }, sessionId) as { result?: { type?: unknown; value?: unknown }; exceptionDetails?: unknown }
      if (evaluated?.exceptionDetails || evaluated?.result?.type !== 'string'
        || evaluated.result.value !== 'complete' || navigationActivity() || this.detachedSessions.has(sessionId)) return false
      const confirmed = await this.transport.command('Page.getFrameTree', {}, sessionId) as {
        frameTree?: { frame?: { id?: unknown; loaderId?: unknown; url?: unknown; urlFragment?: unknown } }
      }
      const current = confirmed?.frameTree?.frame
      const currentUrl = typeof current?.url === 'string' ? current.url
        + (typeof current.urlFragment === 'string' && current.urlFragment.startsWith('#') ? current.urlFragment : '') : null
      return !navigationActivity() && !this.detachedSessions.has(sessionId) &&
        current?.id === frameId && current.loaderId === loaderId && currentUrl === url
    } catch { return false }
  }

  private isAgentNavigationEvent(message: ChromiumMessage): boolean {
    return message.method === 'Page.frameStartedLoading' || message.method === 'Page.frameStoppedLoading' ||
      message.method === 'Page.frameNavigated' || message.method === 'Page.navigatedWithinDocument' ||
      message.method === 'Page.lifecycleEvent' || message.method === 'Page.frameDetached' ||
      message.method === 'Network.requestWillBeSent' && message.params.type === 'Document'
  }

  private isMainFrameNavigationEvent(message: ChromiumMessage, frameId?: string, loaderId?: string,
    beforeFrameTree = false, childFrameIds?: ReadonlySet<string>): boolean {
    if (message.method === 'Page.frameNavigated') {
      const frame = message.params.frame
      return !frame || typeof frame !== 'object' || !Object.hasOwn(frame, 'parentId')
    }
    if (message.method === 'Page.frameStartedLoading' && beforeFrameTree) {
      return typeof message.params.frameId !== 'string' || !childFrameIds?.has(message.params.frameId)
    }
    if (message.method === 'Page.lifecycleEvent') {
      return (!frameId || typeof message.params.frameId !== 'string' || message.params.frameId === frameId) &&
        (message.params.name === 'init' || !loaderId || typeof message.params.loaderId !== 'string' ||
          message.params.loaderId !== loaderId)
    }
    if (message.method === 'Page.frameStartedLoading' || message.method === 'Page.frameStoppedLoading' ||
      message.method === 'Page.navigatedWithinDocument' ||
      message.method === 'Page.frameDetached' || message.method === 'Network.requestWillBeSent') {
      return !frameId || typeof message.params.frameId !== 'string' || message.params.frameId === frameId
    }
    return false
  }

  private async releaseAttachment(sessionId: string, destroyed: boolean): Promise<void> {
    try {
      await this.transport.command('Target.detachFromTarget', { sessionId })
    } catch (error) {
      if (!destroyed) throw error
    }
  }

  private rememberDestroyed(targetId: string): void {
    if (this.discoveryBuffer || this.creations.size || this.registrations.has(targetId)) {
      this.destroyedTargets.add(targetId)
    }
  }

  private clearTransientMarkers(): void {
    if (!this.discoveryBuffer && !this.creations.size && !this.registrations.size) {
      this.destroyedTargets.clear()
      this.detachedSessions.clear()
    }
  }

  async navigate(targetId: string, url: string): Promise<ChromiumNavigationReceipt> {
    return this.serial(() => this.navigatePage(targetId, url))
  }

  private async navigatePage(targetId: string, url: string): Promise<ChromiumNavigationReceipt> {
    const page = this.page(targetId)
    const destination = pageUrl(url)
    if (page.compositionObjectId) await this.cancelComposition(page)
    page.awaitingNavigationFrameId = true
    page.agentNavigationPending = true
    let result: { errorText?: unknown; frameId?: unknown; loaderId?: unknown }
    try {
      result = await this.transport.command('Page.navigate', { url: destination }, page.sessionId) as typeof result
    } finally {
      page.awaitingNavigationFrameId = false
    }
    if (typeof result?.errorText === 'string' && result.errorText) throw new Error(`Chromium navigation failed: ${result.errorText}`)
    if (typeof result?.frameId !== 'string' || !result.frameId ||
      (result.loaderId !== undefined && (typeof result.loaderId !== 'string' || !result.loaderId))) {
      throw new Error('Chromium returned invalid navigation identity')
    }
    page.mainFrameId = result.frameId
    return { frameId: result.frameId, loaderId: typeof result.loaderId === 'string' ? result.loaderId : null }
  }

  async navigationState(targetId: string): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    return this.serial(async () => {
      const history = await this.navigationHistory(this.page(targetId))
      return { canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 }
    })
  }

  async goBack(targetId: string): Promise<void> {
    return this.serial(async () => {
      const page = this.page(targetId)
      const history = await this.navigationHistory(page)
      if (history.currentIndex <= 0) throw new Error('Chromium page has no previous history entry')
      const previousPending = page.agentNavigationPending
      const previousRevision = page.agentLoadingRevision
      page.agentNavigationPending = true
      try { await this.transport.command('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id }, page.sessionId) }
      catch (error) {
        if (error instanceof ChromiumProtocolError && page.agentLoadingRevision === previousRevision) {
          page.agentNavigationPending = previousPending
        }
        throw error
      }
    })
  }

  async goForward(targetId: string): Promise<void> {
    return this.serial(async () => {
      const page = this.page(targetId)
      const history = await this.navigationHistory(page)
      if (history.currentIndex >= history.entries.length - 1) throw new Error('Chromium page has no next history entry')
      const previousPending = page.agentNavigationPending
      const previousRevision = page.agentLoadingRevision
      page.agentNavigationPending = true
      try { await this.transport.command('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex + 1].id }, page.sessionId) }
      catch (error) {
        if (error instanceof ChromiumProtocolError && page.agentLoadingRevision === previousRevision) {
          page.agentNavigationPending = previousPending
        }
        throw error
      }
    })
  }

  async reload(targetId: string): Promise<void> {
    return this.serial(async () => {
      const page = this.page(targetId)
      const previousPending = page.agentNavigationPending
      const previousRevision = page.agentLoadingRevision
      page.agentNavigationPending = true
      try { await this.transport.command('Page.reload', {}, page.sessionId) }
      catch (error) {
        if (error instanceof ChromiumProtocolError && page.agentLoadingRevision === previousRevision) {
          page.agentNavigationPending = previousPending
        }
        throw error
      }
    })
  }

  private async navigationHistory(page: PageTarget): Promise<{ currentIndex: number; entries: Array<{ id: number }> }> {
    const history = await this.transport.command('Page.getNavigationHistory', {}, page.sessionId) as {
      currentIndex?: unknown; entries?: unknown
    }
    if (!history || !Array.isArray(history.entries) || history.entries.length > MAX_HISTORY_ENTRIES ||
      !Number.isSafeInteger(history.currentIndex) || Number(history.currentIndex) < 0 ||
      Number(history.currentIndex) >= history.entries.length ||
      !history.entries.every(entry => entry && typeof entry === 'object' &&
        Number.isSafeInteger((entry as { id?: unknown }).id) && Number((entry as { id: number }).id) >= 0)) {
      throw new Error('Chromium returned invalid page navigation history')
    }
    return { currentIndex: Number(history.currentIndex), entries: history.entries as Array<{ id: number }> }
  }

  async activate(targetId: string): Promise<void> {
    return this.serial(() => this.activatePage(targetId))
  }

  private async activatePage(targetId: string): Promise<void> {
    const page = this.page(targetId)
    if (this.activeTargetId === targetId) return
    if (this.activeTargetId) {
      const previous = this.pages.get(this.activeTargetId)
      if (previous) await this.deactivatePage(previous)
    }
    await this.ackPending(page)
    await this.transport.command('Target.activateTarget', { targetId })
    if (page.closed) throw new Error('Chromium page target was destroyed')
    await this.transport.command('Page.bringToFront', {}, page.sessionId)
    if (page.closed) throw new Error('Chromium page target was destroyed')
    page.active = true
    page.screencasting = true
    this.activeTargetId = targetId
    try {
      await this.transport.command('Page.startScreencast', {
        format: 'jpeg', quality: SCREENCAST_QUALITY,
        maxWidth: page.viewport.width, maxHeight: page.viewport.height,
        everyNthFrame: SCREENCAST_EVERY_NTH_FRAME
      }, page.sessionId)
      if (page.closed) throw new Error('Chromium page target was destroyed')
    } catch (error) {
      page.active = false
      page.screencasting = false
      if (this.activeTargetId === targetId) this.activeTargetId = undefined
      throw error
    }
  }

  async deactivate(targetId: string): Promise<void> {
    return this.serial(() => this.deactivatePage(this.page(targetId)))
  }

  private async deactivatePage(page: PageTarget): Promise<void> {
    if (page.compositionObjectId) await this.cancelComposition(page)
    for (const [code, key] of page.pressedKeys) {
      try {
        await this.transport.command('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, page.sessionId)
      } catch (error) {
        await this.abortInput(error)
      }
      page.pressedKeys.delete(code)
    }
    page.active = false
    if (this.activeTargetId === page.targetId) this.activeTargetId = undefined
    try {
      await this.ackPending(page)
    } finally {
      if (page.screencasting) {
        page.screencasting = false
        await this.transport.command('Page.stopScreencast', {}, page.sessionId)
      }
    }
  }

  async resize(targetId: string, viewport: ChromiumViewport): Promise<void> {
    return this.serial(() => this.resizePage(targetId, viewport))
  }

  private async resizePage(targetId: string, viewport: ChromiumViewport): Promise<void> {
    const page = this.page(targetId)
    if (!validViewport(viewport)) throw new Error('Invalid Chromium viewport')
    const active = page.active
    if (active) await this.deactivatePage(page)
    await this.transport.command('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false
    }, page.sessionId)
    page.viewport = { ...viewport }
    if (active && !page.closed) await this.activatePage(targetId)
  }

  async acknowledgeFrame(targetId: string, sequence: number): Promise<void> {
    const page = this.page(targetId)
    if (!page.pendingFrame || page.pendingFrame.sequence !== sequence) {
      throw new Error('Chromium frame acknowledgement is stale')
    }
    await this.ackPending(page)
  }

  async input(targetId: string, input: ChromiumMouseInput | ChromiumKeyInput | ChromiumCompositionInput): Promise<void> {
    return this.serial(() => this.inputPage(targetId, input))
  }

  private async inputPage(targetId: string, input: ChromiumMouseInput | ChromiumKeyInput | ChromiumCompositionInput): Promise<void> {
    const page = this.page(targetId)
    if (!page.active || this.activeTargetId !== targetId) throw new Error('Chromium page is not active')
    if (input.kind === 'composition') {
      await this.compose(page, input)
      return
    }
    if (input.kind === 'text') {
      if (page.compositionObjectId) throw new Error('Chromium text input overlaps an active composition')
      if (typeof input.text !== 'string' || !input.text || input.text.length > MAX_TEXT_LENGTH) throw new Error('Invalid Chromium text input')
      await this.transport.command('Input.insertText', { text: input.text }, page.sessionId)
      return
    }
    if (input.kind === 'key') {
      if (page.compositionObjectId && input.type !== 'keyUp') throw new Error('Chromium key input overlaps an active composition')
      if (!['keyDown', 'keyUp', 'char'].includes(input.type) ||
        !input.key || input.key.length > MAX_KEY_LENGTH || !input.code || input.code.length > MAX_KEY_LENGTH ||
        !Number.isInteger(input.windowsVirtualKeyCode) || input.windowsVirtualKeyCode < 0 ||
        input.windowsVirtualKeyCode > MAX_VIRTUAL_KEY_CODE || !Number.isInteger(input.modifiers ?? 0) ||
        (input.modifiers ?? 0) < 0 || (input.modifiers ?? 0) > MAX_KEY_MODIFIERS) throw new Error('Invalid Chromium key input')
      await this.transport.command('Input.dispatchKeyEvent', {
        type: input.type, key: input.key, code: input.code,
        windowsVirtualKeyCode: input.windowsVirtualKeyCode, modifiers: input.modifiers ?? 0
      }, page.sessionId)
      if (input.type === 'keyDown' && !page.pressedKeys.has(input.code)) {
        page.pressedKeys.set(input.code, {
          key: input.key, code: input.code,
          windowsVirtualKeyCode: input.windowsVirtualKeyCode, modifiers: input.modifiers ?? 0
        })
      }
      if (input.type === 'keyUp') page.pressedKeys.delete(input.code)
      return
    }
    if (!validCoordinate(input.x, page.viewport.width) || !validCoordinate(input.y, page.viewport.height)) {
      throw new Error('Chromium pointer is outside the viewport')
    }
    if (input.kind === 'wheel') {
      if (!Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY) ||
        Math.abs(input.deltaX) > MAX_WHEEL_DELTA || Math.abs(input.deltaY) > MAX_WHEEL_DELTA) {
        throw new Error('Invalid Chromium wheel input')
      }
      await this.transport.command('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY
      }, page.sessionId)
      return
    }
    if (input.kind !== 'mouse' || !['mouseMoved', 'mousePressed', 'mouseReleased'].includes(input.type) ||
      !['none', 'left', 'middle', 'right'].includes(input.button)) throw new Error('Invalid Chromium mouse input')
    if (!Number.isInteger(input.clickCount ?? 1) || (input.clickCount ?? 1) < 1 ||
      (input.clickCount ?? 1) > MAX_CLICK_COUNT) throw new Error('Invalid Chromium click count')
    if (page.compositionObjectId && input.type === 'mousePressed') await this.cancelComposition(page)
    await this.transport.command('Input.dispatchMouseEvent', {
      type: input.type, x: input.x, y: input.y,
      button: input.button, clickCount: input.clickCount ?? 1
    }, page.sessionId)
  }

  private async compose(page: PageTarget, input: ChromiumCompositionInput): Promise<void> {
    if (!['begin', 'update', 'commit', 'cancel'].includes(input.phase)) {
      throw new Error('Invalid Chromium composition phase')
    }
    if (input.phase === 'cancel') {
      if (!page.compositionObjectId) throw new Error('Chromium composition is not active')
      await this.cancelComposition(page)
      return
    }
    if (typeof input.text !== 'string' || !input.text || input.text.length > MAX_TEXT_LENGTH) {
      throw new Error('Invalid Chromium composition text')
    }
    if (input.phase === 'begin' && page.compositionObjectId || input.phase !== 'begin' && !page.compositionObjectId) {
      throw new Error('Chromium composition is not active in the requested phase')
    }
    if (input.phase !== 'commit' && (
      !Number.isInteger(input.selectionStart) || !Number.isInteger(input.selectionEnd) ||
      input.selectionStart < 0 || input.selectionEnd < input.selectionStart || input.selectionEnd > input.text.length
    )) throw new Error('Invalid Chromium composition selection')
    let objectId = page.compositionObjectId
    if (input.phase === 'begin') {
      const focus = await this.transport.command('Runtime.evaluate', {
        expression: ACTIVE_ELEMENT_EXPRESSION
      }, page.sessionId) as { result?: { objectId?: unknown } }
      objectId = typeof focus?.result?.objectId === 'string' ? focus.result.objectId : undefined
    }
    if (!objectId) throw new Error('Chromium page is not focused on an editable element')
    const focused = await this.editableFocus(page, objectId)
    if (!focused) {
      if (page.compositionObjectId === objectId) page.compositionObjectId = undefined
      await this.transport.command('Runtime.releaseObject', { objectId }, page.sessionId)
      throw new Error('Chromium page is not focused on the original editable element')
    }
    const current = this.page(page.targetId)
    if (current !== page || !page.active || this.activeTargetId !== page.targetId) throw new Error('Chromium page is not active')
    const navigationEpoch = page.navigationEpoch
    if (input.phase === 'commit') {
      try {
        await this.transport.command('Input.insertText', { text: input.text }, page.sessionId)
      } catch (error) {
        await this.abortInput(error)
      }
      if (page.navigationEpoch !== navigationEpoch) await this.abortInput(new Error('Chromium page navigated during composition commit'))
      page.compositionObjectId = undefined
      await this.transport.command('Runtime.releaseObject', { objectId }, page.sessionId)
      return
    }
    try {
      await this.transport.command('Input.imeSetComposition', {
        text: input.text, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd
      }, page.sessionId)
    } catch (error) {
      await this.abortInput(error)
    }
    if (page.navigationEpoch !== navigationEpoch) await this.abortInput(new Error('Chromium page navigated during composition update'))
    page.compositionObjectId = objectId
  }

  private async cancelComposition(page: PageTarget): Promise<void> {
    const objectId = page.compositionObjectId
    if (!objectId) return
    try {
      await this.transport.command('Input.imeSetComposition', {
        text: '', selectionStart: 0, selectionEnd: 0
      }, page.sessionId)
    } catch (error) {
      await this.abortInput(error)
    }
    page.compositionObjectId = undefined
    await this.transport.command('Runtime.releaseObject', { objectId }, page.sessionId)
  }

  private async editableFocus(page: PageTarget, objectId: string): Promise<boolean> {
    const result = await this.transport.command('Runtime.callFunctionOn', {
      objectId, functionDeclaration: EDITABLE_FOCUS_FUNCTION, returnByValue: true
    }, page.sessionId) as { result?: { value?: unknown } }
    return result?.result?.value === true
  }

  private async abortInput(error: unknown): Promise<never> {
    this.closed = true
    this.detachEvent()
    this.pages.clear()
    this.bySession.clear()
    this.targetInfos.clear()
    this.targetListeners.clear()
    this.agentPageListeners.clear()
    this.destroyedTargets.clear()
    this.detachedSessions.clear()
    this.frameListeners.clear()
    this.activeTargetId = undefined
    this.closing = this.transport.close()
    try {
      await this.closing
    } catch (closeError) {
      throw new AggregateError([error, closeError], 'Chromium input and isolated pipe closure failed')
    }
    throw error
  }

  async closeTarget(targetId: string): Promise<void> {
    return this.serial(() => this.closePage(targetId))
  }

  private async closePage(targetId: string): Promise<void> {
    const page = this.pages.get(targetId)
    if (!page || page.closed || page.closing) throw new Error('Unknown Chromium page target')
    page.closing = true
    try {
      const result = await this.transport.command('Target.closeTarget', { targetId }) as { success?: unknown }
      if (result?.success !== true) throw new Error('Chromium did not close the page target')
      this.forget(targetId)
    } catch (error) {
      if (page.closed) return
      if (this.pages.get(targetId) === page) page.closing = false
      throw error
    } finally {
      if (this.activeTargetId === targetId && page.closed) this.activeTargetId = undefined
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.detachEvent()
    for (const page of this.pages.values()) {
      this.clearPendingCommit(page)
      page.acceptedInitTimestamps.clear()
    }
    this.closing = this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    await Promise.allSettled([...this.creations])
    await Promise.allSettled([...this.registrations.values()])
    await this.transition
    const targetIds = [...this.pages.keys()]
    const results = await Promise.allSettled(targetIds.map(targetId => this.closePage(targetId)))
    this.frameListeners.clear()
    this.targetListeners.clear()
    this.agentPageListeners.clear()
    this.destroyedTargets.clear()
    this.detachedSessions.clear()
    const failure = results.find(result => result.status === 'rejected')
    let transportFailure: unknown
    try { await this.transport.close() } catch (error) { transportFailure = error }
    if (failure?.status === 'rejected' && transportFailure) throw new AggregateError([failure.reason, transportFailure], 'Chromium target and transport shutdown failed')
    if (failure?.status === 'rejected') throw failure.reason
    if (transportFailure) throw transportFailure
  }

  private handleEvent(message: ChromiumMessage): void {
    if (this.closed) return
    const agentPage = message.sessionId ? this.bySession.get(message.sessionId) : undefined
    if (agentPage) {
      if (this.isDuplicateCompletedCommit(agentPage, message)) return
      this.updateAgentLoading(agentPage, message)
      if ((message.method.startsWith('Page.') && message.method !== 'Page.screencastFrame')
        || message.method.startsWith('Network.')) {
        for (const listener of this.agentPageListeners) {
          try { listener({ targetId: agentPage.targetId, method: message.method, params: { ...message.params } }) }
          catch (error) { console.error('[browser-chromium] Agent page listener failed', error) }
        }
      }
    }
    if (message.method === 'Page.lifecycleEvent' && message.sessionId) {
      const page = this.bySession.get(message.sessionId)
      const { frameId, loaderId, name, timestamp } = message.params
      if (!page || typeof frameId !== 'string' || frameId !== page.mainFrameId ||
        typeof loaderId !== 'string' || !loaderId || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return
      if (name === 'init') {
        const identity = JSON.stringify([frameId, loaderId])
        const previousTimestamp = page.acceptedInitTimestamps.get(identity)
        if (previousTimestamp !== undefined && timestamp <= previousTimestamp) return
        page.acceptedInitTimestamps.delete(identity)
        page.acceptedInitTimestamps.set(identity, timestamp)
        if (page.acceptedInitTimestamps.size > MAX_DOCUMENT_INIT_IDENTITIES) {
          const oldestIdentity = page.acceptedInitTimestamps.keys().next().value
          if (oldestIdentity !== undefined) page.acceptedInitTimestamps.delete(oldestIdentity)
        }
        page.lifecycleDocument = { frameId, loaderId, epoch: ++page.documentEpoch, initTimestamp: timestamp }
        if (page.pendingCommit?.frameId === frameId && page.pendingCommit.loaderId === loaderId) {
          const pending = page.pendingCommit
          this.clearPendingCommit(page)
          this.emitMainCommit(page, frameId, loaderId, pending.url, page.lifecycleDocument.epoch, 'Navigation')
        }
        return
      }
      if (name !== 'DOMContentLoaded' && name !== 'load') return
      const document = page.lifecycleDocument
      if (!document || document.frameId !== frameId || document.loaderId !== loaderId ||
        timestamp < document.initTimestamp) return
      this.emitTarget('ready', page.targetId, { frameId, loaderId, documentEpoch: document.epoch })
      return
    }
    if (message.method === 'Network.responseReceived' && message.sessionId) {
      const page = this.bySession.get(message.sessionId)
      const { type, frameId, loaderId, response } = message.params
      if (!page || type !== 'Document' || typeof frameId !== 'string' || !frameId ||
        typeof loaderId !== 'string' || !loaderId || !response || typeof response !== 'object') return
      if (page.mainFrameId && frameId !== page.mainFrameId) return
      const { url, status } = response as { url?: unknown; status?: unknown }
      if (typeof url !== 'string' || !url || !Number.isInteger(status) ||
        (status as number) < 100 || (status as number) > 599) return
      this.emitTarget('response', page.targetId, { frameId, loaderId, status: status as number }, { url })
      return
    }
    if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged' ||
      message.method === 'Target.targetDestroyed') {
      if (this.discoveryBuffer) this.discoveryBuffer.push(message)
      else if (this.discovering) this.applyTargetEvent(message, true)
      else if (message.method === 'Target.targetDestroyed' && typeof message.params.targetId === 'string') {
        this.rememberDestroyed(message.params.targetId)
        this.forget(message.params.targetId)
      }
      return
    }
    if (message.method === 'Page.frameNavigated' && message.sessionId) {
      const page = this.bySession.get(message.sessionId)
      const frame = message.params.frame
      if (page && frame && typeof frame === 'object' &&
        typeof (frame as { id?: unknown }).id === 'string' &&
        !Object.hasOwn(frame, 'parentId')) {
        page.navigationEpoch++
        page.compositionObjectId = undefined
        page.mainFrameId = (frame as { id: string }).id
        const url = (frame as { url?: unknown }).url
        const urlFragment = (frame as { urlFragment?: unknown }).urlFragment
        const loaderId = (frame as { loaderId?: unknown }).loaderId
        const info = this.targetInfos.get(page.targetId)
        if (typeof url === 'string' && info) {
          const fullUrl = url + (typeof urlFragment === 'string' && urlFragment.startsWith('#') ? urlFragment : '')
          this.targetInfos.set(page.targetId, { ...info, url: fullUrl, title: info.url === fullUrl ? info.title : '' })
          if (page.pendingCommit) {
            this.failClosed(new Error('Chromium main-frame commit changed before document init'))
            return
          }
          if (message.params.type === 'Navigation' && typeof loaderId === 'string' && loaderId) {
            const document = page.lifecycleDocument
            const previous = page.lastCommit
            if (!document || document.frameId !== page.mainFrameId || document.loaderId !== loaderId ||
              (previous?.frameId === page.mainFrameId && previous.loaderId === loaderId &&
                previous.documentEpoch === document.epoch && previous.url !== fullUrl)) {
              const frameId = page.mainFrameId
              const timer = setTimeout(() => {
                if (!this.closed && page.pendingCommit?.timer === timer) {
                  this.failClosed(new Error('Chromium main-frame document init timed out'))
                }
              }, this.documentInitTimeoutMs)
              timer.unref?.()
              page.pendingCommit = { frameId, loaderId, url: fullUrl, timer }
              return
            }
            this.emitMainCommit(page, page.mainFrameId, loaderId, fullUrl, document.epoch, 'Navigation')
          } else {
            this.emitMainCommit(page, page.mainFrameId, typeof loaderId === 'string' ? loaderId : undefined,
              fullUrl, undefined, message.params.type === 'BackForwardCacheRestore' ? 'BackForwardCacheRestore' : undefined)
          }
        }
      }
      return
    }
    if (message.method === 'Page.navigatedWithinDocument' && message.sessionId) {
      const page = this.bySession.get(message.sessionId)
      const { frameId, url } = message.params
      if (!page || typeof frameId !== 'string' || !frameId || typeof url !== 'string' ||
        (page.mainFrameId ? frameId !== page.mainFrameId : !page.awaitingNavigationFrameId)) return
      const info = this.targetInfos.get(page.targetId)
      if (!info) return
      if (page.mainFrameId) this.targetInfos.set(page.targetId, { ...info, url })
      this.emitTarget('same-document', page.targetId, { frameId }, { url })
      return
    }
    if (message.method === 'Target.detachedFromTarget' && typeof message.params.sessionId === 'string') {
      const page = this.bySession.get(message.params.sessionId)
      if (page) {
        page.detached = true
        page.active = false
        page.screencasting = false
        page.pendingFrame = undefined
        this.bySession.delete(page.sessionId)
        if (this.activeTargetId === page.targetId) this.activeTargetId = undefined
        this.emitTarget('detached', page.targetId)
        void this.serial(async () => {
          if (this.pages.get(page.targetId) === page) await this.closePage(page.targetId)
        }).catch(error => this.failClosed(error))
      } else if (this.registrations.size) {
        this.detachedSessions.add(message.params.sessionId)
      }
      return
    }
    if (message.method !== 'Page.screencastFrame' || !message.sessionId) return
    const page = this.bySession.get(message.sessionId)
    if (!page) return
    const { data, metadata, sessionId } = message.params
    if (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId < 0) return
    if (!page.active || !page.screencasting || this.activeTargetId !== page.targetId) {
      void this.transport.command('Page.screencastFrameAck', { sessionId }, page.sessionId).catch(() => undefined)
      return
    }
    if (page.pendingFrame) {
      void this.transport.command('Page.screencastFrameAck', { sessionId }, page.sessionId).catch(() => undefined)
      return
    }
    if (!this.frameListeners.size) {
      void this.transport.command('Page.screencastFrameAck', { sessionId }, page.sessionId).catch(error => this.failClosed(error))
      return
    }
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_FRAME_BYTES * 4 / 3) + 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || Buffer.byteLength(data, 'base64') > MAX_FRAME_BYTES ||
      !metadata || typeof metadata !== 'object') {
      void this.transport.command('Page.screencastFrameAck', { sessionId }, page.sessionId).catch(() => undefined)
      return
    }
    const dimensions = jpegDimensions(Buffer.from(data, 'base64'))
    if (!dimensions || !validViewport(dimensions)) {
      void this.transport.command('Page.screencastFrameAck', { sessionId }, page.sessionId).catch(() => undefined)
      return
    }
    const sequence = page.nextSequence++
    page.pendingFrame = { sequence, chromeSessionId: sessionId }
    const frame: ChromiumFrame = { targetId: page.targetId, sequence, data, format: 'jpeg', ...dimensions }
    for (const listener of this.frameListeners) {
      try { listener(frame) } catch {
        void this.ackPending(page).catch(() => undefined)
      }
    }
  }

  private updateAgentLoading(page: PageTarget, message: ChromiumMessage): void {
    if (message.method === 'Network.requestWillBeSent') {
      if (message.params.type === 'Document' && message.params.frameId === page.mainFrameId) {
        page.agentLoadingRevision += 1
        page.pendingMainDocumentRequest = true
      }
    } else if (message.method === 'Page.frameStartedLoading') {
      if (message.params.frameId === page.mainFrameId) {
        page.agentLoadingRevision += 1
        page.mainFrameLoadDepth += 1
      }
    } else if (message.method === 'Page.frameStoppedLoading') {
      if (message.params.frameId === page.mainFrameId) {
        page.agentLoadingRevision += 1
        if (page.mainFrameLoadDepth > 0) page.mainFrameLoadDepth -= 1
      }
    } else if (message.method === 'Page.frameNavigated') {
      const frame = message.params.frame as { id?: unknown; parentId?: unknown; loaderId?: unknown } | undefined
      if (!frame || typeof frame.id !== 'string' || Object.hasOwn(frame, 'parentId')) return
      page.agentLoadingRevision += 1
      page.agentNavigationPending = false
      page.pendingMainDocumentRequest = false
      page.mainFrameLoadDepth = 0
      if (message.params.type === 'BackForwardCacheRestore') {
        page.mainFrameLoadUnconfirmed = false
        page.mainFrameLoadLoaderId = undefined
      } else {
        page.mainFrameLoadUnconfirmed = true
        page.mainFrameLoadLoaderId = typeof frame.loaderId === 'string' ? frame.loaderId : undefined
      }
    } else if (message.method === 'Page.navigatedWithinDocument') {
      if (message.params.frameId === page.mainFrameId) {
        page.agentLoadingRevision += 1
        page.agentNavigationPending = false
      }
    } else if (message.method === 'Page.lifecycleEvent') {
      if (message.params.frameId === page.mainFrameId) page.agentLoadingRevision += 1
      const document = page.lifecycleDocument
      if (message.params.name === 'load' && message.params.frameId === page.mainFrameId
        && page.mainFrameLoadLoaderId && message.params.loaderId === page.mainFrameLoadLoaderId
        && document && document.frameId === page.mainFrameId && document.loaderId === page.mainFrameLoadLoaderId
        && typeof message.params.timestamp === 'number' && message.params.timestamp >= document.initTimestamp) {
        page.mainFrameLoadUnconfirmed = false
      }
    }
  }

  private isDuplicateCompletedCommit(page: PageTarget, message: ChromiumMessage): boolean {
    if (message.method !== 'Page.frameNavigated' || message.params.type !== 'Navigation' ||
      page.mainFrameLoadDepth !== 0 || page.mainFrameLoadUnconfirmed || page.agentNavigationPending ||
      page.pendingMainDocumentRequest) return false
    const frame = message.params.frame as { id?: unknown; parentId?: unknown; loaderId?: unknown;
      url?: unknown; urlFragment?: unknown } | undefined
    const last = page.lastCommit
    const document = page.lifecycleDocument
    if (!frame || Object.hasOwn(frame, 'parentId') || typeof frame.url !== 'string' || !last || !document ||
      last.documentEpoch !== document.epoch) return false
    const url = frame.url + (typeof frame.urlFragment === 'string' && frame.urlFragment.startsWith('#')
      ? frame.urlFragment : '')
    return frame.id === page.mainFrameId && frame.id === last.frameId && frame.loaderId === last.loaderId &&
      url === last.url
  }

  private applyTargetEvent(message: ChromiumMessage, register: boolean): void {
    if (message.method === 'Target.targetDestroyed') {
      const targetId = message.params.targetId
      if (typeof targetId !== 'string' || !targetId) return
      this.rememberDestroyed(targetId)
      this.forget(targetId)
      return
    }
    const info = message.params.targetInfo
    if (!info || typeof info !== 'object') return
    const targetId = (info as { targetId?: unknown }).targetId
    if (typeof targetId !== 'string' || !targetId || this.destroyedTargets.has(targetId)) return
    if ((info as { type?: unknown }).type !== 'page') {
      const page = this.pages.get(targetId)
      this.forget(targetId)
      if (page) void this.serial(() => this.releaseAttachment(page.sessionId, false)).catch(error => this.failClosed(error))
      return
    }
    if (message.method === 'Target.targetInfoChanged' && !this.targetInfos.has(targetId)) return
    if (this.recordTarget(info) && register) {
      if (!this.pages.has(targetId)) void this.register(targetId).catch(error => this.failClosed(error))
      else this.emitTarget('updated', targetId)
    }
  }

  private recordTarget(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const info = value as { targetId?: unknown; type?: unknown; url?: unknown; title?: unknown }
    if (info.type !== 'page' || typeof info.targetId !== 'string' || !info.targetId ||
      this.destroyedTargets.has(info.targetId)) return false
    const next: ChromiumTargetInfo = {
      targetId: info.targetId,
      url: typeof info.url === 'string' ? info.url : '',
      title: typeof info.title === 'string' ? info.title : ''
    }
    const previous = this.targetInfos.get(next.targetId)
    if (previous?.url === next.url && previous.title === next.title) return false
    this.targetInfos.set(next.targetId, next)
    return true
  }

  private emitTarget(kind: ChromiumTargetEvent['kind'], targetId: string,
    metadata: Pick<ChromiumTargetEvent, 'loaderId' | 'frameId' | 'status' | 'navigationType' | 'documentEpoch'> = {},
    infoOverride: Partial<ChromiumTargetInfo> = {}): void {
    const info = this.targetInfos.get(targetId)
    if (!info) return
    for (const listener of this.targetListeners) {
      try { listener({ kind, info: { ...info, ...infoOverride }, ...metadata }) } catch (error) {
        console.error('[browser-chromium] target listener failed', error)
      }
    }
  }

  private emitMainCommit(page: PageTarget, frameId: string, loaderId: string | undefined, url: string,
    documentEpoch?: number, navigationType?: ChromiumTargetEvent['navigationType']): void {
    page.lastCommit = { frameId, loaderId: loaderId ?? '', url, documentEpoch }
    this.emitTarget('navigated', page.targetId, { frameId, loaderId, documentEpoch, navigationType }, { url })
  }

  private clearPendingCommit(page: PageTarget): void {
    if (page.pendingCommit) clearTimeout(page.pendingCommit.timer)
    page.pendingCommit = undefined
  }

  private async ackPending(page: PageTarget): Promise<void> {
    const pending = page.pendingFrame
    if (!pending) return
    if (pending.acknowledgement) return pending.acknowledgement
    pending.acknowledgement = this.transport.command('Page.screencastFrameAck', {
      sessionId: pending.chromeSessionId
    }, page.sessionId).then(() => {
      if (page.pendingFrame === pending) page.pendingFrame = undefined
    }, error => {
      pending.acknowledgement = undefined
      throw error
    })
    return pending.acknowledgement
  }

  private forget(targetId: string): void {
    const page = this.pages.get(targetId)
    if (page) {
      this.clearPendingCommit(page)
      page.acceptedInitTimestamps.clear()
      this.emitTarget('destroyed', targetId)
      page.closed = true
      this.pages.delete(targetId)
      this.bySession.delete(page.sessionId)
      this.detachedSessions.delete(page.sessionId)
      if (this.activeTargetId === targetId) this.activeTargetId = undefined
    }
    this.targetInfos.delete(targetId)
  }

  private page(targetId: string): PageTarget {
    this.assertOpen()
    const page = this.pages.get(targetId)
    if (!page || page.closed || page.closing || page.detached) throw new Error('Unknown Chromium page target')
    return page
  }

  private failClosed(error: unknown): void {
    if (this.closed) return
    console.error('[browser-chromium] target session failed', error)
    for (const page of this.pages.values()) {
      this.clearPendingCommit(page)
      page.acceptedInitTimestamps.clear()
    }
    for (const targetId of this.pages.keys()) this.emitTarget('destroyed', targetId)
    this.closed = true
    this.detachEvent()
    this.pages.clear()
    this.bySession.clear()
    this.targetInfos.clear()
    this.targetListeners.clear()
    this.agentPageListeners.clear()
    this.frameListeners.clear()
    this.destroyedTargets.clear()
    this.detachedSessions.clear()
    this.activeTargetId = undefined
    this.closing = this.transport.close()
    void this.closing.catch(closeError => {
      console.error('[browser-chromium] failed to close isolated Chromium', closeError)
    })
  }

  async abort(error: unknown): Promise<void> {
    this.failClosed(error)
    await this.closing
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Chromium targets are closed')
  }

  private serial<Result>(action: () => Promise<Result>): Promise<Result> {
    const result = this.transition.then(action)
    this.transition = result.then(() => undefined, () => undefined)
    return result
  }
}
