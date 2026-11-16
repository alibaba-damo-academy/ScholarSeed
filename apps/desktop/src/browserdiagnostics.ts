import { BROWSER_ERROR } from './browser.ts'
import { MENU_ERROR } from './menu.ts'

export const BROWSER_DIAGNOSTIC_PREFIX = '[browser-failure]'
const DIAGNOSTIC_WINDOW_MS = 10_000
const DIAGNOSTIC_BUCKET_LIMIT = 64
const ERROR_LOCATION_LIMIT = 5
const ERROR_STACK_LIMIT = 8192
const BUNDLED_ERROR_FILE =
  /^(?:index|Browser|browser|browseripc|overlay|viewport|tooltip|browserframe|page|menuhost)-[\w-]{6,64}\.js$/
const ERROR_FILES = new Set([
  'index.js',
  'index.ts',
  'browser.ts',
  'browseripc.ts',
  'overlay.ts',
  'viewport.ts',
  'tooltip.ts',
  'Browser.tsx',
  'browserframe.ts',
  'page.ts',
  'menuhost.ts',
])
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
])
const ERROR_CODES = new Set<string>([
  ...Object.values(BROWSER_ERROR),
  ...Object.values(MENU_ERROR),
  'ERR_ABORTED',
  'ERR_FAILED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_TIMED_OUT',
  'ERR_CERT_AUTHORITY_INVALID',
  'ENOENT',
  'EACCES',
  'EPERM',
])
const OPERATIONS = new Set([
  'unknown',
  'snapshot',
  'target',
  'open',
  'navigate',
  'select',
  'back',
  'forward',
  'reload',
  'close',
  'bounds',
  'devtools',
  'automation',
  'copy-endpoint',
  'zoom',
  'print',
  'query',
  'delete',
  'reopen',
  'read',
  'clear-history',
  'clear-site-data',
  'clear-selected',
  'clear-all',
  'choose-directory',
  'reset-directory',
  'set-ask-every-time',
  'set-agent-use',
  'set',
  'remove',
  'seed',
  'publish',
  'dismiss',
  'dismiss-sync',
  'focus',
  'paint',
  'update',
  'refocus',
  'timeout',
  'crash',
  'invalid',
  'result',
  'copy',
  'find',
  'external-open',
  'resize',
  'input',
  'acknowledge',
  'decode',
])

export interface BrowserFailureContext {
  source:
    | 'ipc'
    | 'command'
    | 'snapshot'
    | 'menu'
    | 'find-menu'
    | 'viewport'
    | 'suggestions'
    | 'tooltip'
    | 'overlay'
    | 'frame'
    | 'external-open'
  operation: string
  phase?: 'reply' | 'exception' | 'event'
  boundary?: 'main' | 'renderer'
  channel?: 'command' | 'page' | 'history' | 'data' | 'downloads' | 'policy'
  tabId?: string
  revision?: number
  stale?: boolean
}

export function createBrowserFailureReporter(
  sink: (line: string) => void = (line) => console.info(line),
  now: () => number = Date.now
) {
  const buckets = new Map<string, { timestamp: number; suppressedCount: number }>()
  let attempt = 0
  return (context: BrowserFailureContext, error: unknown): void => {
    try {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : ''
      const nativeCode = error instanceof Error && 'code' in error ? error.code : undefined
      const errorCode = ERROR_CODES.has(message)
        ? message
        : typeof nativeCode === 'string' && ERROR_CODES.has(nativeCode)
          ? nativeCode
          : BROWSER_ERROR.operationFailed
      const reason = /(?:object|webcontents).*destroyed/i.test(message)
        ? 'target-destroyed'
        : /no handler registered/i.test(message)
          ? 'ipc-handler-unavailable'
          : 'unclassified'
      const record = {
        source: context.source,
        boundary: context.boundary ?? 'renderer',
        channel: context.channel ?? null,
        operation: OPERATIONS.has(context.operation) ? context.operation : 'unknown',
        phase: context.phase ?? 'exception',
        tabId: context.tabId && UUID.test(context.tabId) ? context.tabId : null,
        revision: Number.isSafeInteger(context.revision) ? context.revision : null,
        stale: context.stale ?? false,
        errorName: error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : 'unknown',
        errorCode,
        errorLocations:
          error instanceof Error
            ? (error.stack ?? '')
                .slice(0, ERROR_STACK_LIMIT)
                .split('\n')
                .slice(1)
                .flatMap((line) => {
                  const location = /[/\\]([\w.-]+\.(?:tsx?|js))(?:\?[^\s)]*)?:(\d+):(\d+)/.exec(
                    line
                  )
                  return location &&
                    (ERROR_FILES.has(location[1]) || BUNDLED_ERROR_FILE.test(location[1]))
                    ? [`${location[1]}:${location[2]}:${location[3]}`]
                    : []
                })
                .slice(0, ERROR_LOCATION_LIMIT)
            : [],
        reason,
      }
      const timestamp = now()
      const key = JSON.stringify({ ...record, revision: null, errorLocations: [] })
      const previous = buckets.get(key)
      if (previous && timestamp - previous.timestamp < DIAGNOSTIC_WINDOW_MS) {
        previous.suppressedCount += 1
        return
      }
      if (buckets.size >= DIAGNOSTIC_BUCKET_LIMIT) buckets.delete(buckets.keys().next().value!)
      buckets.set(key, { timestamp, suppressedCount: 0 })
      sink(
        `${BROWSER_DIAGNOSTIC_PREFIX} ${JSON.stringify({
          ...record,
          attempt: ++attempt,
          suppressedCount: previous?.suppressedCount ?? 0,
        })}`
      )
    } catch {
      return
    }
  }
}

export const reportBrowserFailure = createBrowserFailureReporter()
