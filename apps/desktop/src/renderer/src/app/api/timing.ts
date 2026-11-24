import {
  API_DIAGNOSTIC_HEADER,
  API_REQUEST_ID_HEADER,
  HISTORY_PATH_PREFIX,
  HTTP_LATENCY_DIAGNOSTIC_PREFIX,
  SESSION_CATALOG_PATH,
  isRequestDiagnosticId,
  catalogDiagnosticContext,
} from '../../../../requests.ts'
import { captureCatalogResource, type CatalogResourceCapture } from './resources.ts'

const ERROR_NAMES = new Set(['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'Error'])
export type HistoryCaller =
  | 'transcript'
  | 'resume'
  | 'startup_resume'
  | 'resume_fallback'
  | 'archive'
  | 'archived_task'
  | 'literature'
const HISTORY_ROUTE = `${HISTORY_PATH_PREFIX}{session_id}`
const responseTimings = new WeakMap<Response, RequestTiming>()
type TimingEvent =
  | 'fetch_started'
  | 'headers_received'
  | 'fetch_failed'
  | 'body_started'
  | 'body_decoded'
  | 'body_failed'
  | 'catalog_ready'
  | 'catalog_failed'
  | 'resource_timing'

type TimingDetails = Record<string, unknown>

class RequestTiming {
  private serverRequestId: string | null = null
  private readonly startedAt = performance.now()
  private headersAt: number | undefined
  private bodyAt: number | undefined
  private readonly stages: Record<string, unknown>[] = []
  private resource: CatalogResourceCapture | undefined
  private resourceAttempted = false

  constructor(
    readonly identifier: string,
    readonly timeoutMs: number | undefined,
    private readonly path: string,
    private readonly url: string,
    private readonly historyCaller?: HistoryCaller
  ) {}

  fetch(transport: () => Promise<Response>): Promise<Response> {
    this.resourceAttempted = true
    this.resource = captureCatalogResource(this.url, (details) =>
      this.record('resource_timing', null, undefined, details)
    )
    this.resource?.begin()
    try {
      return transport()
    } finally {
      this.resource?.dispatched()
    }
  }

  record(
    event: TimingEvent,
    status: number | null = null,
    error?: unknown,
    details: TimingDetails = {}
  ): void {
    const now = performance.now()
    if (event === 'headers_received') this.headersAt = now
    if (event === 'body_started') this.bodyAt = now
    if (
      event === 'fetch_failed' ||
      event === 'body_failed' ||
      event === 'body_decoded' ||
      (event === 'headers_received' && status !== null && (status < 200 || status >= 300))
    )
      this.resource?.finish()
    try {
      const point = {
        layer: 'renderer',
        event,
        client_request_id: this.identifier,
        route: this.historyCaller ? HISTORY_ROUTE : SESSION_CATALOG_PATH,
        method: 'GET',
        timestamp_ms: Date.now(),
        time_origin_ms: performance.timeOrigin,
        elapsed_ms: now - this.startedAt,
        timeout_ms: this.timeoutMs ?? null,
        status,
        ...(this.historyCaller
          ? { caller: this.historyCaller, server_request_id: this.serverRequestId }
          : { catalog: catalogDiagnosticContext(this.path) }),
        resource_capture_enabled: this.resourceAttempted ? this.resource !== undefined : null,
        ...(this.headersAt !== undefined ? { after_headers_ms: now - this.headersAt } : {}),
        ...(this.bodyAt !== undefined ? { body_elapsed_ms: now - this.bodyAt } : {}),
        ...details,
        ...(error !== undefined
          ? {
              error_type:
                error instanceof Error && ERROR_NAMES.has(error.name) ? error.name : 'OtherError',
            }
          : {}),
      }
      this.stages.push(point)
      const terminal =
        event === 'fetch_failed' ||
        event === 'body_failed' ||
        event === 'body_decoded' ||
        event === 'catalog_ready' ||
        event === 'catalog_failed' ||
        event === 'resource_timing'
      const httpFailure =
        event === 'headers_received' && status !== null && (status < 200 || status >= 300)
      // Emit both milestones even if the history request or its body never settles.
      const historyProgress =
        this.historyCaller && (event === 'fetch_started' || event === 'headers_received')
      if (!terminal && !httpFailure && !historyProgress) return
      let stages = this.stages
      if (!this.historyCaller) stages = this.stages.splice(0)
      else if (historyProgress && !httpFailure) stages = [point]
      console.info(HTTP_LATENCY_DIAGNOSTIC_PREFIX, JSON.stringify({ ...point, stages }))
    } catch {}
  }

  headers(response: Response): void {
    if (this.historyCaller) {
      const id = response.headers.get(API_REQUEST_ID_HEADER)
      if (isRequestDiagnosticId(id)) this.serverRequestId = id
    }
    responseTimings.set(response, this)
    this.record('headers_received', response.status)
  }
}

export function startRequestTiming(
  path: string,
  method: string,
  timeoutMs: number | undefined,
  headers: Headers,
  url: string,
  historyCaller?: HistoryCaller
): RequestTiming | undefined {
  if (method !== 'GET') return undefined
  const pathname = path.split('?')[0]
  const isHistory =
    pathname.startsWith(HISTORY_PATH_PREFIX) &&
    /^[^/]+$/.test(pathname.slice(HISTORY_PATH_PREFIX.length))
  const caller = isHistory ? historyCaller : undefined
  if (!caller && pathname !== SESSION_CATALOG_PATH) return undefined
  try {
    const supplied = headers.get(API_DIAGNOSTIC_HEADER)
    const identifier = isRequestDiagnosticId(supplied)
      ? supplied
      : crypto.randomUUID().replaceAll('-', '')
    // Adding this header to a history GET would require a CORS preflight.
    // Its generated ID joins renderer stages; before headers arrive there is
    // no exact Serve match. After headers, use the exposed server_request_id.
    if (!caller) headers.set(API_DIAGNOSTIC_HEADER, identifier)
    const timing = new RequestTiming(identifier, timeoutMs, path, url, caller)
    timing.record('fetch_started')
    return timing
  } catch {
    return undefined
  }
}

export async function readApiJson<T = unknown>(response: Response): Promise<T> {
  const timing = responseTimings.get(response)
  timing?.record('body_started', response.status)
  try {
    const payload = (await response.json()) as T
    timing?.record('body_decoded', response.status)
    return payload
  } catch (error) {
    timing?.record('body_failed', response.status, error)
    throw error
  }
}

export function reportCatalogReady(response: Response, count: number): void {
  responseTimings
    .get(response)
    ?.record('catalog_ready', response.status, undefined, { selected_rows: count })
}

export function reportCatalogFailure(
  response: Response,
  phase: 'schema' | 'projection',
  error?: unknown
): void {
  responseTimings
    .get(response)
    ?.record('catalog_failed', response.status, error, { failure_phase: phase })
}
