import {
  BROWSER_CDP_STATUS, BROWSER_ERROR, parseBrowserCommand, parseBrowserDataRequest, parseBrowserHistoryRequest, parseBrowserPolicyRequest,
  type BrowserDataReply, type BrowserHistoryReply, type BrowserPolicyReply,
  type BrowserPolicySnapshot, type BrowserReply, type BrowserSnapshot, type BrowserVisit,
} from '../src/browser.ts'

export const PREVIEW_BROWSER = {
  path: '/__preview/browser',
  delayMs: 2_000,
  sampleCount: 24,
  sampleOrigin: 'https://preview.example.org',
  visitIntervalMs: 60_000,
  disposed: 'preview_browser_disposed',
  recoveryPath: '/__preview/browser/recover',
  recoveryUnavailable: 'preview_browser_recovery_unavailable',
  blankPage: 'about:blank',
  surfaceSampleCount: 2,
  maxSurfaceTabs: 100,
} as const

export interface PreviewBrowserPolicy {
  seed: 'sample' | 'empty'
  policyRead?: 'normal' | 'delayed' | 'failed' | 'fail-once'
  historyRead?: 'normal' | 'delayed' | 'failed'
  write?: 'normal' | 'delayed' | 'fail-once'
  surface?: {
    seed: 'empty' | 'sample'
    read?: 'normal' | 'delayed' | 'failed'
    write?: 'normal' | 'delayed' | 'fail-once'
  }
}

export class PreviewBrowserError extends Error {
  readonly status: number
  constructor(code: string, status: number) { super(code); this.status = status }
}

function parseRequest<Value>(parser: (value: unknown) => Value, value: unknown): Value | null {
  try { return parser(value) }
  catch (error) {
    if (error instanceof Error && error.message === BROWSER_ERROR.invalidCommand) return null
    throw error
  }
}

export class PreviewBrowser {
  private readonly policy: PreviewBrowserPolicy
  private sites: BrowserPolicySnapshot
  private visits: BrowserVisit[]
  private disposed = false
  private policyFailed = false
  private policyRecovered = false
  private writeFailed = false
  private clearing = false
  private surfaceWriting = false
  private surfaceWriteFailed = false
  private readonly surface: BrowserSnapshot = { tabs: [], activeTabId: null, automation: { enabled: false, port: null } }
  private readonly pending = new Set<() => void>()

  constructor(policy: PreviewBrowserPolicy, now = Date.now()) {
    this.policy = { ...policy, ...(policy.surface ? { surface: { ...policy.surface } } : {}) }
    this.sites = { revision: 0, agentBrowserUseEnabled: false, sites: policy.seed === 'sample' ? [{ origin: PREVIEW_BROWSER.sampleOrigin, read: 'allow', interact: 'ask' }] : [] }
    this.visits = policy.seed === 'sample' ? Array.from({ length: PREVIEW_BROWSER.sampleCount }, (_, index) => ({
      id: crypto.randomUUID(),
      url: `${PREVIEW_BROWSER.sampleOrigin}/notes/${index + 1}`,
      title: `模拟浏览记录 ${index + 1}`,
      visitedAt: now - index * PREVIEW_BROWSER.visitIntervalMs,
    })) : []
    if (this.policy.surface?.seed === 'sample') {
      this.surface.tabs = Array.from({ length: PREVIEW_BROWSER.surfaceSampleCount }, () => this.blankTab())
      this.surface.activeTabId = this.surface.tabs[0]?.tabId ?? null
    }
  }

  private blankTab(): BrowserSnapshot['tabs'][number] {
    return { tabId: crypto.randomUUID(), url: PREVIEW_BROWSER.blankPage, title: '', loading: false,
      canGoBack: false, canGoForward: false, navigationError: null, devtoolsOpen: false, cdpStatus: BROWSER_CDP_STATUS.disabled }
  }

  async snapshotRequest(signal?: AbortSignal): Promise<BrowserReply> {
    this.active(signal)
    if (!this.policy.surface) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    if (this.policy.surface.read === 'failed') return { ok: false, error: BROWSER_ERROR.operationFailed }
    if (this.policy.surface.read === 'delayed') await this.wait(signal)
    this.active(signal)
    return { ok: true, snapshot: structuredClone(this.surface) }
  }

  async commandRequest(value: unknown, signal?: AbortSignal): Promise<BrowserReply> {
    this.active(signal)
    if (!this.policy.surface) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    const parsed = parseRequest(parseBrowserCommand, value)
    if (!parsed) return { ok: false, error: BROWSER_ERROR.invalidCommand }
    const request = structuredClone(parsed)
    if (request.kind !== 'open' && request.kind !== 'select' && request.kind !== 'close') return { ok: false, error: BROWSER_ERROR.permissionDenied }
    if (request.kind === 'open' && request.input !== undefined && request.input !== PREVIEW_BROWSER.blankPage) return { ok: false, error: BROWSER_ERROR.permissionDenied }
    if (request.kind !== 'open' && !this.surface.tabs.some(tab => tab.tabId === request.tabId)) return { ok: false, error: BROWSER_ERROR.targetClosed }
    if (this.surfaceWriting) return { ok: false, error: BROWSER_ERROR.cdpBusy }
    if (request.kind === 'open' && this.surface.tabs.length >= PREVIEW_BROWSER.maxSurfaceTabs) return { ok: false, error: BROWSER_ERROR.operationFailed }
    this.surfaceWriting = true
    try {
      if (this.policy.surface.write === 'delayed') await this.wait(signal)
      else await Promise.resolve()
      this.active(signal)
      if (this.policy.surface.write === 'fail-once' && !this.surfaceWriteFailed) {
        this.surfaceWriteFailed = true
        return { ok: false, error: BROWSER_ERROR.operationFailed }
      }
      if (request.kind === 'open') {
        const tab = this.blankTab()
        this.surface.tabs.push(tab)
        this.surface.activeTabId = tab.tabId
      } else if (request.kind === 'select') this.surface.activeTabId = request.tabId
      else {
        this.surface.tabs = this.surface.tabs.filter(tab => tab.tabId !== request.tabId)
        if (this.surface.activeTabId === request.tabId) this.surface.activeTabId = this.surface.tabs[0]?.tabId ?? null
      }
      return { ok: true, snapshot: structuredClone(this.surface) }
    } finally { this.surfaceWriting = false }
  }

  private active(signal?: AbortSignal): void {
    if (this.disposed || signal?.aborted) throw new PreviewBrowserError(PREVIEW_BROWSER.disposed, 410)
  }

  private async wait(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = (cancelled: boolean): void => {
        clearTimeout(timer)
        this.pending.delete(cancel)
        signal?.removeEventListener('abort', cancel)
        if (cancelled) reject(new PreviewBrowserError(PREVIEW_BROWSER.disposed, 410))
        else resolve()
      }
      const cancel = (): void => finish(true)
      const timer = setTimeout(() => finish(false), PREVIEW_BROWSER.delayMs)
      this.pending.add(cancel)
      signal?.addEventListener('abort', cancel, { once: true })
    })
    this.active(signal)
  }

  private async writable(signal?: AbortSignal): Promise<boolean> {
    this.active(signal)
    if (this.policy.write === 'fail-once' && !this.writeFailed) {
      this.writeFailed = true
      return false
    }
    if (this.policy.write === 'delayed') await this.wait(signal)
    return true
  }

  async policyRequest(value: unknown, signal?: AbortSignal): Promise<BrowserPolicyReply> {
    this.active(signal)
    const request = parseRequest(parseBrowserPolicyRequest, value)
    if (!request) return { ok: false, error: BROWSER_ERROR.invalidCommand }
    if (request.kind === 'read') {
      if (!this.policyRecovered && (this.policy.policyRead === 'failed' || this.policy.policyRead === 'fail-once' && !this.policyFailed)) {
        this.policyFailed = true
        return { ok: false, error: BROWSER_ERROR.policyUnavailable }
      }
      if (this.policy.policyRead === 'delayed') await this.wait(signal)
      this.active(signal)
      return { ok: true, policy: structuredClone(this.sites) }
    }
    const writable = await this.writable(signal)
    this.active(signal)
    if (!writable) return { ok: false, error: BROWSER_ERROR.policyUnavailable }
    const next = structuredClone(this.sites)
    if (request.kind === 'set-agent-use') next.agentBrowserUseEnabled = request.enabled
    else if (request.kind === 'remove') next.sites = next.sites.filter(site => site.origin !== request.origin)
    else {
      let site = next.sites.find(site => site.origin === request.origin)
      if (!site) { site = { origin: request.origin, read: 'ask', interact: 'ask' }; next.sites.push(site) }
      site[request.action] = request.decision
      next.sites = next.sites.filter(site => site.read !== 'ask' || site.interact !== 'ask')
    }
    if (JSON.stringify(next) !== JSON.stringify(this.sites)) { next.revision += 1; this.sites = next }
    return { ok: true, policy: structuredClone(this.sites) }
  }

  async historyRequest(value: unknown, signal?: AbortSignal): Promise<BrowserHistoryReply> {
    this.active(signal)
    const request = parseRequest(parseBrowserHistoryRequest, value)
    if (!request) return { ok: false, error: BROWSER_ERROR.invalidCommand }
    if (this.clearing) return { ok: false, error: BROWSER_ERROR.cdpBusy }
    if (request.kind !== 'query') {
      if (request.kind === 'reopen') return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
      this.clearing = true
      try {
        const writable = await this.writable(signal)
        this.active(signal)
        if (!writable) return { ok: false, error: BROWSER_ERROR.operationFailed }
        const previous = this.visits.length
        this.visits = this.visits.filter(visit => visit.id !== request.id)
        return { ok: true, deleted: previous !== this.visits.length }
      } finally { this.clearing = false }
    }
    if (this.policy.historyRead === 'failed') return { ok: false, error: BROWSER_ERROR.operationFailed }
    if (this.policy.historyRead === 'delayed') await this.wait(signal)
    this.active(signal)
    const search = request.query.search?.trim().toLocaleLowerCase() ?? ''
    const matched = this.visits.filter(visit => (visit.url + visit.title).toLocaleLowerCase().includes(search))
      .sort((left, right) => right.visitedAt - left.visitedAt || right.id.localeCompare(left.id))
    return { ok: true, page: { items: structuredClone(matched.slice(request.query.offset, request.query.offset + request.query.limit)), total: matched.length } }
  }

  async dataRequest(value: unknown, signal?: AbortSignal): Promise<BrowserDataReply> {
    this.active(signal)
    const request = parseRequest(parseBrowserDataRequest, value)
    if (!request) return { ok: false, error: BROWSER_ERROR.invalidCommand }
    if (request.kind !== 'clear-history' && !(request.kind === 'clear-selected' && request.types.length === 1 && request.types[0] === 'history')) return { ok: false, error: BROWSER_ERROR.desktopBridgeUnavailable }
    if (this.clearing) return { ok: false, error: BROWSER_ERROR.cdpBusy }
    this.clearing = true
    try {
      const writable = await this.writable(signal)
      this.active(signal)
      if (!writable) return { ok: false, error: BROWSER_ERROR.operationFailed }
      const previous = this.visits.length
      const since = request.kind === 'clear-history' ? request.since : undefined
      this.visits = this.visits.filter(visit => since !== undefined && visit.visitedAt < since)
      return { ok: true, deleted: previous - this.visits.length }
    } finally { this.clearing = false }
  }

  dispose(): void {
    this.disposed = true
    for (const cancel of this.pending) cancel()
    this.pending.clear()
  }

  recoverPolicy(): void {
    this.active()
    if (this.policy.policyRead !== 'failed') throw new PreviewBrowserError(PREVIEW_BROWSER.recoveryUnavailable, 409)
    this.policyRecovered = true
  }
}
