import {
  API_DIAGNOSTIC_PREFIX,
  REQUEST_TIMEOUT_ERROR_NAME,
  MODEL_PROFILES_PATH,
  MODEL_PROVIDERS_PATH,
  AUTH_ME_PATH,
  CONTENT_OPERATIONS_PATH,
  SESSION_CATALOG_PATH,
} from '../../../../requests.ts'

export const API_DIAGNOSTIC_WINDOW_MS = 10_000
export const API_DIAGNOSTIC_BUCKET_LIMIT = 64
const HTTP_FAILURE = 'http-error'
const NETWORK_FAILURE = 'network-error'
const ABORT_FAILURE = 'aborted'
const TIMEOUT_FAILURE = 'timeout'
const PARSE_FAILURE = 'invalid-json'
const READ_FAILURE = 'response-read-error'
const UNKNOWN_FAILURE = 'request-error'
const ENCODE_FAILURE = 'request-serialization-error'
const SCHEMA_FAILURE = 'invalid-schema'
const PROJECTION_FAILURE = 'client-projection-error'
const UNKNOWN_ROUTE = '/api/:resource'
// Privacy allowlist, not a backend inventory: never retain dynamic paths or query strings.
const ROUTES = [MODEL_PROFILES_PATH, MODEL_PROVIDERS_PATH, AUTH_ME_PATH, CONTENT_OPERATIONS_PATH]
// Keep catalog polling distinct from per-session operations.
const EXACT_ROUTES = [SESSION_CATALOG_PATH]
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
type FailurePhase = 'http' | 'transport' | 'decode' | 'encode' | 'schema' | 'projection'

interface FailureRecord {
  route: string
  method: string
  status: number | null
  reason: string
  elapsedMs: number
  suppressedCount: number
}
interface FailureBucket {
  record: FailureRecord
  timer: ReturnType<typeof setTimeout>
}

function classifyFailure(phase: FailurePhase, error: unknown): string {
  if (phase === 'schema') return SCHEMA_FAILURE
  if (phase === 'projection') return PROJECTION_FAILURE
  if (phase === 'encode') return ENCODE_FAILURE
  const errorName = error instanceof Error ? error.name : ''
  if (phase === 'http') return HTTP_FAILURE
  if (phase === 'decode') return errorName === 'SyntaxError' ? PARSE_FAILURE : READ_FAILURE
  if (errorName === REQUEST_TIMEOUT_ERROR_NAME) return TIMEOUT_FAILURE
  if (errorName === 'AbortError') return ABORT_FAILURE
  if (errorName === 'TypeError') return NETWORK_FAILURE
  return UNKNOWN_FAILURE
}

export class ApiDiagnostics {
  private readonly buckets = new Map<string, FailureBucket>()

  constructor(
    private readonly sink: (record: FailureRecord) => void = (record) =>
      console.info(API_DIAGNOSTIC_PREFIX, JSON.stringify(record))
  ) {}

  report(
    path: string,
    method: string,
    status: number | null,
    startedAt: number,
    phase: FailurePhase,
    error?: unknown
  ): void {
    const route =
      EXACT_ROUTES.find((candidate) => path === candidate || path.startsWith(`${candidate}?`)) ??
      ROUTES.find(
        (candidate) =>
          path === candidate || path.startsWith(`${candidate}?`) || path.startsWith(`${candidate}/`)
      ) ??
      UNKNOWN_ROUTE
    const normalizedMethod = method.toUpperCase()
    const record: FailureRecord = {
      route,
      method: METHODS.includes(normalizedMethod) ? normalizedMethod : 'OTHER',
      status,
      reason: classifyFailure(phase, error),
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      suppressedCount: 0,
    }
    const key = JSON.stringify([record.route, record.method, record.status, record.reason])
    const existing = this.buckets.get(key)
    if (existing) {
      existing.record.elapsedMs = Math.max(existing.record.elapsedMs, record.elapsedMs)
      existing.record.suppressedCount += 1
      return
    }
    if (this.buckets.size >= API_DIAGNOSTIC_BUCKET_LIMIT) {
      const oldest = this.buckets.keys().next().value
      if (oldest !== undefined) this.finish(oldest)
    }
    this.buckets.set(key, {
      record,
      timer: setTimeout(() => this.finish(key), API_DIAGNOSTIC_WINDOW_MS),
    })
    this.emit(record)
  }

  flush(): void {
    for (const key of [...this.buckets.keys()]) this.finish(key)
  }

  private finish(key: string): void {
    const bucket = this.buckets.get(key)
    if (!bucket) return
    clearTimeout(bucket.timer)
    this.buckets.delete(key)
    if (bucket.record.suppressedCount > 0) this.emit(bucket.record)
  }

  private emit(record: FailureRecord): void {
    try {
      this.sink({ ...record })
    } catch {
      // Diagnostic sink failures must not change request results or timer behavior.
    }
  }
}

const diagnostics = new ApiDiagnostics()
export const reportApiFailure = diagnostics.report.bind(diagnostics)
export const flushApiDiagnostics = diagnostics.flush.bind(diagnostics)
