import { createHash, randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, session, shell, WebContentsView } from 'electron'
import type { Rectangle, Session, WebContents } from 'electron'

import {
  BROWSER_CDP_STATUS,
  BROWSER_ERROR,
  parseBrowserDataRequest,
  parsePageRequest,
  samePageTarget,
} from '../browser.ts'
import type {
  BrowserAgentContinuity,
  BrowserPageTarget,
  FindQuery,
  FindState,
  PageRequest,
  PageReply,
} from '../browser.ts'
import { createPageActions, pageFindShortcut } from './page.ts'
import type { PageActions } from './page.ts'
import type {
  BrowserDataRequest,
  BrowserDataType,
  BrowserDownloadSettings,
  BrowserHistoryPage,
  BrowserHistoryQuery,
  BrowserPageCommand,
  BrowserSnapshot,
  BrowserTabSnapshot,
} from '../browser.ts'
import type { MenuTarget } from '../menu.ts'
import {
  createBrowserHistory,
  createHistoryAgentAuthority,
  type HistoryAgentAuthority,
} from './history.ts'
import {
  DOWNLOAD_STAGE_PREFIX,
  canPublishDownload,
  createDownloadPreferences,
  createDownloadStage,
  discardDownloadStage,
  downloadSourceAllowed,
  findPendingDownloadStages,
  publishDownload,
  safeDownloadName,
} from './downloads.ts'
import type { DownloadStage } from './downloads.ts'
import { mainLocalization } from './localization.ts'
import { desktopHome } from './storage.ts'
import { browserResourceAllowed, normalizeBrowserInput } from './navigation.ts'
import { BROWSER_PROXY_ERROR_HEADER, createBrowserNetwork } from './network.ts'
import type { BrowserNetwork } from './network.ts'
import { createSearchFormExecutor } from './searchform.ts'
import type { PreparedSearchForm, SearchFormConfig } from './searchform.ts'

const EMPTY_BOUNDS: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
const DEBUGGER_VERSION = '1.3'
const BLANK_PAGE = 'about:blank'
const LOOPBACK = '127.0.0.1'
const PROXY_BYPASS_RULES = '<-loopback>'
const owners = new WeakSet<Electron.Session>()
const LOCAL_PARTITION_PREFIX = 'scholarseed-browser-local:'
const DEVTOOLS_DETACH_REASON = 'replaced_with_devtools'
const DEVTOOLS_RESOURCE_PREFIX = 'devtools://devtools/bundled/'
const DEVTOOLS_WINDOW_SIZE = { width: 1000, height: 700 }
const WINDOW_LAYOUT_EVENTS = [
  'hide',
  'show',
  'resize',
  'minimize',
  'restore',
  'enter-full-screen',
  'leave-full-screen',
] as const
const HISTORY_DIRECTORY = 'browser'
const BROWSER_PARTITION_PREFIX = 'persist:scholarseed-browser-'
const SITE_DATA_TYPES: NonNullable<Electron.ClearDataOptions['dataTypes']> = [
  'backgroundFetch',
  'cache',
  'cookies',
  'fileSystems',
  'indexedDB',
  'localStorage',
  'serviceWorkers',
  'webSQL',
]
const SELECTED_DATA_TYPES: Record<
  Exclude<BrowserDataType, 'history'>,
  NonNullable<Electron.ClearDataOptions['dataTypes']>
> = {
  cookies: ['cookies'],
  storage: [
    'backgroundFetch',
    'fileSystems',
    'indexedDB',
    'localStorage',
    'serviceWorkers',
    'webSQL',
  ],
  cache: ['cache'],
}
const HTTP_SUCCESS_MIN = 200
const HTTP_SUCCESS_LIMIT = 400
const NAVIGATION_ABORTED_ERROR = -3
const NAVIGATION_ABORTED_MESSAGE = 'ERR_ABORTED'
const NAVIGATION_FAILED_MESSAGE = 'ERR_FAILED'
const AGENT_NAVIGATION_NOT_ISSUED = 'navigation_cancelled_before_dispatch'
const AGENT_NAVIGATION_OUTCOME_UNKNOWN = 'navigation_outcome_unknown'
const DOWNLOAD_HANDOFF_TIMEOUT_MS = 1000
const MAX_ACTIVE_POPUPS = 8
const SEARCH_REQUEST_METHODS = new Set(['GET', 'HEAD'])
const SEARCH_REDIRECT_TTL_MS = 15_000
const SEARCH_DISABLED_BLINK_FEATURES = 'AutomationControlled'
const SEARCH_VIEWPORT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1280, height: 720 }

interface BrowserContext {
  session: Session
  origin: string | null
  agentIsolated: boolean
  searchOnly: boolean
  network: Promise<BrowserNetwork>
  ready: Promise<void>
  close(): Promise<void>
}

interface BrowserEntry {
  page: PageActions
  tabId: string
  agentInstanceId: string
  menuNavigationId: number
  view: WebContentsView
  context: BrowserContext
  bounds: Rectangle
  visible: boolean
  error: BrowserTabSnapshot['navigationError']
  cdpStatus: BrowserTabSnapshot['cdpStatus']
  devtoolsOpening: boolean
  devtoolsWindow: BrowserWindow | null
  proxyError: BrowserTabSnapshot['navigationError']
  latestVisitId: string | null
  historyNavigationEpoch: number
  historyNavigationPending: boolean
  lastResponseCode: number | null
  downloadNavigation: { url: string; complete: (allowed: boolean) => void } | null
  downloadHandoffUrls: Set<string>
  navigationSerial: number
  agentGeneration: number
  agentNavigationOrigin: string | null
  agentNavigationCancelled: boolean
  agentIssuedLoad: boolean
  agentNavigationStartSeen: boolean
  agentNavigationUrls: Set<string>
  agentDetachPending: boolean
  navigationController: AbortController | null
  agentPopupBlocks: Set<symbol>
  searchForm: ReturnType<typeof createSearchFormExecutor> | null
}

interface SearchNavigationAttempt {
  source: BrowserEntry
  navigationSerial: number
  generation: number
  requestedUrl: string
}

interface SearchRedirectRecord {
  attempt: SearchNavigationAttempt
  url: string
  expiresAt: number
  clearEpoch: number
  profileEpoch: number
  settled: boolean
}

export type AgentTargetInvalidation = 'target' | 'external'
export type AgentTargetInvalidationReason = 'navigation' | 'authority'

function loadUntilCommit(
  contents: WebContents,
  url: string,
  interrupted: () => boolean = () => false,
  signal?: AbortSignal,
  onIssued?: (load: Promise<void>) => void
): Promise<void> {
  return new Promise((resolveLoad, rejectLoad) => {
    let settled = false
    const destinations = new Set([url])
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      contents.removeListener('will-redirect', redirected)
      contents.removeListener('dom-ready', committed)
      signal?.removeEventListener('abort', cancelled)
      if (error) rejectLoad(error)
      else resolveLoad()
    }
    const redirected = (_event: Electron.Event, destination: string) => {
      destinations.add(destination)
    }
    const committed = () => {
      if (destinations.has(contents.getURL())) finish()
    }
    const cancelled = () => finish(new Error(BROWSER_ERROR.targetClosed))
    if (signal?.aborted) {
      cancelled()
      return
    }
    signal?.addEventListener('abort', cancelled, { once: true })
    contents.on('will-redirect', redirected)
    contents.on('dom-ready', committed)
    let load: Promise<void>
    try {
      load = contents.loadURL(url)
    } catch (error) {
      load = Promise.reject(error)
    }
    onIssued?.(load)
    void load.then(
      () => {
        if (destinations.has(contents.getURL()) || interrupted()) finish()
      },
      (error) => finish(error)
    )
  })
}

async function awaitNavigationIdle(contents: WebContents): Promise<void> {
  if (contents.isDestroyed() || !contents.isLoadingMainFrame()) return
  await new Promise<void>((resolve) => {
    const finish = () => {
      contents.removeListener('did-stop-loading', stopped)
      contents.removeListener('destroyed', finish)
      resolve()
    }
    const stopped = () => {
      if (contents.isDestroyed() || !contents.isLoadingMainFrame()) finish()
    }
    contents.on('did-stop-loading', stopped)
    contents.on('destroyed', finish)
    stopped()
  })
}

export interface BrowserRegistry {
  createSearchTarget(): Promise<{ tabId: string; close(): void }>
  takeSearchRedirect(tabId: string): Readonly<{ requestedUrl: string; url: string }> | null
  prepareSearchForm(
    tabId: string,
    config: SearchFormConfig,
    query: string,
    signal: AbortSignal
  ): Promise<PreparedSearchForm>
  executeSearchForm(prepared: PreparedSearchForm, validate: () => boolean): Promise<void>
  createAgentTarget(sessionId: string): Promise<{ tabId: string; close(): void }>
  closeAgentTarget(sessionId: string, tabId: string): void
  page(request: PageRequest): Promise<PageReply>
  find(target: BrowserPageTarget, query: FindQuery, publish: (state: FindState) => void): void
  stopFind(target: BrowserPageTarget): void
  focusPage(target: BrowserPageTarget): void
  snapshot(): BrowserSnapshot
  dispatch(command: BrowserPageCommand): Promise<BrowserSnapshot>
  target(tabId: string): WebContents
  menuTarget(tabId: string): Extract<MenuTarget, { kind: 'browser' }>
  nativeVisible(): boolean
  externalTabIds(): string[]
  externalTarget(tabId: string): WebContents
  agentTarget(tabId: string): {
    contents: WebContents
    origin: string
    generation: number
    instanceId: string
    title: string
    url: string
  }
  agentNavigationTarget(tabId: string): {
    contents: WebContents
    origin: string | null
    generation: number
    instanceId: string
    title: string
    url: string
  }
  agentNavigate(tabId: string, input: string, approvedOrigin: string): Promise<void>
  blockAgentPopups(tabId: string): () => void
  cancelAgentNavigation(tabId: string): void
  navigate(tabId: string, input: string): Promise<void>
  attach(tabId: string): WebContents
  attachExternal(tabId: string): WebContents
  detach(tabId: string): void
  detachAgent(tabId: string): void
  onDebuggerDetach(
    listener: (tabId: string, reason: string, continuity?: BrowserAgentContinuity) => void
  ): () => void
  onAgentTargetInvalidated(
    listener: (
      tabId: string,
      kind: AgentTargetInvalidation,
      reason: AgentTargetInvalidationReason
    ) => void
  ): () => void
  setApiBase(apiBase: string): Promise<void>
  queryHistory(query: BrowserHistoryQuery): BrowserHistoryPage
  historyAgent: HistoryAgentAuthority
  deleteHistory(id: string): Promise<boolean>
  reopenHistory(id: string): Promise<BrowserSnapshot>
  clearData(request: BrowserDataRequest, stopAutomation?: () => Promise<void>): Promise<number>
  downloadSettings(): BrowserDownloadSettings
  chooseDownloadDirectory(): Promise<BrowserDownloadSettings>
  resetDownloadDirectory(): BrowserDownloadSettings
  setAskEveryTime(enabled: boolean): BrowserDownloadSettings
  dispose(): Promise<void>
}

interface BrowserOptions {
  onFind?(target: BrowserPageTarget): void
  onPageFocus?(): void
  onVisibilityChanged?(): void
  apiBase: string
  python?: string | null
  publish(snapshot: BrowserSnapshot): void
  log(message: string): void
  historyAgentUseRevision?(): number | null
}

function originOf(input: string): string | null {
  try {
    return new URL(input).origin
  } catch {
    return null
  }
}

export function createBrowserRegistry(
  window: BrowserWindow,
  options: BrowserOptions
): BrowserRegistry {
  const windowEvents: EventEmitter = window
  const logSearch = (
    category: 'form' | 'navigation' | 'render',
    details: Record<string, string | number | boolean | null | undefined>
  ): void => {
    try {
      options.log(`[browser-search-${category}] ${JSON.stringify(details)}`)
    } catch {}
  }
  const browserHome = join(desktopHome(), HISTORY_DIRECTORY)
  mkdirSync(browserHome, { recursive: true })
  const dataHome = realpathSync.native(resolve(desktopHome()))
  const profileId = createHash('sha256')
    .update(process.platform === 'win32' ? dataHome.toLowerCase() : dataHome)
    .digest('hex')
  const browserSession = session.fromPartition(`${BROWSER_PARTITION_PREFIX}${profileId}`)
  if (owners.has(browserSession)) throw new Error(BROWSER_ERROR.cdpBusy)
  const history = createBrowserHistory(browserHome)
  const historyAgent = createHistoryAgentAuthority(
    history,
    options.historyAgentUseRevision ?? (() => null)
  )
  const automaticAvailable = process.platform === 'darwin' && Boolean(options.python)
  const downloads = createDownloadPreferences(
    browserHome,
    app.getPath('downloads'),
    automaticAvailable,
    (directory) =>
      Boolean(options.python) && canPublishDownload(options.python!, browserHome, directory)
  )
  const pendingRecovery = findPendingDownloadStages(browserHome, (directory) =>
    options.log(
      `[browser-download] incomplete or unrecognized staging entry retained: ${directory}`
    )
  )
  if (
    process.platform !== 'darwin' &&
    readdirSync(browserHome).some((name) => name.startsWith(DOWNLOAD_STAGE_PREFIX))
  ) {
    options.log(
      '[browser-download] automatic staging recovery unavailable on this platform; existing stage directories remain untouched'
    )
  }
  let disposed = false
  const downloadItems = new Map<Electron.DownloadItem, Promise<void>>()
  const downloadPublications = new Set<Promise<void>>()
  const promptedStages = new Set<string>()
  let recoveryQueue = Promise.resolve()
  const recoverStage = async (stage: DownloadStage) => {
    if (disposed || window.isDestroyed()) return
    const translate = mainLocalization().getFixedT(null, 'native')
    const canPublish =
      process.platform === 'darwin' && Boolean(options.python) && !stage.publicationAttempted
    const choice = await dialog.showMessageBox(window, {
      type: 'warning',
      message: translate('browserDownload.recoveryTitle'),
      detail: translate(
        canPublish ? 'browserDownload.recoveryDetail' : 'browserDownload.manualRecoveryDetail',
        { path: stage.path }
      ),
      buttons: [
        translate(canPublish ? 'browserDownload.chooseFolder' : 'browserDownload.openFolder'),
        translate('browserDownload.delete'),
        translate('browserDownload.later'),
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (disposed || window.isDestroyed()) return
    if (choice.response === 1) {
      discardDownloadStage(stage, options.python!)
      return
    }
    if (choice.response !== 0) return
    if (!canPublish) {
      const error = await shell.openPath(stage.directory)
      if (error) options.log(`[browser-download] open recovery folder failed: ${error}`)
      return
    }
    const selected = await dialog.showOpenDialog(window, {
      title: translate('browserDownload.chooseFolder'),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (disposed || window.isDestroyed() || selected.canceled || !selected.filePaths[0]) return
    try {
      if (!canPublishDownload(options.python!, browserHome, selected.filePaths[0]))
        throw new Error('automatic_download_unavailable')
      await publishDownload(options.python!, stage.path, selected.filePaths[0], stage.filename)
    } catch (error) {
      options.log(`[browser-download] recovery publication failed: ${String(error)}`)
      if (!window.isDestroyed())
        await dialog.showMessageBox(window, {
          type: 'error',
          message: translate('browserDownload.recoveryFailed'),
          detail: translate('browserDownload.recoveryDetail', { path: stage.path }),
          buttons: [translate('browserDownload.later')],
        })
      return
    }
    discardDownloadStage(stage, options.python!)
  }
  const queueRecovery = (stage: DownloadStage) => {
    if (disposed || promptedStages.has(stage.directory)) return
    promptedStages.add(stage.directory)
    recoveryQueue = recoveryQueue
      .then(() => recoverStage(stage))
      .catch((error) => {
        options.log(
          `[browser-download] recovery dialog failed: ${String(error)}; staged file retained at ${stage.path}`
        )
      })
  }
  const onRecoveryShow = () => {
    for (const stage of pendingRecovery) queueRecovery(stage)
  }
  window.on('show', onRecoveryShow)
  if (window.isVisible()) onRecoveryShow()
  owners.add(browserSession)
  const entries = new Map<string, BrowserEntry>()
  const agentOwners = new Map<string, { sessionId: string; entry: BrowserEntry }>()
  const searchOwners = new Map<string, BrowserContext>()
  const searchNavigationRequests = new WeakMap<BrowserEntry, SearchNavigationAttempt>()
  const searchRedirects = new Map<string, SearchRedirectRecord>()
  const popupAdmissions = new Set<{ source: BrowserEntry; tabId: string | null }>()
  const stagingEntries = new Set<BrowserEntry>()
  const liveEntries = new Set<BrowserEntry>()
  const stageControllers = new Map<BrowserEntry, AbortController>()
  const detachListeners = new Set<
    (tabId: string, reason: string, continuity?: BrowserAgentContinuity) => void
  >()
  const invalidationListeners = new Set<
    (tabId: string, kind: AgentTargetInvalidation, reason: AgentTargetInvalidationReason) => void
  >()
  const cancelAgentLoad = (entry: BrowserEntry): void => {
    if (entry.agentNavigationOrigin === null || entry.agentNavigationCancelled) return
    entry.agentNavigationCancelled = true
    entry.navigationSerial += 1
    for (const staged of stagingEntries)
      if (staged.tabId === entry.tabId && staged.context.agentIsolated) {
        if (!staged.view.webContents.isDestroyed()) {
          try {
            staged.view.webContents.stop()
          } catch {}
        }
        stageControllers.get(staged)?.abort()
      }
    if (!entry.navigationController) entry.agentNavigationOrigin = null
    else if (!entry.view.webContents.isDestroyed()) {
      try {
        entry.view.webContents.stop()
      } catch {}
    }
    entry.navigationController?.abort()
  }
  const invalidateAgentTarget = (
    entry: BrowserEntry,
    kind: AgentTargetInvalidation = 'external',
    reason: AgentTargetInvalidationReason = 'authority'
  ): void => {
    if (kind === 'external') searchRedirects.delete(entry.tabId)
    if (entry.searchForm?.active() && (kind !== 'target' || reason !== 'navigation'))
      entry.searchForm.invalidate()
    if (kind === 'external') cancelAgentLoad(entry)
    entry.agentGeneration += 1
    for (const listener of invalidationListeners) listener(entry.tabId, kind, reason)
    if (entry.searchForm?.active() && kind === 'target' && reason === 'navigation')
      entry.searchForm.advance(entry.agentGeneration)
  }
  const pendingDisposals = new Set<Promise<void>>()
  const contexts = new Set<BrowserContext>()
  const agentSessionTombstones = new Set<Session>()
  let apiOrigin = originOf(options.apiBase)
  let activeTabId: string | null = null
  let printBusy = false
  let disposal: Promise<void> | null = null
  let clearing = false
  let clearingProfileOnly = false
  let clearEpoch = 0
  let profileClearEpoch = 0
  let historyClearEpoch = 0
  const blocksSessionClear = (context: BrowserContext): boolean =>
    clearing && (!clearingProfileOnly || context.session === browserSession)
  const staleAfterClear = (context: BrowserContext, epoch: number, profileEpoch: number): boolean =>
    blocksSessionClear(context) ||
    clearEpoch !== epoch ||
    (context.session === browserSession && profileClearEpoch !== profileEpoch)
  const currentSearchAttempt = (attempt: SearchNavigationAttempt): boolean => {
    const source = attempt.source
    return (
      !disposed &&
      !blocksSessionClear(source.context) &&
      source.context.searchOnly &&
      entries.get(source.tabId) === source &&
      searchOwners.get(source.tabId) === source.context &&
      !source.view.webContents.isDestroyed() &&
      !source.view.webContents.isCrashed() &&
      source.view.webContents.getURL() === BLANK_PAGE &&
      source.searchForm === null &&
      source.navigationSerial === attempt.navigationSerial &&
      source.agentGeneration === attempt.generation
    )
  }
  const entryFor = (tabId: string): BrowserEntry => {
    const entry = entries.get(tabId)
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error(BROWSER_ERROR.targetClosed)
    return entry
  }
  const externalEntryFor = (tabId: string): BrowserEntry => {
    const entry = entryFor(tabId)
    if (entry.context.agentIsolated) throw new Error(BROWSER_ERROR.permissionDenied)
    return entry
  }
  const attachEntry = (entry: BrowserEntry): WebContents => {
    const contents = entry.view.webContents
    if (entry.devtoolsWindow || entry.devtoolsOpening || contents.isDevToolsOpened())
      throw new Error(BROWSER_ERROR.devtoolsConflict)
    if (contents.debugger.isAttached()) throw new Error(BROWSER_ERROR.cdpBusy)
    contents.debugger.attach(DEBUGGER_VERSION)
    entry.cdpStatus = BROWSER_CDP_STATUS.connected
    publish()
    return contents
  }
  const snapshot = (): BrowserSnapshot => ({
    tabs: [...entries.values()].map((entry) => {
      const contents = entry.view.webContents
      return {
        tabId: entry.tabId,
        url: contents.getURL(),
        title: contents.getTitle(),
        loading: contents.isLoadingMainFrame(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        navigationError: entry.error,
        devtoolsOpen:
          entry.devtoolsWindow !== null || entry.devtoolsOpening || contents.isDevToolsOpened(),
        zoomFactor: entry.page.zoom(),
        cdpStatus: entry.cdpStatus,
      }
    }),
    activeTabId,
    automation: { enabled: false, port: null },
  })
  const publish = () => {
    if (!disposed) options.publish(snapshot())
  }
  const syncSearchRendering = (entry: BrowserEntry, phase: 'document-ready' | 'layout') => {
    if (!entry.context.searchOnly || entry.view.webContents.isDestroyed()) return
    const contents = entry.view.webContents
    contents.setBackgroundThrottling(false)
    const bounds = entry.view.getBounds()
    logSearch('render', {
      tabId: entry.tabId,
      phase,
      visible: entry.view.getVisible(),
      width: bounds.width,
      height: bounds.height,
      backgroundThrottling: contents.getBackgroundThrottling(),
    })
  }
  const layout = () => {
    if (window.isDestroyed()) return
    const windowBounds = window.getContentBounds()
    const zoom = window.webContents.getZoomFactor()
    for (const entry of entries.values()) {
      const visible =
        !entry.context.searchOnly &&
        entry.visible &&
        activeTabId === entry.tabId &&
        window.isVisible() &&
        !window.isMinimized()
      const bounds = {
        x: Math.max(0, Math.round(entry.bounds.x * zoom)),
        y: Math.max(0, Math.round(entry.bounds.y * zoom)),
        width: Math.max(0, Math.round(entry.bounds.width * zoom)),
        height: Math.max(0, Math.round(entry.bounds.height * zoom)),
      }
      bounds.width = Math.max(0, Math.min(bounds.width, windowBounds.width - bounds.x))
      bounds.height = Math.max(0, Math.min(bounds.height, windowBounds.height - bounds.y))
      entry.view.setBounds(
        entry.context.searchOnly ? SEARCH_VIEWPORT_BOUNDS : visible ? bounds : EMPTY_BOUNDS
      )
      entry.view.setVisible(visible)
      syncSearchRendering(entry, 'layout')
    }
    options.onVisibilityChanged?.()
  }
  const resourceAllowed = (
    entry: BrowserEntry,
    input: string,
    mainFrame: boolean,
    frameOrigin: string | null
  ): boolean => {
    let url: URL
    try {
      url = new URL(input)
    } catch {
      return false
    }
    if (url.protocol === 'ws:') url.protocol = 'http:'
    if (url.protocol === 'wss:') url.protocol = 'https:'
    if (entry.context.origin !== null) {
      return (
        url.origin === entry.context.origin &&
        entry.context.origin === apiOrigin &&
        (mainFrame || frameOrigin === apiOrigin) &&
        browserResourceAllowed({
          url,
          topOrigin: entry.context.origin,
          approvedLocalOrigin: entry.context.origin,
          apiOrigin,
        })
      )
    }
    if (url.origin === apiOrigin) return false
    return browserResourceAllowed({
      url,
      topOrigin: originOf(entry.view.webContents.getURL()) ?? '',
      approvedLocalOrigin: null,
      apiOrigin,
    })
  }
  const createContext = (
    localOrigin: string | null,
    agentIsolated = false,
    searchOnly = false
  ): BrowserContext => {
    const isolatedSession =
      localOrigin || agentIsolated
        ? session.fromPartition(`${LOCAL_PARTITION_PREFIX}${randomUUID()}`)
        : browserSession
    if (agentIsolated) agentSessionTombstones.add(isolatedSession)
    let boundary: BrowserNetwork | null = null
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false)
    )
    isolatedSession.setPermissionCheckHandler(() => false)
    isolatedSession.setDevicePermissionHandler(() => false)
    const handleDownload = (
      event: Electron.Event,
      item: Electron.DownloadItem,
      contents: WebContents
    ) => {
      const entry = [...entries.values(), ...stagingEntries].find(
        (value) => value.context.session === isolatedSession && value.view.webContents === contents
      )
      if (
        disposed ||
        !entry ||
        blocksSessionClear(entry.context) ||
        entry.view.webContents.isDestroyed()
      ) {
        event.preventDefault()
        return
      }
      const urls = [...item.getURLChain(), item.getURL()]
      if (agentIsolated || entry.agentNavigationOrigin !== null) {
        event.preventDefault()
        if (entry.downloadNavigation && urls.includes(entry.downloadNavigation.url))
          entry.downloadNavigation.complete(false)
        entry.error = BROWSER_ERROR.permissionDenied
        publish()
        return
      }
      entry.downloadHandoffUrls = new Set(urls)
      if (!downloadSourceAllowed(urls, contents.getURL(), entry.context.origin, apiOrigin)) {
        event.preventDefault()
        if (entry.downloadNavigation && urls.includes(entry.downloadNavigation.url))
          entry.downloadNavigation.complete(false)
        entry.error = BROWSER_ERROR.permissionDenied
        publish()
        return
      }
      const settings = downloads.snapshot()
      const filename = safeDownloadName(item.getFilename())
      if (
        settings.askEveryTime ||
        !settings.directoryAvailable ||
        !options.python ||
        !settings.automaticAvailable
      ) {
        item.setSaveDialogOptions({
          defaultPath: settings.directoryAvailable ? join(settings.directory, filename) : filename,
        })
      } else {
        let stage: DownloadStage | null = null
        try {
          stage = createDownloadStage(browserHome, filename)
          item.setSavePath(stage.path)
          item.once('done', (_download, state) => {
            const cleanup = () => {
              try {
                discardDownloadStage(stage!, options.python!)
              } catch (error) {
                options.log(`[browser-download] staging cleanup failed: ${String(error)}`)
              }
            }
            if (state === 'completed') {
              stage!.publicationAttempted = true
              const publication = publishDownload(
                options.python!,
                stage!.path,
                settings.directory,
                filename
              ).then(cleanup, (error) => {
                entry.error = BROWSER_ERROR.automaticDownloadUnavailable
                options.log(
                  `[browser-download] safe publication failed: ${String(error)}; staged file retained at ${stage!.path}`
                )
                publish()
                if (window.isVisible()) queueRecovery(stage!)
                else pendingRecovery.push(stage!)
              })
              downloadPublications.add(publication)
              void publication.then(
                () => downloadPublications.delete(publication),
                () => {}
              )
            } else cleanup()
          })
        } catch (error) {
          if (stage) {
            try {
              discardDownloadStage(stage, options.python!)
            } catch (cleanupError) {
              options.log(`[browser-download] staging cleanup failed: ${String(cleanupError)}`)
            }
          }
          event.preventDefault()
          entry.error = BROWSER_ERROR.automaticDownloadUnavailable
          options.log(`[browser-download] staging failed: ${String(error)}`)
          publish()
          return
        }
      }
      let finishDownload!: () => void
      const downloadDone = new Promise<void>((resolve) => {
        finishDownload = resolve
      })
      downloadItems.set(item, downloadDone)
      item.once('done', () => {
        downloadItems.delete(item)
        finishDownload()
      })
      entry.error = null
      if (entry.downloadNavigation && urls.includes(entry.downloadNavigation.url))
        entry.downloadNavigation.complete(true)
    }
    isolatedSession.on('will-download', handleDownload)
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      const devtoolsOwner = [...entries.values()].find(
        (value) =>
          value.context.session === isolatedSession &&
          value.devtoolsWindow?.webContents.id === details.webContentsId
      )
      if (!disposed && devtoolsOwner && details.url.startsWith(DEVTOOLS_RESOURCE_PREFIX)) {
        callback({ cancel: false })
        return
      }
      const entry = [...entries.values(), ...stagingEntries].find(
        (value) =>
          value.context.session === isolatedSession &&
          value.view.webContents.id === details.webContentsId
      )
      const rejection = disposed
        ? 'disposed'
        : !entry
          ? 'target_missing'
          : blocksSessionClear(entry.context)
            ? 'session_clearing'
            : searchOnly && entry.agentNavigationCancelled
              ? 'navigation_cancelled'
              : searchOnly && !SEARCH_REQUEST_METHODS.has(details.method)
                ? 'method_denied'
                : searchOnly && details.resourceType === 'webSocket'
                  ? 'websocket_denied'
                  : entry.searchForm?.active() && !entry.searchForm.request(details)
                    ? 'form_boundary_denied'
                    : details.resourceType === 'mainFrame' &&
                        entry.agentNavigationOrigin !== null &&
                        originOf(details.url) !== entry.agentNavigationOrigin
                      ? 'origin_mismatch'
                      : !resourceAllowed(
                            entry,
                            details.url,
                            details.resourceType === 'mainFrame',
                            originOf(details.frame?.url ?? '')
                          )
                        ? 'resource_denied'
                        : null
      if (searchOnly && details.resourceType === 'mainFrame')
        logSearch('navigation', {
          tabId: entry?.tabId,
          phase: 'request-filter',
          allowed: rejection === null,
          reason: rejection,
        })
      callback({ cancel: rejection !== null })
    })
    isolatedSession.webRequest.onHeadersReceived((details, callback) => {
      const marker = details.responseHeaders?.[BROWSER_PROXY_ERROR_HEADER]?.[0]
      const proxyError = marker ? boundary?.consumeProxyError(marker) : null
      const entry = [...stagingEntries].find(
        (value) =>
          value.context.session === isolatedSession &&
          value.view.webContents.id === details.webContentsId
      )
      if (entry && details.resourceType === 'mainFrame' && proxyError) entry.proxyError = proxyError
      callback({})
    })
    const network = createBrowserNetwork(
      () => (localOrigin === apiOrigin ? localOrigin : null),
      localOrigin ? 'origin' : 'public',
      (stage, code) => options.log(`[browser] proxy ${stage} ${code}`)
    )
    const initializing = network.then(async (current) => {
      boundary = current
      await isolatedSession.closeAllConnections()
      await isolatedSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http://${LOOPBACK}:${current.port}`,
        proxyBypassRules: PROXY_BYPASS_RULES,
      })
    })
    let closing: Promise<void> | null = null
    const context: BrowserContext = {
      session: isolatedSession,
      origin: localOrigin,
      agentIsolated,
      searchOnly,
      network,
      ready: initializing,
      close() {
        if (closing) return closing
        isolatedSession.webRequest.onBeforeRequest((_details, callback) =>
          callback({ cancel: true })
        )
        closing = network
          .then(async (boundary) => {
            boundary.revoke()
            await initializing.catch(() => undefined)
            try {
              await isolatedSession.closeAllConnections()
            } finally {
              try {
                await boundary.close()
              } finally {
                if (localOrigin || agentIsolated) await isolatedSession.clearStorageData()
              }
            }
          })
          .finally(() => {
            if (!agentIsolated) isolatedSession.removeListener('will-download', handleDownload)
            contexts.delete(context)
          })
        return closing
      },
    }
    contexts.add(context)
    context.ready = initializing.catch(async (error) => {
      try {
        await context.close()
      } catch {
        options.log('[browser] failed initialization cleanup failed')
      }
      throw error
    })
    void context.ready.catch(() => options.log('[browser] network initialization failed'))
    return context
  }
  const remoteContext = createContext(null)
  const searchContexts = new Set<BrowserContext>()
  const retireContext = (context: BrowserContext) => {
    if (context === remoteContext) return
    if ([...liveEntries].some((entry) => entry.context === context)) return
    searchContexts.delete(context)
    const closing = context.close()
    pendingDisposals.add(closing)
    void closing
      .catch(() => options.log('[browser] local session disposal failed'))
      .finally(() => pendingDisposals.delete(closing))
  }
  const navigate = async (
    tabId: string,
    input: string,
    explicit = false,
    approvedOrigin?: string,
    preserveAgentIsolation = false,
    historyEpoch = historyClearEpoch
  ): Promise<void> => {
    searchRedirects.delete(tabId)
    const entry = entryFor(tabId)
    if (blocksSessionClear(entry.context)) throw new Error(BROWSER_ERROR.cdpBusy)
    const navigationEpoch = clearEpoch
    const navigationProfileEpoch = profileClearEpoch
    const navigationHistoryEpoch = historyEpoch
    const url = normalizeBrowserInput(input)
    if (approvedOrigin && url.origin !== approvedOrigin)
      throw new Error(BROWSER_ERROR.permissionDenied)
    const desiredOrigin = explicit && url.origin === apiOrigin ? apiOrigin : null
    if (explicit && entry.context.origin !== desiredOrigin) {
      if (
        !browserResourceAllowed({
          url,
          topOrigin: desiredOrigin ?? originOf(entry.view.webContents.getURL()) ?? '',
          approvedLocalOrigin: desiredOrigin,
          apiOrigin,
        })
      )
        throw new Error(BROWSER_ERROR.permissionDenied)
    } else if (!resourceAllowed(entry, url.href, true, originOf(entry.view.webContents.getURL()))) {
      options.log('[browser] navigation denied by resource policy')
      throw new Error(BROWSER_ERROR.permissionDenied)
    }
    const navigationSerial = ++entry.navigationSerial
    invalidateAgentTarget(entry, approvedOrigin ? 'target' : 'external')
    entry.agentNavigationOrigin = approvedOrigin ?? null
    entry.agentNavigationCancelled = false
    entry.agentIssuedLoad = false
    entry.agentNavigationStartSeen = false
    entry.agentNavigationUrls.clear()
    if (approvedOrigin) entry.agentNavigationUrls.add(url.href)
    entry.navigationController?.abort()
    entry.navigationController = null
    for (const staged of [...stagingEntries])
      if (staged.tabId === tabId) {
        stageControllers.get(staged)?.abort()
        stageControllers.delete(staged)
        stagingEntries.delete(staged)
        if (!staged.view.webContents.isDestroyed())
          staged.view.webContents.close({ waitForBeforeUnload: false })
        retireContext(staged.context)
      }
    entry.downloadHandoffUrls.clear()
    if (
      approvedOrigin !== undefined ||
      (entry.context.agentIsolated && !approvedOrigin && !preserveAgentIsolation) ||
      (explicit && entry.context.origin !== desiredOrigin)
    ) {
      const context =
        approvedOrigin !== undefined
          ? entry.context.agentIsolated
            ? entry.context
            : createContext(null, true)
          : desiredOrigin
            ? createContext(desiredOrigin)
            : remoteContext
      await context.ready
      options.log('[browser] staged navigation context ready')
      if (staleAfterClear(context, navigationEpoch, navigationProfileEpoch)) {
        retireContext(context)
        throw new Error(BROWSER_ERROR.cdpBusy)
      }
      if (disposed || entries.get(tabId) !== entry || entry.navigationSerial !== navigationSerial) {
        retireContext(context)
        throw new Error(
          approvedOrigin !== undefined && entry.navigationSerial !== navigationSerial
            ? AGENT_NAVIGATION_NOT_ISSUED
            : BROWSER_ERROR.targetClosed
        )
      }
      if (context.origin !== null && context.origin !== apiOrigin) {
        retireContext(context)
        throw new Error(BROWSER_ERROR.permissionDenied)
      }
      let staged: BrowserEntry
      try {
        staged = createEntry(context, tabId, false, entry.page.zoom())
      } catch (error) {
        retireContext(context)
        throw error
      }
      staged.historyNavigationEpoch = navigationHistoryEpoch
      staged.historyNavigationPending = true
      staged.agentNavigationOrigin = approvedOrigin ?? null
      staged.agentIssuedLoad = approvedOrigin !== undefined
      if (approvedOrigin) staged.agentNavigationUrls.add(url.href)
      const searchAttempt =
        approvedOrigin !== undefined &&
        context.searchOnly &&
        searchOwners.get(tabId) === context &&
        entry.searchForm === null &&
        entry.view.webContents.getURL() === BLANK_PAGE
          ? {
              source: entry,
              navigationSerial,
              generation: entry.agentGeneration,
              requestedUrl: url.href,
            }
          : null
      if (searchAttempt) searchNavigationRequests.set(staged, searchAttempt)
      const stageController = new AbortController()
      stageControllers.set(staged, stageController)
      try {
        if (!resourceAllowed(staged, url.href, true, null))
          throw new Error(BROWSER_ERROR.permissionDenied)
        options.log('[browser] staged navigation load started')
        let issuedLoad: Promise<boolean> | null = null
        let issuedError: unknown
        let completeDownload!: (allowed: boolean) => void
        const download = new Promise<boolean>((resolve) => {
          completeDownload = resolve
        })
        staged.downloadNavigation = { url: url.href, complete: completeDownload }
        const outcome = await Promise.race([
          loadUntilCommit(
            staged.view.webContents,
            url.href,
            () =>
              staleAfterClear(staged.context, navigationEpoch, navigationProfileEpoch) ||
              entry.navigationSerial !== navigationSerial,
            stageController.signal,
            (load) => {
              issuedLoad = load.then(
                () => true,
                (error) => {
                  issuedError = error
                  return false
                }
              )
            }
          ).then(
            () => ({ kind: 'loaded' as const }),
            (error) => ({ kind: 'failed' as const, error })
          ),
          download.then((allowed) => ({ kind: 'download' as const, allowed })),
        ])
        staged.downloadNavigation = null
        if (outcome.kind === 'download') {
          stageController.abort()
          if (issuedLoad) await issuedLoad
          await awaitNavigationIdle(staged.view.webContents)
          throw new Error(
            approvedOrigin !== undefined
              ? AGENT_NAVIGATION_OUTCOME_UNKNOWN
              : BROWSER_ERROR.permissionDenied
          )
        }
        if (outcome.kind === 'failed') {
          options.log(
            `[browser-navigation] staged load failed code=${(outcome.error as { code?: unknown })?.code ?? 'unknown'} proxy=${staged.proxyError ?? 'none'} aborted=${stageController.signal.aborted} superseded=${entry.navigationSerial !== navigationSerial}`
          )
          if (approvedOrigin !== undefined && issuedLoad) {
            await issuedLoad
            await awaitNavigationIdle(staged.view.webContents)
            throw new Error(AGENT_NAVIGATION_OUTCOME_UNKNOWN, { cause: outcome.error })
          }
          throw stageController.signal.aborted
            ? outcome.error
            : new Error(staged.proxyError ?? BROWSER_ERROR.navigationFailed)
        }
        if (approvedOrigin !== undefined && issuedLoad) {
          const loaded = await issuedLoad
          await awaitNavigationIdle(staged.view.webContents)
          if (
            !loaded ||
            stageController.signal.aborted ||
            entry.navigationSerial !== navigationSerial
          ) {
            throw new Error(AGENT_NAVIGATION_OUTCOME_UNKNOWN, { cause: issuedError })
          }
        }
        options.log('[browser] staged navigation load completed')
        if (staleAfterClear(staged.context, navigationEpoch, navigationProfileEpoch)) {
          throw new Error(
            approvedOrigin !== undefined ? AGENT_NAVIGATION_OUTCOME_UNKNOWN : BROWSER_ERROR.cdpBusy
          )
        }
        if (entry.navigationSerial !== navigationSerial) {
          throw new Error(
            approvedOrigin !== undefined
              ? AGENT_NAVIGATION_OUTCOME_UNKNOWN
              : BROWSER_ERROR.targetClosed
          )
        }
        if (staged.proxyError) throw new Error(staged.proxyError)
        if (disposed || entries.get(tabId) !== entry) throw new Error(BROWSER_ERROR.targetClosed)
        if (context.origin !== null && context.origin !== apiOrigin)
          throw new Error(BROWSER_ERROR.permissionDenied)
        window.contentView.addChildView(staged.view)
      } catch (error) {
        staged.downloadNavigation = null
        stageControllers.delete(staged)
        stagingEntries.delete(staged)
        const receipt = searchRedirects.get(tabId)
        const receiptPending = receipt && receipt.attempt === searchAttempt
        const destroyed =
          receiptPending && !staged.view.webContents.isDestroyed()
            ? new Promise<void>((resolve) => staged.view.webContents.once('destroyed', resolve))
            : null
        if (!staged.view.webContents.isDestroyed())
          staged.view.webContents.close({ waitForBeforeUnload: false })
        retireContext(context)
        if (destroyed) await destroyed
        if (receiptPending && searchRedirects.get(tabId) === receipt) {
          if (
            currentSearchAttempt(receipt.attempt) &&
            !staleAfterClear(context, receipt.clearEpoch, receipt.profileEpoch)
          )
            receipt.settled = true
          else searchRedirects.delete(tabId)
        }
        throw error
      }
      staged.bounds = entry.bounds
      staged.view.webContents.setZoomFactor(entry.page.zoom())
      entry.page.invalidate()
      staged.visible = entry.visible
      staged.agentNavigationOrigin = null
      staged.agentIssuedLoad = false
      staged.agentNavigationUrls.clear()
      stageControllers.delete(staged)
      stagingEntries.delete(staged)
      entries.set(tabId, staged)
      const owner = agentOwners.get(tabId)
      if (owner?.entry === entry)
        agentOwners.set(tabId, { sessionId: owner.sessionId, entry: staged })
      staged.historyNavigationPending = false
      closePopupChildren(entry)
      if (
        navigationHistoryEpoch === historyClearEpoch &&
        context.origin === null &&
        staged.lastResponseCode !== null &&
        staged.lastResponseCode >= HTTP_SUCCESS_MIN &&
        staged.lastResponseCode < HTTP_SUCCESS_LIMIT &&
        /^https?:\/\//.test(staged.view.webContents.getURL())
      ) {
        staged.latestVisitId = history.record(
          staged.view.webContents.getURL(),
          staged.view.webContents.getTitle()
        )
      }
      for (const listener of detachListeners) listener(tabId, BROWSER_ERROR.targetClosed)
      entry.devtoolsWindow?.destroy()
      window.contentView.removeChildView(entry.view)
      if (!entry.view.webContents.isDestroyed()) {
        const destroyed = new Promise<void>((resolve) =>
          entry.view.webContents.once('destroyed', () => resolve())
        )
        entry.view.webContents.close({ waitForBeforeUnload: false })
        await destroyed
      }
      retireContext(entry.context)
      layout()
      publish()
      return
    }
    await entry.context.ready
    options.log('[browser] navigation context ready')
    if (staleAfterClear(entry.context, navigationEpoch, navigationProfileEpoch))
      throw new Error(BROWSER_ERROR.cdpBusy)
    if (entry.navigationSerial !== navigationSerial) {
      if (approvedOrigin) throw new Error(AGENT_NAVIGATION_NOT_ISSUED)
      return
    }
    entry.error = null
    entry.latestVisitId = null
    entry.historyNavigationEpoch = navigationHistoryEpoch
    entry.historyNavigationPending = true
    options.log('[browser] navigation load started')
    let completeDownload!: (allowed: boolean) => void
    const download = new Promise<boolean>((resolve) => {
      completeDownload = resolve
    })
    const downloadNavigation = { url: url.href, complete: completeDownload }
    entry.downloadNavigation = downloadNavigation
    const navigationController = new AbortController()
    entry.navigationController = navigationController
    let issuedLoad: Promise<boolean> | null = null
    try {
      entry.agentIssuedLoad = approvedOrigin !== undefined
      const outcome = await Promise.race([
        loadUntilCommit(
          entry.view.webContents,
          url.href,
          () => false,
          navigationController.signal,
          (load) => {
            issuedLoad = load.then(
              () => true,
              () => false
            )
          }
        ).then(
          () => ({ kind: 'loaded' as const }),
          (error) => ({ kind: 'failed' as const, error })
        ),
        download.then((allowed) => ({ kind: 'download' as const, allowed })),
      ])
      if (outcome.kind === 'download') {
        navigationController.abort()
        if (approvedOrigin) {
          if (issuedLoad) await issuedLoad
          await awaitNavigationIdle(entry.view.webContents)
          throw new Error(AGENT_NAVIGATION_OUTCOME_UNKNOWN)
        }
        if (!outcome.allowed) {
          entry.error = BROWSER_ERROR.permissionDenied
          throw new Error(BROWSER_ERROR.permissionDenied)
        }
        entry.error = null
        return
      }
      if (outcome.kind === 'failed') throw outcome.error
      if (approvedOrigin && issuedLoad) {
        const loaded = await issuedLoad
        await awaitNavigationIdle(entry.view.webContents)
        if (entry.navigationSerial !== navigationSerial || navigationController.signal.aborted) {
          throw new Error(AGENT_NAVIGATION_OUTCOME_UNKNOWN)
        }
        if (!loaded) throw new Error(BROWSER_ERROR.navigationFailed)
      }
    } catch (error) {
      if (
        approvedOrigin &&
        issuedLoad &&
        (entry.navigationSerial !== navigationSerial ||
          navigationController.signal.aborted ||
          (error instanceof Error && error.message.includes(NAVIGATION_ABORTED_MESSAGE)))
      ) {
        await issuedLoad
        await awaitNavigationIdle(entry.view.webContents)
        throw new Error(AGENT_NAVIGATION_OUTCOME_UNKNOWN, { cause: error })
      }
      if (entry.navigationSerial !== navigationSerial) return
      if (error instanceof Error && error.message.includes(NAVIGATION_ABORTED_MESSAGE)) return
      if (error instanceof Error && error.message === BROWSER_ERROR.permissionDenied) throw error
      if ((error as { code?: unknown })?.code === NAVIGATION_FAILED_MESSAGE) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const handoff = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), DOWNLOAD_HANDOFF_TIMEOUT_MS)
        })
        const accepted = await Promise.race([download, handoff])
        if (timer) clearTimeout(timer)
        if (accepted === true) return
        if (accepted === false) {
          entry.error = BROWSER_ERROR.permissionDenied
          throw new Error(BROWSER_ERROR.permissionDenied, { cause: error })
        }
      }
      entry.error = BROWSER_ERROR.navigationFailed
      throw new Error(BROWSER_ERROR.navigationFailed, { cause: error })
    } finally {
      if (entry.navigationSerial === navigationSerial) entry.historyNavigationPending = false
      if (entry.downloadNavigation === downloadNavigation) entry.downloadNavigation = null
      if (entry.navigationController === navigationController) {
        entry.navigationController = null
        entry.agentNavigationOrigin = null
        entry.agentIssuedLoad = false
        entry.agentNavigationStartSeen = false
        entry.agentNavigationUrls.clear()
      }
      publish()
    }
    options.log('[browser] navigation load completed')
  }
  const closePopupChildren = (entry: BrowserEntry) => {
    for (const admission of [...popupAdmissions]) {
      if (admission.source !== entry) continue
      popupAdmissions.delete(admission)
      if (!admission.tabId) continue
      const child = entries.get(admission.tabId)
      if (child) closeEntry(child)
    }
  }
  const closeEntry = (entry: BrowserEntry) => {
    agentOwners.delete(entry.tabId)
    searchOwners.delete(entry.tabId)
    entry.page.dispose()
    invalidateAgentTarget(entry)
    entry.navigationController?.abort()
    for (const staged of [...stagingEntries])
      if (staged.tabId === entry.tabId) {
        stageControllers.get(staged)?.abort()
        stageControllers.delete(staged)
        stagingEntries.delete(staged)
        if (!staged.view.webContents.isDestroyed())
          staged.view.webContents.close({ waitForBeforeUnload: false })
        retireContext(staged.context)
      }
    entries.delete(entry.tabId)
    for (const admission of [...popupAdmissions])
      if (admission.tabId === entry.tabId) popupAdmissions.delete(admission)
    closePopupChildren(entry)
    entry.devtoolsWindow?.destroy()
    for (const listener of detachListeners) listener(entry.tabId, BROWSER_ERROR.targetClosed)
    if (!window.isDestroyed()) window.contentView.removeChildView(entry.view)
    if (!entry.view.webContents.isDestroyed())
      entry.view.webContents.close({ waitForBeforeUnload: false })
    retireContext(entry.context)
    if (activeTabId === entry.tabId) activeTabId = entries.keys().next().value ?? null
    layout()
    publish()
  }
  const createEntry = (
    context: BrowserContext,
    tabId: string = randomUUID(),
    registered = true,
    zoom?: number
  ): BrowserEntry => {
    const view = new WebContentsView({
      webPreferences: {
        session: context.session,
        sandbox: true,
        contextIsolation: true,
        javascript: !context.searchOnly,
        ...(context.searchOnly ? { disableBlinkFeatures: SEARCH_DISABLED_BLINK_FEATURES } : {}),
        backgroundThrottling: !context.searchOnly,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    })
    if (context.searchOnly) {
      view.setVisible(false)
      view.setBounds(SEARCH_VIEWPORT_BOUNDS)
    }
    const page: PageActions = createPageActions({
      contents: view.webContents,
      zoom,
      current: () =>
        !disposed &&
        !clearing &&
        !view.webContents.isCrashed() &&
        entries.get(tabId) === entry &&
        activeTabId === tabId
          ? entry.menuNavigationId
          : null,
      acquirePrint: () => {
        if (printBusy) return null
        printBusy = true
        return () => {
          printBusy = false
        }
      },
    })
    const entry: BrowserEntry = {
      page,
      tabId,
      agentInstanceId: randomUUID(),
      menuNavigationId: 1,
      view,
      context,
      bounds: EMPTY_BOUNDS,
      visible: false,
      error: null,
      cdpStatus: BROWSER_CDP_STATUS.disabled,
      devtoolsOpening: false,
      devtoolsWindow: null,
      proxyError: null,
      latestVisitId: null,
      historyNavigationEpoch: historyClearEpoch,
      historyNavigationPending: false,
      lastResponseCode: null,
      downloadNavigation: null,
      downloadHandoffUrls: new Set(),
      navigationSerial: 0,
      agentGeneration: 0,
      agentNavigationOrigin: null,
      agentNavigationCancelled: false,
      agentIssuedLoad: false,
      agentNavigationStartSeen: false,
      agentNavigationUrls: new Set(),
      agentDetachPending: false,
      navigationController: null,
      agentPopupBlocks: new Set(),
      searchForm: null,
    }
    liveEntries.add(entry)
    const contents = view.webContents
    const ownsDocumentUpdate = (url: string): boolean =>
      entry.agentNavigationOrigin !== null &&
      entry.agentIssuedLoad &&
      !entry.agentNavigationCancelled &&
      entry.agentNavigationStartSeen &&
      entry.agentNavigationUrls.has(url) &&
      contents.getURL() === url &&
      originOf(url) === entry.agentNavigationOrigin
    contents.on('focus', () => {
      if (entries.get(entry.tabId) === entry && activeTabId === entry.tabId) options.onPageFocus?.()
    })
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    if (registered) {
      if (activeTabId) {
        const previous = entries.get(activeTabId)
        if (previous) {
          previous.menuNavigationId += 1
          previous.page.invalidate()
        }
      }
      entries.set(entry.tabId, entry)
      activeTabId = entry.tabId
      window.contentView.addChildView(view)
    } else stagingEntries.add(entry)
    contents.on('before-input-event', (event, input) => {
      if (
        entries.get(tabId) !== entry ||
        activeTabId !== tabId ||
        !view.getVisible() ||
        !contents.isFocused() ||
        !pageFindShortcut(input, process.platform)
      )
        return
      event.preventDefault()
      options.onFind?.({
        tabId,
        instanceId: entry.agentInstanceId,
        navigationId: entry.menuNavigationId,
      })
    })
    contents.on('zoom-changed', publish)
    contents.on('render-process-gone', () => {
      entry.menuNavigationId += 1
      entry.page.crash()
      invalidateAgentTarget(entry)
    })
    contents.on('login', (event, _details, auth, callback) => {
      event.preventDefault()
      void context.network
        .then((boundary) => {
          if (!disposed && auth.isProxy && auth.host === LOOPBACK && auth.port === boundary.port)
            callback(boundary.username, boundary.password)
          else callback()
        })
        .catch(() => callback())
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (entry.agentPopupBlocks.size > 0)
        options.log('[browser] popup blocked during approved Agent action')
      if (
        entries.get(entry.tabId) === entry &&
        entry.agentPopupBlocks.size === 0 &&
        !searchContexts.has(entry.context) &&
        entry.context.origin === null &&
        popupAdmissions.size < MAX_ACTIVE_POPUPS &&
        resourceAllowed(entry, url, false, originOf(contents.getURL()))
      ) {
        const admission = { source: entry, tabId: null as string | null }
        popupAdmissions.add(admission)
        void open(url, admission)
          .catch(() => options.log('[browser] popup navigation denied'))
          .finally(() => {
            if (!admission.tabId || !entries.has(admission.tabId)) popupAdmissions.delete(admission)
          })
      }
      return { action: 'deny' }
    })
    const guard = (event: Electron.Event, url: string, redirect: boolean, mainFrame = false) => {
      if (entry.searchForm?.active()) {
        const owned =
          entry.searchForm.navigation(url, redirect ? 'redirect' : 'intent') &&
          !blocksSessionClear(entry.context) &&
          resourceAllowed(entry, url, true, originOf(contents.getURL()))
        logSearch('navigation', {
          tabId: entry.tabId,
          phase: redirect ? 'redirect-guard' : 'intent-guard',
          allowed: owned,
        })
        invalidateAgentTarget(entry, owned ? 'target' : 'external', 'navigation')
        if (!owned) event.preventDefault()
        return
      }
      const searchAttempt = redirect && mainFrame ? searchNavigationRequests.get(entry) : undefined
      if (
        searchAttempt &&
        currentSearchAttempt(searchAttempt) &&
        stagingEntries.has(entry) &&
        entry.context === searchAttempt.source.context &&
        entry.searchForm === null &&
        entry.agentIssuedLoad &&
        entry.agentNavigationStartSeen &&
        !entry.agentNavigationCancelled &&
        entry.agentNavigationOrigin === originOf(searchAttempt.requestedUrl) &&
        originOf(url) !== entry.agentNavigationOrigin &&
        resourceAllowed(entry, url, true, originOf(contents.getURL()))
      ) {
        event.preventDefault()
        invalidateAgentTarget(entry, 'external', 'navigation')
        if (currentSearchAttempt(searchAttempt))
          searchRedirects.set(entry.tabId, {
            attempt: searchAttempt,
            url,
            expiresAt: Date.now() + SEARCH_REDIRECT_TTL_MS,
            clearEpoch,
            profileEpoch: profileClearEpoch,
            settled: false,
          })
        logSearch('navigation', { tabId: entry.tabId, phase: 'homepage-redirect', allowed: false })
        return
      }
      const ownedRedirect =
        redirect &&
        entry.agentNavigationOrigin !== null &&
        entry.agentIssuedLoad &&
        !entry.agentNavigationCancelled &&
        originOf(url) === entry.agentNavigationOrigin
      if (ownedRedirect) entry.agentNavigationUrls.add(url)
      if (entry.agentNavigationOrigin !== null)
        options.log(
          `[browser-navigation] navigation guard redirect=${redirect} owned=${ownedRedirect} sameOrigin=${originOf(url) === entry.agentNavigationOrigin} destinationOrigin=${originOf(url)}`
        )
      invalidateAgentTarget(entry, ownedRedirect ? 'target' : 'external', 'navigation')
      if (
        blocksSessionClear(entry.context) ||
        (entry.agentNavigationOrigin !== null && originOf(url) !== entry.agentNavigationOrigin) ||
        !resourceAllowed(entry, url, true, originOf(contents.getURL()))
      )
        event.preventDefault()
      else {
        if (!entry.historyNavigationPending) {
          entry.historyNavigationEpoch = historyClearEpoch
          entry.historyNavigationPending = true
        }
        entry.latestVisitId = null
        entry.downloadHandoffUrls.delete(url)
      }
    }
    contents.on('will-navigate', (event, url) => guard(event, url, false))
    contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) =>
      guard(event, url, true, event.isMainFrame ?? isMainFrame)
    )
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return
      entry.menuNavigationId += 1
      entry.page.invalidate()
      if (entry.searchForm?.active()) {
        const allowed = !details.isSameDocument && entry.searchForm.navigation(details.url, 'start')
        logSearch('navigation', {
          tabId: entry.tabId,
          phase: 'start-guard',
          allowed,
          sameDocument: details.isSameDocument,
        })
        if (!allowed) {
          invalidateAgentTarget(entry, 'external', 'navigation')
        }
        return
      }
      if (!entry.historyNavigationPending) {
        entry.historyNavigationEpoch = historyClearEpoch
        entry.historyNavigationPending = true
      }
      const ownedStart =
        entry.agentNavigationOrigin !== null &&
        entry.agentIssuedLoad &&
        !entry.agentNavigationCancelled &&
        !entry.agentNavigationStartSeen &&
        !details.isSameDocument &&
        details.initiator == null &&
        entry.agentNavigationUrls.has(details.url)
      if (ownedStart) {
        entry.agentNavigationStartSeen = true
        return
      }
      const ownedDocumentUpdate =
        details.isSameDocument && details.initiator == null && ownsDocumentUpdate(details.url)
      if (ownedDocumentUpdate) {
        invalidateAgentTarget(entry, 'target', 'navigation')
        return
      }
      if (entry.agentNavigationOrigin !== null)
        options.log(
          `[browser-navigation] unowned start issued=${entry.agentIssuedLoad} cancelled=${entry.agentNavigationCancelled} seen=${entry.agentNavigationStartSeen} sameDocument=${details.isSameDocument} initiator=${details.initiator == null ? 'absent' : 'present'} known=${entry.agentNavigationUrls.has(details.url)}`
        )
      invalidateAgentTarget(entry, 'external', 'navigation')
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('did-navigate', (_event, url, responseCode) => {
      if (entry.searchForm?.active()) {
        const owned =
          entry.searchForm.navigation(url, 'commit') &&
          responseCode >= HTTP_SUCCESS_MIN &&
          responseCode < HTTP_SUCCESS_LIMIT
        logSearch('navigation', {
          tabId: entry.tabId,
          phase: 'commit-guard',
          allowed: owned,
          responseCode,
        })
        invalidateAgentTarget(entry, owned ? 'target' : 'external', 'navigation')
        entry.lastResponseCode = responseCode
        publish()
        return
      }
      const ownedCommit =
        entry.agentNavigationOrigin !== null &&
        entry.agentIssuedLoad &&
        !entry.agentNavigationCancelled &&
        entry.agentNavigationUrls.has(url)
      invalidateAgentTarget(entry, ownedCommit ? 'target' : 'external', 'navigation')
      if (!entry.downloadHandoffUrls.has(url)) entry.downloadHandoffUrls.clear()
      entry.lastResponseCode = responseCode
      const recordHistory = entry.historyNavigationEpoch === historyClearEpoch
      entry.historyNavigationPending = false
      if (
        !clearing &&
        entries.get(entry.tabId) === entry &&
        entry.context.origin === null &&
        recordHistory &&
        /^https?:\/\//.test(url) &&
        responseCode >= HTTP_SUCCESS_MIN &&
        responseCode < HTTP_SUCCESS_LIMIT
      ) {
        entry.latestVisitId = history.record(url, contents.getTitle())
      }
      publish()
    })
    contents.on('page-title-updated', (_event, title) => {
      if (entry.latestVisitId && entries.get(entry.tabId) === entry)
        history.updateTitle(entry.latestVisitId, title)
      publish()
    })
    contents.on('did-start-loading', publish)
    contents.on('did-stop-loading', publish)
    contents.on('dom-ready', () => syncSearchRendering(entry, 'document-ready'))
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        if (entry.searchForm?.active()) {
          logSearch('navigation', { tabId: entry.tabId, phase: 'same-document', allowed: false })
          entry.searchForm.invalidate()
          invalidateAgentTarget(entry, 'external', 'navigation')
          return
        }
        const ownedUpdate = ownsDocumentUpdate(url)
        if (entry.agentNavigationOrigin !== null)
          options.log(`[browser-navigation] in-page update owned=${ownedUpdate}`)
        invalidateAgentTarget(entry, ownedUpdate ? 'target' : 'external', 'navigation')
      }
      const recordHistory =
        !entry.historyNavigationPending || entry.historyNavigationEpoch === historyClearEpoch
      entry.historyNavigationPending = false
      if (
        isMainFrame &&
        !clearing &&
        entries.get(entry.tabId) === entry &&
        entry.context.origin === null &&
        recordHistory &&
        /^https?:\/\//.test(url)
      )
        entry.latestVisitId = history.record(url, contents.getTitle())
      publish()
    })
    contents.on('devtools-opened', () => {
      entry.devtoolsOpening = false
      entry.devtoolsWindow?.show()
      entry.cdpStatus = BROWSER_CDP_STATUS.conflict
      for (const listener of detachListeners) listener(entry.tabId, BROWSER_ERROR.devtoolsConflict)
      publish()
    })
    contents.on('devtools-closed', () => {
      entry.devtoolsOpening = false
      const devtoolsWindow = entry.devtoolsWindow
      entry.devtoolsWindow = null
      if (devtoolsWindow && !devtoolsWindow.isDestroyed()) devtoolsWindow.destroy()
      entry.cdpStatus = BROWSER_CDP_STATUS.disabled
      publish()
    })
    contents.on('did-fail-provisional-load', (_event, code, _description, _url, isMainFrame) => {
      if (entry.searchForm?.active() && isMainFrame)
        logSearch('navigation', { tabId: entry.tabId, phase: 'provisional-load-failed', code })
    })
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (entry.searchForm?.active() && isMainFrame)
        logSearch('navigation', { tabId: entry.tabId, phase: 'load-failed', code })
      if (
        isMainFrame &&
        code !== NAVIGATION_ABORTED_ERROR &&
        !entry.downloadHandoffUrls.has(_url)
      ) {
        options.log(`[browser] main-frame load failed ${code}`)
        entry.error = BROWSER_ERROR.navigationFailed
        publish()
      }
    })
    contents.debugger.on('detach', (_event, reason) => {
      const agentRelease =
        entry.agentDetachPending &&
        reason !== DEVTOOLS_DETACH_REASON &&
        entry.devtoolsWindow === null &&
        !entry.devtoolsOpening &&
        !contents.isDevToolsOpened()
      entry.agentDetachPending = false
      const previousGeneration = entry.agentGeneration
      invalidateAgentTarget(entry, agentRelease ? 'target' : 'external')
      const conflict =
        entry.devtoolsWindow !== null ||
        entry.devtoolsOpening ||
        contents.isDevToolsOpened() ||
        reason === DEVTOOLS_DETACH_REASON
      entry.devtoolsOpening = conflict
      entry.cdpStatus = conflict ? BROWSER_CDP_STATUS.conflict : BROWSER_CDP_STATUS.disabled
      for (const listener of detachListeners)
        listener(
          entry.tabId,
          conflict ? BROWSER_ERROR.devtoolsConflict : reason,
          agentRelease
            ? {
                instanceId: entry.agentInstanceId,
                previousGeneration,
                generation: entry.agentGeneration,
              }
            : undefined
        )
      publish()
    })
    contents.once('destroyed', () => {
      entry.page.dispose()
      liveEntries.delete(entry)
      stagingEntries.delete(entry)
      stageControllers.get(entry)?.abort()
      stageControllers.delete(entry)
      if (entries.get(entry.tabId) === entry) closeEntry(entry)
      retireContext(entry.context)
    })
    layout()
    return entry
  }
  const open = async (input?: string, popup?: { source: BrowserEntry; tabId: string | null }) => {
    if (clearing) throw new Error(BROWSER_ERROR.cdpBusy)
    const openingEpoch = clearEpoch
    const openingProfileEpoch = profileClearEpoch
    const openingHistoryEpoch = historyClearEpoch
    const url = input ? normalizeBrowserInput(input) : null
    const context = popup?.source.context.agentIsolated
      ? popup.source.context
      : url?.origin === apiOrigin
        ? createContext(apiOrigin)
        : remoteContext
    await context.ready
    if (popup && entries.get(popup.source.tabId) !== popup.source) {
      retireContext(context)
      throw new Error(BROWSER_ERROR.targetClosed)
    }
    if (disposed) {
      retireContext(context)
      throw new Error(BROWSER_ERROR.targetClosed)
    }
    if (staleAfterClear(context, openingEpoch, openingProfileEpoch)) {
      retireContext(context)
      throw new Error(BROWSER_ERROR.cdpBusy)
    }
    if (context.origin !== null && context.origin !== apiOrigin) {
      retireContext(context)
      throw new Error(BROWSER_ERROR.permissionDenied)
    }
    const entry = createEntry(context)
    entry.historyNavigationEpoch = openingHistoryEpoch
    entry.historyNavigationPending = true
    if (popup) popup.tabId = entry.tabId
    try {
      if (input)
        await navigate(
          entry.tabId,
          input,
          true,
          undefined,
          Boolean(popup?.source.context.agentIsolated),
          openingHistoryEpoch
        )
      else {
        const openingNavigationSerial = entry.navigationSerial
        try {
          await entry.view.webContents.loadURL(BLANK_PAGE)
        } catch (error) {
          if (entry.navigationSerial === openingNavigationSerial) throw error
        }
      }
      if (
        popup &&
        (entries.get(popup.source.tabId) !== popup.source || entries.get(entry.tabId) !== entry)
      ) {
        throw new Error(BROWSER_ERROR.targetClosed)
      }
    } catch (error) {
      if (entries.get(entry.tabId) === entry) closeEntry(entry)
      throw error
    }
    publish()
    return entry.tabId
  }
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true
    historyAgent.revokeAll()
    const downloadsDone = [...downloadItems.values()]
    for (const item of downloadItems.keys()) item.cancel()
    for (const entry of [...entries.values()]) closeEntry(entry)
    for (const staged of [...stagingEntries]) {
      stageControllers.get(staged)?.abort()
      stageControllers.delete(staged)
      stagingEntries.delete(staged)
      if (!staged.view.webContents.isDestroyed())
        staged.view.webContents.close({ waitForBeforeUnload: false })
      retireContext(staged.context)
    }
    for (const event of WINDOW_LAYOUT_EVENTS) windowEvents.removeListener(event, layout)
    window.removeListener('show', onRecoveryShow)
    window.removeListener('closed', onClosed)
    disposal = Promise.allSettled([
      ...pendingDisposals,
      ...[...contexts].map((context) => context.close()),
    ])
      .then(async (results) => {
        await Promise.all(downloadsDone)
        await Promise.all([recoveryQueue, ...downloadPublications])
        await historyAgent.waitForLeases()
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      })
      .finally(() => {
        historyAgent.revokeAll()
        history.close()
        owners.delete(browserSession)
      })
    return disposal
  }
  const onClosed = () => {
    void dispose().catch(() => options.log('[browser] disposal failed'))
  }
  for (const event of WINDOW_LAYOUT_EVENTS) windowEvents.on(event, layout)
  window.once('closed', onClosed)
  const createIsolatedTarget = async (
    searchOnly = false
  ): Promise<{ tabId: string; close(): void }> => {
    if (disposed || clearing) throw new Error(BROWSER_ERROR.desktopBridgeUnavailable)
    const context = createContext(null, true, searchOnly)
    await context.ready
    if (disposed || clearing) {
      retireContext(context)
      throw new Error(BROWSER_ERROR.targetClosed)
    }
    searchContexts.add(context)
    const entry = createEntry(context)
    try {
      await entry.view.webContents.loadURL(BLANK_PAGE)
      await awaitNavigationIdle(entry.view.webContents)
      if (disposed || clearing || entries.get(entry.tabId) !== entry)
        throw new Error(BROWSER_ERROR.targetClosed)
    } catch (error) {
      searchContexts.delete(context)
      closeEntry(entry)
      throw error
    }
    publish()
    return {
      tabId: entry.tabId,
      close: () => {
        const current = entries.get(entry.tabId)
        if (current?.context === context) closeEntry(current)
        searchContexts.delete(context)
      },
    }
  }
  return {
    async page(input) {
      const request = parsePageRequest(input)
      const tabId = request.kind === 'target' ? request.tabId : request.target.tabId
      const identity = this.menuTarget(tabId)
      const target = {
        tabId: identity.tabId,
        instanceId: identity.instanceId,
        navigationId: identity.navigationId,
      }
      if (request.kind !== 'target' && !samePageTarget(target, request.target))
        throw new Error(BROWSER_ERROR.targetClosed)
      const entry = entryFor(tabId)
      if (request.kind === 'zoom') {
        entry.page.setZoom(request.factor)
        publish()
      }
      if (request.kind === 'print') {
        const result = await entry.page.print()
        if (!samePageTarget(this.menuTarget(tabId), target))
          throw new Error(BROWSER_ERROR.targetClosed)
        return { ok: true, target, print: result }
      }
      if (request.kind === 'devtools')
        await this.dispatch({ kind: 'devtools', tabId, open: request.open })
      return { ok: true, target }
    },
    find(target, query, publishResult) {
      if (!samePageTarget(this.menuTarget(target.tabId), target))
        throw new Error(BROWSER_ERROR.targetClosed)
      entryFor(target.tabId).page.find(query, publishResult)
    },
    stopFind(target) {
      const entry = entries.get(target.tabId)
      if (entry?.agentInstanceId === target.instanceId) entry.page.stopFind()
    },
    focusPage(target) {
      if (samePageTarget(this.menuTarget(target.tabId), target))
        entryFor(target.tabId).view.webContents.focus()
    },
    nativeVisible: () =>
      !disposed &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      [...entries.values()].some((entry) => {
        if (
          !entry.visible ||
          entry.tabId !== activeTabId ||
          entry.view.webContents.isDestroyed() ||
          !entry.view.getVisible()
        )
          return false
        const bounds = entry.view.getBounds()
        return bounds.width > 0 && bounds.height > 0
      }),
    snapshot,
    target: (tabId) => entryFor(tabId).view.webContents,
    menuTarget(tabId) {
      const entry = entryFor(tabId)
      if (
        activeTabId !== tabId ||
        entry.view.webContents.isDestroyed() ||
        entry.view.webContents.isCrashed()
      )
        throw new Error(BROWSER_ERROR.targetClosed)
      return {
        kind: 'browser',
        tabId,
        instanceId: entry.agentInstanceId,
        navigationId: entry.menuNavigationId,
      }
    },
    externalTabIds: () =>
      [...entries.values()]
        .filter((entry) => !entry.context.agentIsolated)
        .map((entry) => entry.tabId),
    externalTarget: (tabId) => externalEntryFor(tabId).view.webContents,
    agentTarget(tabId) {
      const entry = entryFor(tabId)
      const contents = entry.view.webContents
      const rawUrl = contents.getURL()
      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        throw new Error(BROWSER_ERROR.permissionDenied)
      }
      if (
        entry.context.origin !== null ||
        !browserResourceAllowed({
          url,
          topOrigin: url.origin,
          approvedLocalOrigin: null,
          apiOrigin,
        })
      ) {
        throw new Error(BROWSER_ERROR.permissionDenied)
      }
      return {
        contents,
        origin: url.origin,
        generation: entry.agentGeneration,
        instanceId: entry.agentInstanceId,
        title: contents.getTitle(),
        url: rawUrl,
      }
    },
    agentNavigationTarget(tabId) {
      const entry = entryFor(tabId)
      const contents = entry.view.webContents
      if (
        contents.getURL() === BLANK_PAGE &&
        entry.context.origin === null &&
        !contents.isLoadingMainFrame()
      ) {
        return {
          contents,
          origin: null,
          generation: entry.agentGeneration,
          instanceId: entry.agentInstanceId,
          title: contents.getTitle(),
          url: BLANK_PAGE,
        }
      }
      return this.agentTarget(tabId)
    },
    async createSearchTarget() {
      const target = await createIsolatedTarget(true)
      const entry = entryFor(target.tabId)
      searchOwners.set(target.tabId, entry.context)
      return {
        tabId: target.tabId,
        close: () => {
          searchOwners.delete(target.tabId)
          target.close()
        },
      }
    },
    takeSearchRedirect(tabId) {
      const receipt = searchRedirects.get(tabId)
      searchRedirects.delete(tabId)
      if (
        !receipt ||
        !receipt.settled ||
        receipt.expiresAt <= Date.now() ||
        !currentSearchAttempt(receipt.attempt) ||
        staleAfterClear(receipt.attempt.source.context, receipt.clearEpoch, receipt.profileEpoch)
      )
        return null
      return Object.freeze({ requestedUrl: receipt.attempt.requestedUrl, url: receipt.url })
    },
    async prepareSearchForm(tabId, config, query, signal) {
      const entry = entryFor(tabId)
      if (searchOwners.get(tabId) !== entry.context || entry.searchForm)
        throw new Error(BROWSER_ERROR.permissionDenied)
      entry.searchForm = createSearchFormExecutor({
        tabId,
        target: () => this.agentTarget(tabId),
        attach: () => attachEntry(entryFor(tabId)),
        onFailure: (code) => logSearch('form', { tabId, phase: 'inspection-failed', code }),
        onDiagnostic: (diagnostic) => logSearch('form', { tabId, ...diagnostic }),
        close: () => {
          const current = entries.get(tabId)
          if (current === entry) closeEntry(current)
        },
      })
      return await entry.searchForm.prepare(config, query, signal)
    },
    async executeSearchForm(prepared, validate) {
      const entry = entryFor(prepared.tabId)
      if (searchOwners.get(prepared.tabId) !== entry.context || !entry.searchForm)
        throw new Error(BROWSER_ERROR.permissionDenied)
      await entry.searchForm.execute(prepared, validate)
    },
    async createAgentTarget(sessionId) {
      if (!sessionId) throw new Error(BROWSER_ERROR.targetClosed)
      const target = await createIsolatedTarget()
      const entry = entries.get(target.tabId)
      if (!entry) {
        target.close()
        throw new Error(BROWSER_ERROR.targetClosed)
      }
      agentOwners.set(target.tabId, { sessionId, entry })
      return target
    },
    closeAgentTarget(sessionId, tabId) {
      const owner = agentOwners.get(tabId)
      if (
        disposed ||
        clearing ||
        !owner ||
        owner.sessionId !== sessionId ||
        entries.get(tabId) !== owner.entry
      )
        throw new Error(BROWSER_ERROR.targetClosed)
      closeEntry(owner.entry)
    },
    agentNavigate: (tabId, input, approvedOrigin) => navigate(tabId, input, false, approvedOrigin),
    blockAgentPopups(tabId) {
      const entry = entryFor(tabId)
      const lease = Symbol()
      entry.agentPopupBlocks.add(lease)
      return () => {
        entry.agentPopupBlocks.delete(lease)
      }
    },
    cancelAgentNavigation(tabId) {
      const entry = entries.get(tabId)
      if (!entry || entry.agentNavigationOrigin === null || entry.agentNavigationCancelled) return
      invalidateAgentTarget(entry)
    },
    navigate: (tabId, input) => navigate(tabId, input),
    async dispatch(command) {
      if (disposed) throw new Error(BROWSER_ERROR.targetClosed)
      if (clearing) throw new Error(BROWSER_ERROR.cdpBusy)
      if (command.kind === 'open') {
        await open(command.input)
        return snapshot()
      }
      const entry = entryFor(command.tabId)
      const contents = entry.view.webContents
      switch (command.kind) {
        case 'navigate':
          await navigate(command.tabId, command.input, true)
          break
        case 'select':
          if (activeTabId !== entry.tabId) {
            const previous = activeTabId ? entries.get(activeTabId) : null
            if (previous) {
              previous.menuNavigationId += 1
              previous.page.invalidate()
            }
            entry.menuNavigationId += 1
            entry.page.invalidate()
          }
          activeTabId = entry.tabId
          layout()
          break
        case 'close':
          closeEntry(entry)
          break
        case 'bounds':
          entry.bounds = {
            x: command.x,
            y: command.y,
            width: command.width,
            height: command.height,
          }
          entry.visible = command.visible
          layout()
          break
        case 'back':
          if (contents.navigationHistory.canGoBack()) {
            invalidateAgentTarget(entry)
            contents.navigationHistory.goBack()
          }
          break
        case 'forward':
          if (contents.navigationHistory.canGoForward()) {
            invalidateAgentTarget(entry)
            contents.navigationHistory.goForward()
          }
          break
        case 'reload':
          invalidateAgentTarget(entry)
          contents.reload()
          break
        case 'devtools':
          if (command.open) {
            if (entry.devtoolsWindow || entry.devtoolsOpening || contents.isDevToolsOpened()) break
            entry.devtoolsOpening = true
            entry.cdpStatus = BROWSER_CDP_STATUS.conflict
            publish()
            for (const listener of detachListeners)
              listener(entry.tabId, BROWSER_ERROR.devtoolsConflict)
            if (contents.debugger.isAttached()) contents.debugger.detach()
            const devtoolsWindow = new BrowserWindow({
              ...DEVTOOLS_WINDOW_SIZE,
              show: false,
              webPreferences: {
                session: entry.context.session,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
              },
            })
            entry.devtoolsWindow = devtoolsWindow
            devtoolsWindow.once('closed', () => {
              if (entry.devtoolsWindow !== devtoolsWindow) return
              entry.devtoolsWindow = null
              if (!contents.isDestroyed()) contents.closeDevTools()
              entry.devtoolsOpening = false
              entry.cdpStatus = BROWSER_CDP_STATUS.disabled
              publish()
            })
            contents.setDevToolsWebContents(devtoolsWindow.webContents)
            contents.openDevTools({ mode: 'detach' })
          } else if (entry.devtoolsWindow) entry.devtoolsWindow.destroy()
          else contents.closeDevTools()
          break
      }
      publish()
      return snapshot()
    },
    attach(tabId) {
      return attachEntry(entryFor(tabId))
    },
    attachExternal(tabId) {
      return attachEntry(externalEntryFor(tabId))
    },
    detach(tabId) {
      const contents = entryFor(tabId).view.webContents
      if (contents.debugger.isAttached()) contents.debugger.detach()
    },
    detachAgent(tabId) {
      const entry = entryFor(tabId)
      const debuggerSession = entry.view.webContents.debugger
      if (!debuggerSession.isAttached()) return
      entry.agentDetachPending = true
      try {
        debuggerSession.detach()
      } catch (error) {
        entry.agentDetachPending = false
        throw error
      }
    },
    onDebuggerDetach(listener) {
      detachListeners.add(listener)
      return () => {
        detachListeners.delete(listener)
      }
    },
    onAgentTargetInvalidated(listener) {
      invalidationListeners.add(listener)
      return () => {
        invalidationListeners.delete(listener)
      }
    },
    async setApiBase(base) {
      const nextOrigin = originOf(base)
      if (apiOrigin === nextOrigin) return
      apiOrigin = nextOrigin
      for (const entry of [...entries.values()])
        if (entry.context.origin !== null) closeEntry(entry)
      await Promise.all([
        ...pendingDisposals,
        ...[...contexts]
          .filter((context) => context.origin !== null)
          .map((context) => context.close()),
      ])
      publish()
    },
    queryHistory: (query) => history.query(query),
    historyAgent,
    downloadSettings: () => downloads.snapshot(),
    async chooseDownloadDirectory() {
      const selected = await dialog.showOpenDialog(window, {
        defaultPath: downloads.snapshot().directory,
        properties: ['openDirectory', 'createDirectory'],
      })
      return selected.canceled || !selected.filePaths[0]
        ? downloads.snapshot()
        : downloads.select(selected.filePaths[0])
    },
    resetDownloadDirectory: () => downloads.reset(),
    setAskEveryTime: (enabled) => downloads.setAskEveryTime(enabled),
    async deleteHistory(id) {
      if (clearing) throw new Error(BROWSER_ERROR.cdpBusy)
      clearing = true
      historyClearEpoch += 1
      try {
        await historyAgent.beginClear()
        return history.delete(id)
      } finally {
        historyAgent.endClear()
        clearing = false
      }
    },
    async reopenHistory(id) {
      const visit = history.get(id)
      if (!visit) throw new Error(BROWSER_ERROR.targetClosed)
      await open(visit.url)
      return snapshot()
    },
    async clearData(request, stopAutomation) {
      if (request.kind === 'clear-site-data') parseBrowserDataRequest(request)
      if (clearing) throw new Error(BROWSER_ERROR.cdpBusy)
      clearing = true
      if (
        request.kind === 'clear-history' ||
        request.kind === 'clear-all' ||
        request.kind === 'clear-site-data' ||
        (request.kind === 'clear-selected' && request.types.includes('history'))
      )
        historyClearEpoch += 1
      try {
        await historyAgent.beginClear()
        if (request.kind === 'clear-history') return history.clear({ since: request.since })
        const selected = request.kind === 'clear-selected' ? request.types : null
        const profileOnly = selected !== null || request.kind === 'clear-site-data'
        const clearHistory =
          request.kind === 'clear-all' ||
          request.kind === 'clear-site-data' ||
          selected?.includes('history') === true
        const dataTypes =
          selected?.flatMap((type) => (type === 'history' ? [] : SELECTED_DATA_TYPES[type])) ??
          SITE_DATA_TYPES
        if (dataTypes.length === 0) return history.clear({})
        clearingProfileOnly = profileOnly
        if (profileOnly) profileClearEpoch += 1
        else clearEpoch += 1
        for (const entry of entries.values())
          if (!profileOnly || entry.context.session === browserSession) invalidateAgentTarget(entry)
        try {
          await stopAutomation?.()
          const origin = request.kind === 'clear-site-data' ? request.origin : undefined
          const affected = [...entries.values()].filter(
            (entry) => !profileOnly || entry.context.session === browserSession
          )
          const destroyed = affected.map(
            (entry) =>
              new Promise<void>((resolve) => {
                const contents = entry.view.webContents
                if (contents.isDestroyed()) resolve()
                else contents.once('destroyed', () => resolve())
              })
          )
          for (const entry of affected) closeEntry(entry)
          await Promise.all(destroyed)
          await Promise.all([...pendingDisposals])
          await browserSession.closeAllConnections()
          await browserSession.clearData({ dataTypes, ...(origin ? { origins: [origin] } : {}) })
          return clearHistory ? history.clear(origin ? { origin } : {}) : 0
        } catch (error) {
          throw new Error(BROWSER_ERROR.partialClear, { cause: error })
        }
      } finally {
        historyAgent.endClear()
        clearing = false
        clearingProfileOnly = false
      }
    },
    dispose,
  }
}
