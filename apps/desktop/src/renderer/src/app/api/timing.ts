import {
  API_DIAGNOSTIC_HEADER,
  HTTP_LATENCY_DIAGNOSTIC_PREFIX,
  SESSION_CATALOG_PATH,
  isRequestDiagnosticId,
} from '../../../../requests.ts'

const ERROR_NAMES = new Set(['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'Error'])
const responseTimings = new WeakMap<Response, CatalogTiming>()
type TimingEvent =
  | 'fetch_started'
  | 'headers_received'
  | 'fetch_failed'
  | 'body_started'
  | 'body_decoded'
  | 'body_failed'
  | 'catalog_ready'
  | 'catalog_failed'

type TimingDetails = { selected_rows?: number; failure_phase?: 'schema' | 'projection' }

class CatalogTiming {
  private readonly startedAt = performance.now()
  private headersAt: number | undefined
  private bodyAt: number | undefined
  private readonly stages: Record<string, unknown>[] = []

  constructor(
    readonly identifier: string,
    readonly timeoutMs: number | undefined
  ) {}

  record(
    event: TimingEvent,
    status: number | null = null,
    error?: unknown,
    details: TimingDetails = {}
  ): void {
    const now = performance.now()
    if (event === 'headers_received') this.headersAt = now
    if (event === 'body_started') this.bodyAt = now
    try {
      const point = {
        layer: 'renderer',
        event,
        client_request_id: this.identifier,
        route: SESSION_CATALOG_PATH,
        method: 'GET',
        timestamp_ms: Date.now(),
        time_origin_ms: performance.timeOrigin,
        elapsed_ms: now - this.startedAt,
        timeout_ms: this.timeoutMs ?? null,
        status,
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
        event === 'catalog_failed'
      if (
        !terminal &&
        !(event === 'headers_received' && status !== null && (status < 200 || status >= 300))
      )
        return
      const stages = this.stages.splice(0)
      console.info(HTTP_LATENCY_DIAGNOSTIC_PREFIX, JSON.stringify({ ...point, stages }))
    } catch {}
  }

  headers(response: Response): void {
    responseTimings.set(response, this)
    this.record('headers_received', response.status)
  }
}

export function startCatalogTiming(
  path: string,
  method: string,
  timeoutMs: number | undefined,
  headers: Headers
): CatalogTiming | undefined {
  if (path.split('?')[0] !== SESSION_CATALOG_PATH || method !== 'GET') return undefined
  try {
    const supplied = headers.get(API_DIAGNOSTIC_HEADER)
    const identifier = isRequestDiagnosticId(supplied)
      ? supplied
      : crypto.randomUUID().replaceAll('-', '')
    headers.set(API_DIAGNOSTIC_HEADER, identifier)
    const timing = new CatalogTiming(identifier, timeoutMs)
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
