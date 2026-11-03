export const BROWSER_COMMAND_CHANNEL = 'scholarseed:browser-command'
export const BROWSER_SNAPSHOT_CHANNEL = 'scholarseed:browser-snapshot'
export const BROWSER_PAGE_CHANNEL = 'scholarseed:browser-page'
export const BROWSER_FIND_CHANNEL = 'scholarseed:browser-find'
export const BROWSER_REVEAL_CHANNEL = 'scholarseed:browser-reveal'
export interface BrowserReveal { sessionId: string; target: BrowserPageTarget }
export interface BrowserAgentContinuity { instanceId: string; previousGeneration: number; generation: number }
export const PAGE_ZOOM_FACTORS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const
export const PAGE_ZOOM_DEFAULT = 1
const PAGE_ZOOM_CONVERSION_EPSILON = Number.EPSILON * 8
export function pageZoomSteps(factor: number): { lower: number | undefined; higher: number | undefined; reset: boolean } {
  const step = PAGE_ZOOM_FACTORS.find(candidate => Math.abs(candidate - factor) <= PAGE_ZOOM_CONVERSION_EPSILON * Math.max(1, Math.abs(factor))) ?? factor
  return { lower: [...PAGE_ZOOM_FACTORS].reverse().find(candidate => candidate < step),
    higher: PAGE_ZOOM_FACTORS.find(candidate => candidate > step), reset: step !== PAGE_ZOOM_DEFAULT }
}
export const PAGE_LIMIT = { text: 4096, id: 128 } as const
export interface BrowserPageTarget { tabId: string; instanceId: string; navigationId: number }
export interface FindQuery { text: string; direction: 'forward' | 'backward'; querySequence: number }
export interface FindState { querySequence: number; requestId: number; phase: 'empty' | 'searching' | 'ready'; ordinal: number; count: number; final: boolean }
export type PrintResult = { status: 'success' | 'canceled' } | { status: 'failed'; error: 'print_failed' }
export type PageRequest = { kind: 'target'; tabId: string }
  | { kind: 'zoom'; target: BrowserPageTarget; factor: number }
  | { kind: 'print'; target: BrowserPageTarget }
  | { kind: 'devtools'; target: BrowserPageTarget; open: boolean }
export type PageReply = { ok: true; target: BrowserPageTarget; print?: PrintResult } | { ok: false; error: BrowserErrorCode }

export function parsePageTarget(value: unknown): BrowserPageTarget {
  if (!commandObject(value) || !hasOnlyKeys(value, ['tabId', 'instanceId', 'navigationId'])
    || ![value.tabId, value.instanceId].every(value => typeof value === 'string' && value.length > 0 && value.length <= PAGE_LIMIT.id)
    || !Number.isSafeInteger(value.navigationId) || Number(value.navigationId) < 1) throw new Error(BROWSER_ERROR.invalidCommand)
  return value as unknown as BrowserPageTarget
}
export function samePageTarget(left: BrowserPageTarget, right: BrowserPageTarget): boolean {
  return left.tabId === right.tabId && left.instanceId === right.instanceId && left.navigationId === right.navigationId
}
export function parseFindQuery(value: unknown): FindQuery {
  if (!commandObject(value) || !hasOnlyKeys(value, ['text', 'direction', 'querySequence'])
    || typeof value.text !== 'string' || value.text.length > PAGE_LIMIT.text
    || !['forward', 'backward'].includes(String(value.direction))
    || !Number.isSafeInteger(value.querySequence) || Number(value.querySequence) < 1) throw new Error(BROWSER_ERROR.invalidCommand)
  return value as unknown as FindQuery
}
export function parsePageRequest(value: unknown): PageRequest {
  if (!commandObject(value)) throw new Error(BROWSER_ERROR.invalidCommand)
  if (value.kind === 'target' && hasOnlyKeys(value, ['kind', 'tabId']) && validTabId(value.tabId) && value.tabId.length <= PAGE_LIMIT.id) return value as PageRequest
  const target = parsePageTarget(value.target)
  if (value.kind === 'zoom' && hasOnlyKeys(value, ['kind', 'target', 'factor']) && PAGE_ZOOM_FACTORS.some(factor => factor === value.factor)) return { kind: 'zoom', target, factor: Number(value.factor) }
  if (value.kind === 'print' && hasOnlyKeys(value, ['kind', 'target'])) return { kind: 'print', target }
  if (value.kind === 'devtools' && hasOnlyKeys(value, ['kind', 'target', 'open']) && typeof value.open === 'boolean') return { kind: 'devtools', target, open: value.open }
  throw new Error(BROWSER_ERROR.invalidCommand)
}
export const BROWSER_HISTORY_CHANNEL = 'scholarseed:browser-history'
export const BROWSER_DATA_CHANNEL = 'scholarseed:browser-data'
export const BROWSER_DOWNLOAD_CHANNEL = 'scholarseed:browser-download'
export const BROWSER_POLICY_CHANNEL = 'scholarseed:browser-agent-policy'
export const BROWSER_FRAME_CHANNEL = 'scholarseed:browser-frame'
export const BROWSER_FRAME_ACK_CHANNEL = 'scholarseed:browser-frame-ack'
export const BROWSER_FRAME_RESIZE_CHANNEL = 'scholarseed:browser-frame-resize'
export const BROWSER_FRAME_INPUT_CHANNEL = 'scholarseed:browser-frame-input'

export interface BrowserFrame {
  tabId: string
  sequence: number
  data: string
  format: 'jpeg' | 'png'
  width: number
  height: number
}
export type BrowserFrameInput =
  | { kind: 'mouse'; type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'; x: number; y: number; button: 'none' | 'left' | 'middle' | 'right'; clickCount?: number }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; type: 'keyDown' | 'keyUp' | 'char'; key: string; code: string; windowsVirtualKeyCode: number; modifiers?: number }
  | { kind: 'text'; text: string }
  | { kind: 'composition'; phase: 'begin' | 'update'; text: string; selectionStart: number; selectionEnd: number }
  | { kind: 'composition'; phase: 'commit'; text: string }
  | { kind: 'composition'; phase: 'cancel' }
export type BrowserFrameReply = { ok: true } | { ok: false; error: BrowserErrorCode }
export interface BrowserFrameBridge {
  subscribe(callback: (frame: BrowserFrame) => void): () => void
  acknowledge(tabId: string, sequence: number): Promise<BrowserFrameReply>
  resize(tabId: string, width: number, height: number): Promise<BrowserFrameReply>
  input(tabId: string, input: BrowserFrameInput): Promise<BrowserFrameReply>
}

export const BROWSER_ERROR = {
  desktopBridgeUnavailable: 'desktop_bridge_unavailable',
  operationFailed: 'operation_failed',
  partialClear: 'partial_clear',
  invalidUrl: 'invalid_url',
  invalidCommand: 'invalid_command',
  invalidSender: 'invalid_sender',
  navigationFailed: 'navigation_failed',
  permissionDenied: 'permission_denied',
  cdpDisabled: 'cdp_disabled',
  cdpBusy: 'cdp_busy',
  printBusy: 'print_busy',
  devtoolsConflict: 'devtools_conflict',
  targetClosed: 'target_closed',
  unsupportedCdpMethod: 'unsupported_cdp_method',
  automaticDownloadUnavailable: 'automatic_download_unavailable',
  policyUnavailable: 'browser_policy_io_unavailable',
  policyConflict: 'browser_policy_revision_conflict',
  policyInvalid: 'browser_policy_invalid',
  historyDeliveryPending: 'browser_history_delivery_pending'
} as const

export const BROWSER_CDP_STATUS = {
  disabled: 'disabled',
  listening: 'listening',
  connected: 'connected',
  conflict: 'devtools_conflict'
} as const

export type BrowserErrorCode = typeof BROWSER_ERROR[keyof typeof BROWSER_ERROR]
export type BrowserCdpStatus = typeof BROWSER_CDP_STATUS[keyof typeof BROWSER_CDP_STATUS]

export type BrowserCommand =
  | { kind: 'open'; input?: string }
  | { kind: 'navigate'; tabId: string; input: string }
  | { kind: 'select' | 'back' | 'forward' | 'reload' | 'close'; tabId: string }
  | { kind: 'bounds'; tabId: string; visible: boolean; x: number; y: number; width: number; height: number }
  | { kind: 'devtools'; tabId: string; open: boolean }
  | { kind: 'automation'; enabled: boolean }
  | { kind: 'copy-endpoint' }

export type BrowserPageCommand = Exclude<BrowserCommand, { kind: 'automation' | 'copy-endpoint' }>

export interface BrowserTabSnapshot {
  tabId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  navigationError: BrowserErrorCode | null
  devtoolsOpen: boolean
  zoomFactor?: number
  cdpStatus: BrowserCdpStatus
}

export interface BrowserSnapshot {
  tabs: BrowserTabSnapshot[]
  activeTabId: string | null
  engine?: 'electron-view' | 'chromium-sidecar'
  automation: {
    enabled: boolean
    port: number | null
  }
}

export type BrowserReply = { ok: true; snapshot: BrowserSnapshot } | { ok: false; error: BrowserErrorCode }

export interface BrowserBridge {
  subscribeReveal?(callback: (request: BrowserReveal) => void): () => void
  page?(request: PageRequest): Promise<PageReply>
  subscribeFind?(callback: (target: BrowserPageTarget) => void): () => void
  snapshot(): Promise<BrowserReply>
  dispatch(command: BrowserCommand): Promise<BrowserReply>
  history(request: BrowserHistoryRequest): Promise<BrowserHistoryReply>
  clearData(request: BrowserDataRequest): Promise<BrowserDataReply>
  downloads(request: BrowserDownloadRequest): Promise<BrowserDownloadReply>
  policy(request: BrowserPolicyRequest): Promise<BrowserPolicyReply>
  subscribe(callback: (snapshot: BrowserSnapshot) => void): () => void
  frames?: BrowserFrameBridge
}

export type BrowserPolicyDecision = 'ask' | 'allow' | 'block'
export type BrowserPolicyAction = 'read' | 'interact'
export interface BrowserPolicySite { origin: string; read: BrowserPolicyDecision; interact: BrowserPolicyDecision }
export interface BrowserPolicySnapshot { revision: number; agentBrowserUseEnabled: boolean; sites: BrowserPolicySite[] }
export type BrowserPolicyRequest = { kind: 'read' }
  | { kind: 'set-agent-use'; enabled: boolean }
  | { kind: 'set'; origin: string; action: BrowserPolicyAction; decision: BrowserPolicyDecision }
  | { kind: 'remove'; origin: string }
export type BrowserPolicyReply = { ok: true; policy: BrowserPolicySnapshot } | { ok: false; error: BrowserErrorCode }

export function parseBrowserPolicyRequest(value: unknown): BrowserPolicyRequest {
  if (!commandObject(value)) throw new Error(BROWSER_ERROR.invalidCommand)
  if (value.kind === 'read' && hasOnlyKeys(value, ['kind'])) return { kind: 'read' }
  if (value.kind === 'set-agent-use' && hasOnlyKeys(value, ['kind', 'enabled']) && typeof value.enabled === 'boolean') return { kind: 'set-agent-use', enabled: value.enabled }
  if ((value.kind === 'set' || value.kind === 'remove') && typeof value.origin === 'string'
    && value.origin.length <= 2048) {
    try {
      const origin = new URL(value.origin)
      if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.origin) throw new Error()
    } catch { throw new Error(BROWSER_ERROR.invalidCommand) }
    if (value.kind === 'remove' && hasOnlyKeys(value, ['kind', 'origin'])) return value as BrowserPolicyRequest
    if (value.kind === 'set' && hasOnlyKeys(value, ['kind', 'origin', 'action', 'decision'])
      && (value.action === 'read' || value.action === 'interact')
      && (value.decision === 'ask' || value.decision === 'allow' || value.decision === 'block')) return value as BrowserPolicyRequest
  }
  throw new Error(BROWSER_ERROR.invalidCommand)
}

export interface BrowserDownloadSettings { directory: string; isDefault: boolean; directoryAvailable: boolean; askEveryTime: boolean; automaticAvailable: boolean }
export type BrowserDownloadRequest = { kind: 'read' | 'choose-directory' | 'reset-directory' }
  | { kind: 'set-ask-every-time'; enabled: boolean }
export type BrowserDownloadReply = { ok: true; settings: BrowserDownloadSettings }
  | { ok: false; error: BrowserErrorCode }

export function parseBrowserDownloadRequest(value: unknown): BrowserDownloadRequest {
  if (commandObject(value) && hasOnlyKeys(value, ['kind'])
    && (value.kind === 'read' || value.kind === 'choose-directory' || value.kind === 'reset-directory')) return value as BrowserDownloadRequest
  if (commandObject(value) && value.kind === 'set-ask-every-time' && hasOnlyKeys(value, ['kind', 'enabled'])
    && typeof value.enabled === 'boolean') return value as BrowserDownloadRequest
  throw new Error(BROWSER_ERROR.invalidCommand)
}

export interface BrowserVisit {
  id: string
  url: string
  title: string
  visitedAt: number
}

export interface BrowserHistoryQuery { search?: string; offset: number; limit: number }
export interface BrowserHistoryPage { items: BrowserVisit[]; total: number }
export type BrowserHistoryRequest = { kind: 'query'; query: BrowserHistoryQuery }
  | { kind: 'delete' | 'reopen'; id: string }
export type BrowserHistoryReply = { ok: true; page?: BrowserHistoryPage; snapshot?: BrowserSnapshot; deleted?: boolean }
  | { ok: false; error: BrowserErrorCode }
export type BrowserDataRequest = { kind: 'clear-history'; since?: number }
  | { kind: 'clear-site-data'; origin: string }
  | { kind: 'clear-selected'; types: BrowserDataType[] }
  | { kind: 'clear-all' }
export type BrowserDataReply = { ok: true; deleted: number } | { ok: false; error: BrowserErrorCode }
export type BrowserDataType = 'history' | 'cookies' | 'storage' | 'cache'

const BROWSER_DATA_TYPES = new Set<BrowserDataType>(['history', 'cookies', 'storage', 'cache'])

const HISTORY_QUERY_LIMIT = 50
const HISTORY_SEARCH_LIMIT = 256

export function parseBrowserHistoryRequest(value: unknown): BrowserHistoryRequest {
  if (!commandObject(value)) throw new Error(BROWSER_ERROR.invalidCommand)
  if (value.kind === 'query' && hasOnlyKeys(value, ['kind', 'query']) && commandObject(value.query)) {
    const query = value.query
    if (hasOnlyKeys(query, ['search', 'offset', 'limit'])
      && (query.search === undefined || typeof query.search === 'string' && query.search.length <= HISTORY_SEARCH_LIMIT)
      && Number.isSafeInteger(query.offset) && Number(query.offset) >= 0
      && Number.isSafeInteger(query.limit) && Number(query.limit) > 0 && Number(query.limit) <= HISTORY_QUERY_LIMIT) return value as BrowserHistoryRequest
  }
  if ((value.kind === 'delete' || value.kind === 'reopen') && hasOnlyKeys(value, ['kind', 'id'])
    && typeof value.id === 'string' && /^[\da-f]{8}-[\da-f-]{27,}$/i.test(value.id)) return value as BrowserHistoryRequest
  throw new Error(BROWSER_ERROR.invalidCommand)
}

export function parseBrowserDataRequest(value: unknown): BrowserDataRequest {
  if (!commandObject(value)) throw new Error(BROWSER_ERROR.invalidCommand)
  if (value.kind === 'clear-all' && hasOnlyKeys(value, ['kind'])) return value as BrowserDataRequest
  if (value.kind === 'clear-selected' && hasOnlyKeys(value, ['kind', 'types']) && Array.isArray(value.types)
    && value.types.length > 0 && value.types.length <= BROWSER_DATA_TYPES.size
    && value.types.every(type => BROWSER_DATA_TYPES.has(type))
    && new Set(value.types).size === value.types.length) return value as BrowserDataRequest
  if (value.kind === 'clear-history' && hasOnlyKeys(value, ['kind', 'since'])
    && (value.since === undefined || Number.isSafeInteger(value.since) && Number(value.since) >= 0)) return value as BrowserDataRequest
  if (value.kind === 'clear-site-data' && hasOnlyKeys(value, ['kind', 'origin'])) {
    if (typeof value.origin === 'string') {
      try {
        const url = new URL(value.origin)
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value.origin) return value as BrowserDataRequest
      } catch {}
    }
  }
  throw new Error(BROWSER_ERROR.invalidCommand)
}

function commandObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function validTabId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validInput(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseBrowserCommand(value: unknown): BrowserCommand {
  if (!commandObject(value)) throw new Error(BROWSER_ERROR.invalidCommand)

  const commonKeys = ['kind', 'tabId']
  switch (value.kind) {
    case 'open':
      if (hasOnlyKeys(value, ['kind', 'input']) && (value.input === undefined || validInput(value.input))) return value as BrowserCommand
      break
    case 'navigate':
      if (hasOnlyKeys(value, [...commonKeys, 'input']) && validTabId(value.tabId) && validInput(value.input)) return value as BrowserCommand
      break
    case 'select':
    case 'back':
    case 'forward':
    case 'reload':
    case 'close':
      if (hasOnlyKeys(value, commonKeys) && validTabId(value.tabId)) return value as BrowserCommand
      break
    case 'bounds':
      if (hasOnlyKeys(value, [...commonKeys, 'visible', 'x', 'y', 'width', 'height'])
        && validTabId(value.tabId) && typeof value.visible === 'boolean'
        && ['x', 'y', 'width', 'height'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
        && (value.width as number) >= 0 && (value.height as number) >= 0) return value as BrowserCommand
      break
    case 'devtools':
      if (hasOnlyKeys(value, [...commonKeys, 'open']) && validTabId(value.tabId) && typeof value.open === 'boolean') return value as BrowserCommand
      break
    case 'automation':
      if (hasOnlyKeys(value, ['kind', 'enabled']) && typeof value.enabled === 'boolean') return value as BrowserCommand
      break
    case 'copy-endpoint':
      if (hasOnlyKeys(value, ['kind'])) return value as BrowserCommand
      break
  }
  throw new Error(BROWSER_ERROR.invalidCommand)
}
