import { randomUUID } from 'node:crypto'
import { BROWSER_CDP_STATUS, BROWSER_ERROR } from '../browser.ts'
import type { BrowserPageCommand, BrowserSnapshot, BrowserTabSnapshot } from '../browser.ts'
import { normalizeBrowserInput } from './navigation.ts'
import type { ChromiumNavigationReceipt, ChromiumTargetEvent, ChromiumTargetInfo, ChromiumTargets } from './chromiumtarget.ts'
import type { ChromiumInspectorHost } from './inspector.ts'

const BLANK_PAGE = 'about:blank'
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
const MAX_NAVIGATION_TIMEOUT_MS = 120_000
const MAX_EARLY_NAVIGATION_EVENTS = 16
const MAX_PENDING_HISTORY_RESPONSES = 16
const MAX_SUCCESSFUL_HISTORY_LOADS = 128
const MAX_SEEN_HISTORY_IDENTITIES = 128
const MAX_EARLY_HISTORY_READY = 16
const DEFAULT_HISTORY_READY_TIMEOUT_MS = 30_000
const HTTP_HISTORY_SUCCESS_MIN = 200
const HTTP_HISTORY_SUCCESS_LIMIT = 400

type TargetOwner = Pick<ChromiumTargets,
  'onTarget' | 'listTargets' | 'discover' | 'create' | 'activate' | 'deactivate' | 'navigate' |
  'navigationState' | 'goBack' | 'goForward' | 'reload' | 'closeTarget' | 'close' | 'abort'>
type InspectorOwner = Pick<ChromiumInspectorHost, 'open' | 'close' | 'targetDestroyed'>

interface NavigationAttempt {
  requestedUrl: string
  receipt: ChromiumNavigationReceipt | null
  earlyEvents: ChromiumTargetEvent[]
  timer: ReturnType<typeof setTimeout>
  rejectTimeout(error: Error): void
}

interface TabEntry {
  tabId: string
  info: ChromiumTargetInfo
  committedInfo: ChromiumTargetInfo
  navigationError: BrowserTabSnapshot['navigationError']
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  devtoolsOpen: boolean
  revision: number
  historyVisitSequence: number
  historyVisitUrl: string | null
  historyTitle: string
  lastCommitIdentity: string | null
  lastCommitUrl: string | null
  lastCommitEpoch?: number
  pendingHistoryCommit: { identity: string; info: ChromiumTargetInfo } | null
  historyResponses: Map<string, { url: string; status: number }>
  successfulHistoryLoads: Set<string>
  historyNavigationIdentity: string | null
  historyNavigationUrl: string | null
  historyNavigationEpoch?: number
  historyReady: { identity: string; url: string; documentEpoch?: number; timer: ReturnType<typeof setTimeout> } | null
  earlyHistoryReady: Set<string>
  seenHistoryIdentities: Set<string>
  navigationAttempt?: NavigationAttempt
}

export interface ChromiumHistoryEvent {
  kind: 'visit' | 'title' | 'closed'
  tabId: string
  visitSequence: number
  url: string
  title: string
}

export interface ChromiumBrowserRegistry {
  initialize(): Promise<void>
  snapshot(): BrowserSnapshot
  dispatch(command: BrowserPageCommand): Promise<BrowserSnapshot>
  target(tabId: string): string
  active(): { tabId: string; targetId: string } | null
  onHistoryEvent(listener: (event: ChromiumHistoryEvent) => void): () => void
  dispose(): Promise<void>
}

export function createChromiumBrowserRegistry(targets: TargetOwner, inspector: InspectorOwner,
  onSnapshot: (snapshot: BrowserSnapshot) => void = () => undefined,
  options: { navigationTimeoutMs?: number; historyReadyTimeoutMs?: number } = {}): ChromiumBrowserRegistry {
  const navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS
  const historyReadyTimeoutMs = options.historyReadyTimeoutMs ?? DEFAULT_HISTORY_READY_TIMEOUT_MS
  if (!Number.isSafeInteger(navigationTimeoutMs) || navigationTimeoutMs <= 0 || navigationTimeoutMs > MAX_NAVIGATION_TIMEOUT_MS) {
    throw new Error('Invalid sidecar navigation timeout')
  }
  if (!Number.isSafeInteger(historyReadyTimeoutMs) || historyReadyTimeoutMs <= 0 || historyReadyTimeoutMs > MAX_NAVIGATION_TIMEOUT_MS) {
    throw new Error('Invalid sidecar history readiness timeout')
  }
  const byTarget = new Map<string, TabEntry>()
  const byTab = new Map<string, TabEntry>()
  const historyListeners = new Set<(event: ChromiumHistoryEvent) => void>()
  let activeTabId: string | null = null
  let unsubscribe: (() => void) | null = null
  let initialized = false
  let closed = false
  let transition = Promise.resolve()
  const readinessKey = (identity: string, documentEpoch?: number): string => JSON.stringify([identity, documentEpoch ?? null])

  const snapshot = (): BrowserSnapshot => ({
    engine: 'chromium-sidecar',
    activeTabId,
    automation: { enabled: false, port: null },
    tabs: [...byTarget.values()].map(entry => ({
      tabId: entry.tabId, url: entry.info.url || BLANK_PAGE, title: entry.info.title,
      loading: entry.loading, canGoBack: entry.canGoBack, canGoForward: entry.canGoForward,
      navigationError: entry.navigationError, devtoolsOpen: entry.devtoolsOpen,
      cdpStatus: BROWSER_CDP_STATUS.disabled
    }))
  })
  const publish = (): void => { onSnapshot(snapshot()) }
  const emitHistory = (event: ChromiumHistoryEvent): void => {
    if (closed) return
    for (const listener of historyListeners) {
      try { listener(event) } catch (error) {
        console.error('[browser-sidecar] history persistence failed', error)
        void failClosed(error, true).catch(cleanupError => {
          if (cleanupError !== error) console.error('[browser-sidecar] history persistence shutdown failed', cleanupError)
        })
        return
      }
    }
  }
  const updateHistoryTitle = (entry: TabEntry, info: ChromiumTargetInfo): void => {
    if (entry.pendingHistoryCommit?.info.url === info.url) {
      entry.pendingHistoryCommit.info = { ...entry.pendingHistoryCommit.info, title: info.title }
    }
    if (entry.loading || entry.historyVisitUrl !== info.url || entry.historyTitle === info.title) return
    entry.historyTitle = info.title
    emitHistory({ kind: 'title', tabId: entry.tabId, visitSequence: entry.historyVisitSequence,
      url: info.url, title: info.title })
  }
  const emitVisit = (entry: TabEntry, info: ChromiumTargetInfo): void => {
    if (!/^https?:\/\//.test(info.url)) {
      entry.historyVisitUrl = null
      return
    }
    entry.historyVisitSequence++
    entry.historyVisitUrl = info.url
    entry.historyTitle = info.title
    emitHistory({ kind: 'visit', tabId: entry.tabId, visitSequence: entry.historyVisitSequence,
      url: info.url, title: info.title })
  }
  const settleHistoryResponse = (entry: TabEntry): void => {
    const commit = entry.pendingHistoryCommit
    if (!commit) return
    const response = entry.historyResponses.get(commit.identity)
    if (!response || response.url !== commit.info.url.split('#', 1)[0]) return
    entry.pendingHistoryCommit = null
    entry.historyResponses.delete(commit.identity)
    if (response.status >= HTTP_HISTORY_SUCCESS_MIN && response.status < HTTP_HISTORY_SUCCESS_LIMIT) {
      entry.successfulHistoryLoads.delete(commit.identity)
      entry.successfulHistoryLoads.add(commit.identity)
      if (entry.successfulHistoryLoads.size > MAX_SUCCESSFUL_HISTORY_LOADS) {
        entry.successfulHistoryLoads.delete(entry.successfulHistoryLoads.values().next().value!)
      }
      emitVisit(entry, commit.info)
    }
  }
  const recordVisit = (entry: TabEntry, event: ChromiumTargetEvent): void => {
    if (!event.frameId) return
    if (event.kind === 'same-document') {
      entry.pendingHistoryCommit = null
      emitVisit(entry, event.info)
    } else if (event.kind === 'navigated' && event.loaderId) {
      const identity = `loader:${event.frameId}:${event.loaderId}`
      if (event.navigationType === 'BackForwardCacheRestore') {
        entry.lastCommitIdentity = identity
        entry.lastCommitUrl = event.info.url
        entry.lastCommitEpoch = event.documentEpoch
        entry.pendingHistoryCommit = null
        if (entry.successfulHistoryLoads.has(identity)) {
          emitVisit(entry, event.info)
        } else entry.historyVisitUrl = null
        return
      }
      if (entry.lastCommitIdentity === identity && entry.lastCommitUrl === event.info.url &&
        entry.lastCommitEpoch === event.documentEpoch) {
        updateHistoryTitle(entry, event.info)
        return
      }
      if (entry.lastCommitIdentity === identity) entry.successfulHistoryLoads.delete(identity)
      entry.lastCommitIdentity = identity
      entry.lastCommitUrl = event.info.url
      entry.lastCommitEpoch = event.documentEpoch
      entry.historyVisitUrl = null
      entry.pendingHistoryCommit = { identity, info: event.info }
      settleHistoryResponse(entry)
    }
  }
  const queue = <T>(action: () => Promise<T>): Promise<T> => {
    const result = transition.then(action)
    transition = result.then(() => undefined, () => undefined)
    return result
  }
  const entryFor = (tabId: string): TabEntry => {
    const entry = byTab.get(tabId)
    if (!entry || closed) throw new Error(BROWSER_ERROR.targetClosed)
    return entry
  }
  const cancelAttempt = (entry: TabEntry, error: Error): void => {
    const attempt = entry.navigationAttempt
    if (!attempt) return
    clearTimeout(attempt.timer)
    entry.navigationAttempt = undefined
    attempt.rejectTimeout(error)
  }
  const cancelHistoryReady = (entry: TabEntry): void => {
    if (entry.historyReady) clearTimeout(entry.historyReady.timer)
    entry.historyReady = null
  }
  const refreshAfterCommit = (entry: TabEntry, event: ChromiumTargetEvent): void => {
    if (event.kind === 'same-document') {
      if (!entry.historyReady) void refreshNavigation(entry)
      return
    }
    if (!event.frameId || !event.loaderId) {
      const error = new Error('Chromium main-frame commit has no history identity')
      void failClosed(error, true).catch(cleanupError => {
        if (cleanupError !== error) console.error('[browser-sidecar] history identity shutdown failed', cleanupError)
      })
      return
    }
    const identity = `loader:${event.frameId}:${event.loaderId}`
    const restored = event.navigationType === 'BackForwardCacheRestore'
    if (entry.historyNavigationIdentity === identity && entry.historyNavigationUrl === event.info.url &&
      entry.historyNavigationEpoch === event.documentEpoch && !restored) return
    const key = readinessKey(identity, event.documentEpoch)
    const previouslySeen = entry.seenHistoryIdentities.has(key)
    entry.seenHistoryIdentities.delete(key)
    entry.seenHistoryIdentities.add(key)
    if (entry.seenHistoryIdentities.size > MAX_SEEN_HISTORY_IDENTITIES) {
      entry.seenHistoryIdentities.delete(entry.seenHistoryIdentities.values().next().value!)
    }
    entry.historyNavigationIdentity = identity
    entry.historyNavigationUrl = event.info.url
    entry.historyNavigationEpoch = event.documentEpoch
    cancelHistoryReady(entry)
    entry.revision++
    entry.canGoBack = false
    entry.canGoForward = false
    publish()
    if (restored) {
      entry.earlyHistoryReady.delete(key)
      void refreshNavigation(entry, true).catch(error => {
        if (error instanceof AggregateError) console.error('[browser-sidecar] BFCache history shutdown failed', error)
      })
      return
    }
    const earlyReady = entry.earlyHistoryReady.has(key)
    entry.earlyHistoryReady.delete(key)
    if (!previouslySeen && earlyReady) {
      void refreshNavigation(entry, true)
      return
    }
    const revision = entry.revision
    const timer = setTimeout(() => {
      if (closed || byTarget.get(entry.info.targetId) !== entry || entry.historyReady?.identity !== identity ||
        entry.historyReady.url !== event.info.url || entry.revision !== revision) return
      cancelHistoryReady(entry)
      const error = new Error('Chromium main-frame history readiness timed out')
      void failClosed(error, true).catch(cleanupError => {
        if (cleanupError !== error) console.error('[browser-sidecar] history readiness shutdown failed', cleanupError)
      })
    }, historyReadyTimeoutMs)
    timer.unref?.()
    entry.historyReady = { identity, url: event.info.url, documentEpoch: event.documentEpoch, timer }
  }
  const matchesNavigation = (attempt: NavigationAttempt, event: ChromiumTargetEvent): boolean => {
    const receipt = attempt.receipt
    if (!receipt || event.frameId !== receipt.frameId) return false
    return receipt.loaderId
      ? event.kind === 'navigated' && event.loaderId === receipt.loaderId
      : event.kind === 'same-document' && event.info.url === attempt.requestedUrl
  }
  const commitNavigation = (entry: TabEntry, event: ChromiumTargetEvent): void => {
    const attempt = entry.navigationAttempt
    if (!attempt || !matchesNavigation(attempt, event)) return
    clearTimeout(attempt.timer)
    entry.navigationAttempt = undefined
    entry.info = { ...event.info }
    entry.committedInfo = { ...event.info }
    entry.loading = false
    entry.navigationError = null
    publish()
    recordVisit(entry, event)
    refreshAfterCommit(entry, event)
  }
  const refreshNavigation = async (entry: TabEntry, failOnError = false): Promise<void> => {
    if (closed || entry.loading || entry.historyReady || activeTabId !== entry.tabId || byTarget.get(entry.info.targetId) !== entry) return
    const revision = ++entry.revision
    try {
      const state = await targets.navigationState(entry.info.targetId)
      if (closed || entry.loading || entry.historyReady || activeTabId !== entry.tabId || byTarget.get(entry.info.targetId) !== entry || entry.revision !== revision) return
      entry.canGoBack = state.canGoBack
      entry.canGoForward = state.canGoForward
      publish()
    } catch (error) {
      if (closed || activeTabId !== entry.tabId || byTarget.get(entry.info.targetId) !== entry || entry.revision !== revision) return
      if (failOnError) await failClosed(error, true)
      else console.error('[browser-sidecar] navigation state failed', error)
    }
  }
  const activate = async (tabId: string): Promise<void> => {
    const entry = entryFor(tabId)
    const previous = activeTabId ? byTab.get(activeTabId) : undefined
    if (previous === entry) return
    activeTabId = null
    publish()
    try {
      if (previous) await targets.deactivate(previous.info.targetId)
      if (closed || byTab.get(tabId) !== entry) throw new Error(BROWSER_ERROR.targetClosed)
      await targets.activate(entry.info.targetId)
      if (closed || byTab.get(tabId) !== entry) throw new Error(BROWSER_ERROR.targetClosed)
      activeTabId = tabId
      publish()
      await refreshNavigation(entry)
    } catch (error) {
      if (closed) throw error
      await failClosed(error)
    }
  }
  const register = (info: ChromiumTargetInfo, committed = false): TabEntry => {
    const existing = byTarget.get(info.targetId)
    if (existing) {
      if (committed) {
        existing.info = { ...info }
        existing.committedInfo = { ...info }
        existing.loading = false
        publish()
      } else if (!existing.loading && info.url === existing.committedInfo.url) {
        existing.info = { ...existing.info, title: info.title }
        existing.committedInfo = { ...existing.committedInfo, title: info.title }
        publish()
      }
      return existing
    }
    const entry: TabEntry = { tabId: randomUUID(), info: { ...info }, committedInfo: { ...info }, navigationError: null, loading: false,
      canGoBack: false, canGoForward: false, devtoolsOpen: false, revision: 0,
      historyVisitSequence: 0, historyVisitUrl: null, historyTitle: '', lastCommitIdentity: null,
      lastCommitUrl: null,
      pendingHistoryCommit: null, historyResponses: new Map(), successfulHistoryLoads: new Set(),
      historyNavigationIdentity: null, historyNavigationUrl: null,
      historyReady: null, earlyHistoryReady: new Set(), seenHistoryIdentities: new Set() }
    byTarget.set(info.targetId, entry)
    byTab.set(entry.tabId, entry)
    publish()
    if (!activeTabId) void queue(async () => {
      if (!closed && !activeTabId && byTab.get(entry.tabId) === entry) await activate(entry.tabId)
    }).catch(error => console.error('[browser-sidecar] initial target activation failed', error))
    return entry
  }
  const destroyed = (targetId: string): void => {
    const entry = byTarget.get(targetId)
    if (!entry) return
    cancelAttempt(entry, new Error(BROWSER_ERROR.targetClosed))
    cancelHistoryReady(entry)
    byTarget.delete(targetId)
    byTab.delete(entry.tabId)
    entry.revision++
    if (activeTabId === entry.tabId) activeTabId = null
    emitHistory({ kind: 'closed', tabId: entry.tabId, visitSequence: entry.historyVisitSequence,
      url: entry.historyVisitUrl ?? entry.info.url, title: entry.historyTitle })
    publish()
    void inspector.targetDestroyed(targetId).catch(error => console.error('[browser-sidecar] DevTools cleanup failed', error))
    if (!activeTabId) {
      const next = byTarget.values().next().value as TabEntry | undefined
      if (next) void queue(async () => {
        if (!closed && !activeTabId && byTab.get(next.tabId) === next) await activate(next.tabId)
      }).catch(error => console.error('[browser-sidecar] fallback target activation failed', error))
    }
  }
  const onTarget = (event: ChromiumTargetEvent): void => {
    if (closed) return
    if (event.kind === 'destroyed' || event.kind === 'detached') destroyed(event.info.targetId)
    else if (event.kind === 'response') {
      const entry = byTarget.get(event.info.targetId)
      if (!entry || !event.frameId || !event.loaderId || !Number.isInteger(event.status)) return
      const identity = `loader:${event.frameId}:${event.loaderId}`
      entry.historyResponses.delete(identity)
      entry.historyResponses.set(identity, { url: event.info.url, status: event.status! })
      if (entry.historyResponses.size > MAX_PENDING_HISTORY_RESPONSES) {
        entry.historyResponses.delete(entry.historyResponses.keys().next().value!)
      }
      settleHistoryResponse(entry)
    } else if (event.kind === 'ready') {
      const entry = byTarget.get(event.info.targetId)
      if (!entry || !event.frameId || !event.loaderId) return
      const identity = `loader:${event.frameId}:${event.loaderId}`
      const key = readinessKey(identity, event.documentEpoch)
      if (entry.historyReady?.identity === identity && entry.historyReady.url === event.info.url &&
        entry.historyReady.documentEpoch === event.documentEpoch) {
        cancelHistoryReady(entry)
        void refreshNavigation(entry, true).catch(error => {
          if (error instanceof AggregateError) console.error('[browser-sidecar] history readiness shutdown failed', error)
        })
      } else if (event.documentEpoch !== undefined && !entry.seenHistoryIdentities.has(key)) {
        entry.earlyHistoryReady.add(key)
        if (entry.earlyHistoryReady.size > MAX_EARLY_HISTORY_READY) {
          entry.earlyHistoryReady.delete(entry.earlyHistoryReady.values().next().value!)
        }
      }
    } else if (event.kind === 'navigated' || event.kind === 'same-document') {
      const entry = byTarget.get(event.info.targetId)
      if (!entry) {
        const registered = register(event.info, true)
        recordVisit(registered, event)
        refreshAfterCommit(registered, event)
        return
      }
      const attempt = entry.navigationAttempt
      if (!attempt) {
        recordVisit(register(event.info, true), event)
        refreshAfterCommit(entry, event)
      }
      else if (!attempt.receipt) {
        if (attempt.earlyEvents.length >= MAX_EARLY_NAVIGATION_EVENTS) attempt.earlyEvents.shift()
        attempt.earlyEvents.push(event)
      } else commitNavigation(entry, event)
    } else {
      const entry = register(event.info)
      if (event.kind === 'updated') updateHistoryTitle(entry, event.info)
    }
  }
  const failClosed = async (reason: unknown, abort = false): Promise<never> => {
    closed = true
    unsubscribe?.()
    unsubscribe = null
    historyListeners.clear()
    for (const entry of byTarget.values()) {
      cancelAttempt(entry, new Error(BROWSER_ERROR.targetClosed))
      cancelHistoryReady(entry)
    }
    byTarget.clear()
    byTab.clear()
    activeTabId = null
    publish()
    try { if (abort) await targets.abort(reason); else await targets.close() }
    catch (cleanupError) { throw new AggregateError([reason, cleanupError], 'Sidecar target close and shutdown failed') }
    throw reason
  }
  const dispatch = (command: BrowserPageCommand): Promise<BrowserSnapshot> => queue(async () => {
    if (!initialized || closed) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
    if (command.kind === 'open') {
      const targetId = await targets.create()
      const info = targets.listTargets().find(candidate => candidate.targetId === targetId)
      const entry = byTarget.get(targetId) ?? (info ? register(info) : null)
      if (!entry) return failClosed(new Error('Created Chromium target is not registered'))
      await activate(entry.tabId)
      if (command.input) await navigate(entry, command.input)
    } else if (command.kind === 'select') await activate(command.tabId)
    else if (command.kind === 'close') {
      const entry = entryFor(command.tabId)
      try { await targets.closeTarget(entry.info.targetId) }
      catch (error) {
        if (byTarget.get(entry.info.targetId) === entry) return failClosed(error)
      }
      if (!activeTabId) {
        const next = byTarget.values().next().value as TabEntry | undefined
        if (next) await activate(next.tabId)
      }
    } else if (command.kind === 'navigate') await navigate(entryFor(command.tabId), command.input)
    else if (command.kind === 'back' || command.kind === 'forward' || command.kind === 'reload') {
      const entry = entryFor(command.tabId)
      if (activeTabId !== entry.tabId) await activate(entry.tabId)
      if (command.kind === 'back') await targets.goBack(entry.info.targetId)
      else if (command.kind === 'forward') await targets.goForward(entry.info.targetId)
      else await targets.reload(entry.info.targetId)
    } else if (command.kind === 'devtools') {
      const entry = entryFor(command.tabId)
      if (command.open) await inspector.open(entry.info.targetId)
      else await inspector.close(entry.info.targetId)
      if (closed || byTarget.get(entry.info.targetId) !== entry) throw new Error(BROWSER_ERROR.targetClosed)
      entry.devtoolsOpen = command.open
      publish()
    } else if (command.kind !== 'bounds') throw new Error(BROWSER_ERROR.invalidCommand)
    return snapshot()
  })
  const navigate = async (entry: TabEntry, input: string): Promise<void> => {
    const url = normalizeBrowserInput(input).href
    cancelAttempt(entry, new Error(BROWSER_ERROR.navigationFailed))
    cancelHistoryReady(entry)
    entry.earlyHistoryReady.clear()
    let rejectTimeout: (error: Error) => void = () => undefined
    const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject })
    const attempt: NavigationAttempt = { requestedUrl: url, receipt: null, earlyEvents: [],
      timer: setTimeout(() => {
        if (closed || byTarget.get(entry.info.targetId) !== entry || entry.navigationAttempt !== attempt) return
        entry.navigationAttempt = undefined
        const error = new Error(BROWSER_ERROR.navigationFailed)
        void failClosed(error, true).catch(cleanupError => {
          if (cleanupError !== error) console.error('[browser-sidecar] navigation timeout shutdown failed', cleanupError)
        })
        rejectTimeout(error)
      }, navigationTimeoutMs), rejectTimeout }
    attempt.timer.unref?.()
    entry.navigationAttempt = attempt
    entry.navigationError = null
    entry.info = { ...entry.info, url }
    entry.loading = true
    entry.revision++
    entry.canGoBack = false
    entry.canGoForward = false
    publish()
    try {
      const receipt = await Promise.race([targets.navigate(entry.info.targetId, url), deadline])
      if (closed || byTarget.get(entry.info.targetId) !== entry || entry.navigationAttempt !== attempt) throw new Error(BROWSER_ERROR.targetClosed)
      attempt.receipt = receipt
      const earlyCommit = attempt.earlyEvents.find(event => matchesNavigation(attempt, event))
      if (earlyCommit) commitNavigation(entry, earlyCommit)
    }
    catch (error) {
      if (closed || byTarget.get(entry.info.targetId) !== entry || entry.navigationAttempt !== attempt) throw error
      clearTimeout(attempt.timer)
      entry.navigationAttempt = undefined
      await failClosed(error, true)
    }
    if (closed || byTarget.get(entry.info.targetId) !== entry) throw new Error(BROWSER_ERROR.targetClosed)
  }

  return {
    async initialize() {
      if (initialized || closed) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
      unsubscribe = targets.onTarget(onTarget)
      try {
        await targets.discover()
        if (closed) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
        for (const info of targets.listTargets()) register(info)
        initialized = true
      } catch (error) { if (closed) throw error; await failClosed(error) }
    },
    snapshot,
    dispatch,
    target: tabId => entryFor(tabId).info.targetId,
    active: () => {
      const entry = activeTabId ? byTab.get(activeTabId) : undefined
      return entry ? { tabId: entry.tabId, targetId: entry.info.targetId } : null
    },
    onHistoryEvent(listener) {
      if (closed) throw new Error(BROWSER_ERROR.targetClosed)
      historyListeners.add(listener)
      return () => { historyListeners.delete(listener) }
    },
    async dispose() {
      if (closed) return
      closed = true
      unsubscribe?.()
      unsubscribe = null
      historyListeners.clear()
      for (const entry of byTarget.values()) {
        cancelAttempt(entry, new Error(BROWSER_ERROR.targetClosed))
        cancelHistoryReady(entry)
      }
      await transition
      byTarget.clear()
      byTab.clear()
      activeTabId = null
      publish()
      await targets.close()
    }
  }
}
