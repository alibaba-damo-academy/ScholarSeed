import type { WebContents, WebRequest, OnSendHeadersListenerDetails } from 'electron'
import { monitorEventLoopDelay, performance as nodePerformance } from 'node:perf_hooks'
import {
  API_DIAGNOSTIC_HEADER,
  HTTP_LATENCY_DIAGNOSTIC_PREFIX,
  SESSION_CATALOG_PATH,
  isRequestDiagnosticId,
  catalogDiagnosticContext,
} from '../requests.ts'

export const NETWORK_DIAGNOSTIC_LIMIT = 128
export const NETWORK_LOOP_RESOLUTION_MS = 20
const NANOSECONDS_PER_MILLISECOND = 1_000_000
const owners = new WeakMap<WebRequest, () => void>()
type PendingRequest = {
  identifier: string
  startedAt: number
  previousEnqueueMs?: number
  previousEnqueueEvent?: string
  responseAt?: number
  responseTimestampMs?: number
  catalog: ReturnType<typeof catalogDiagnosticContext>
}

type BackendActivity = { startedAt: number; category: string; headers: boolean }

function requestCategory(path: string): string {
  if (path === SESSION_CATALOG_PATH) return 'catalog'
  if (/^\/api\/serve\/sessions\/[^/]+\/events$/.test(path)) return 'session_stream'
  if (/^\/api\/serve\/runtime\/prepare(?:\/[^/]+)?$/.test(path)) return 'runtime_preparation'
  if (/^\/api\/healthz(?:\/|$)/.test(path)) return 'health'
  return 'other'
}

export function installNetworkDiagnostics(
  contents: Pick<WebContents, 'id' | 'session'>,
  backendBase: () => string,
  sink: (message: string) => void
): () => void {
  const {
    id: contentsId,
    session: { webRequest },
  } = contents
  owners.get(webRequest)?.()
  const pending = new Map<number, PendingRequest>()
  const activity = new Map<number, BackendActivity>()
  let evictedActivity = 0
  let loopWindowStartedAt = Date.now()
  let utilization = nodePerformance.eventLoopUtilization()
  let loopDelay: ReturnType<typeof monitorEventLoopDelay> | undefined
  try {
    loopDelay = monitorEventLoopDelay({ resolution: NETWORK_LOOP_RESOLUTION_MS })
    loopDelay.enable()
  } catch {
    loopDelay?.disable()
    loopDelay = undefined
  }
  const sampleLoop = () => {
    const endedAt = Date.now()
    const current = nodePerformance.eventLoopUtilization()
    const delta = nodePerformance.eventLoopUtilization(current, utilization)
    const result = {
      window_started_timestamp_ms: loopWindowStartedAt,
      window_ended_timestamp_ms: endedAt,
      resolution_ms: NETWORK_LOOP_RESOLUTION_MS,
      available: loopDelay !== undefined,
      sample_count: loopDelay?.count ?? null,
      delay_max_ms: loopDelay?.count ? loopDelay.max / NANOSECONDS_PER_MILLISECOND : null,
      delay_mean_ms: loopDelay?.count ? loopDelay.mean / NANOSECONDS_PER_MILLISECOND : null,
      utilization: delta.active + delta.idle > 0 ? delta.utilization : null,
    }
    utilization = current
    loopWindowStartedAt = endedAt
    loopDelay?.reset()
    return result
  }
  const sampleActivity = () => {
    const categories: Record<string, number> = {}
    let withHeaders = 0
    let oldestMs = 0
    const now = performance.now()
    for (const request of activity.values()) {
      categories[request.category] = (categories[request.category] ?? 0) + 1
      if (request.headers) withHeaders += 1
      oldestMs = Math.max(oldestMs, now - request.startedAt)
    }
    return {
      inflight_total: activity.size,
      with_headers: withHeaders,
      pending_headers: activity.size - withHeaders,
      oldest_ms: oldestMs,
      categories,
      evicted_observations: evictedActivity,
    }
  }
  const emit = (
    event: string,
    requestId: number,
    request: PendingRequest,
    status: number | null = null,
    error?: string
  ): void => {
    const writingAt = performance.now()
    try {
      sink(
        `${HTTP_LATENCY_DIAGNOSTIC_PREFIX} ${JSON.stringify({
          layer: 'network',
          event,
          client_request_id: request.identifier,
          native_request_id: requestId,
          route: SESSION_CATALOG_PATH,
          method: 'GET',
          timestamp_ms: Date.now(),
          elapsed_ms: performance.now() - request.startedAt,
          status,
          catalog: request.catalog,
          backend_activity: sampleActivity(),
          main_loop: sampleLoop(),
          diagnostic_previous_enqueue_ms: request.previousEnqueueMs ?? null,
          diagnostic_previous_enqueue_event: request.previousEnqueueEvent ?? null,
          response_started_timestamp_ms: request.responseTimestampMs ?? null,
          response_started_elapsed_ms:
            request.responseAt !== undefined ? request.responseAt - request.startedAt : null,
          transfer_after_headers_ms:
            request.responseAt !== undefined ? performance.now() - request.responseAt : null,
          ...(error
            ? { error_type: /^net::ERR_[A-Z_]+$/.test(error) ? error : 'network-error' }
            : {}),
        })}`
      )
    } catch {
    } finally {
      request.previousEnqueueMs = performance.now() - writingAt
      request.previousEnqueueEvent = event
    }
  }
  const sent = (details: OnSendHeadersListenerDetails): void => {
    if (details.webContentsId !== contentsId) return
    let target: URL
    try {
      target = new URL(details.url)
      const base = new URL(backendBase())
      if (target.origin !== base.origin) return
    } catch {
      return
    }
    if (!activity.has(details.id) && activity.size >= NETWORK_DIAGNOSTIC_LIMIT) {
      activity.delete(activity.keys().next().value!)
      evictedActivity += 1
    }
    activity.set(details.id, {
      startedAt: activity.get(details.id)?.startedAt ?? performance.now(),
      category: requestCategory(target.pathname),
      headers: false,
    })
    if (details.method !== 'GET' || target.pathname !== SESSION_CATALOG_PATH) return
    const identifiers = Object.entries(details.requestHeaders).filter(
      ([name]) => name.toLowerCase() === API_DIAGNOSTIC_HEADER
    )
    const identifier = identifiers.length === 1 ? identifiers[0][1] : undefined
    if (!isRequestDiagnosticId(identifier)) return
    if (!pending.has(details.id) && pending.size >= NETWORK_DIAGNOSTIC_LIMIT) {
      const oldest = pending.entries().next().value!
      emit('request_evicted', oldest[0], oldest[1])
      pending.delete(oldest[0])
    }
    const request = {
      identifier,
      startedAt: performance.now(),
      catalog: catalogDiagnosticContext(`${target.pathname}${target.search}`),
    }
    pending.set(details.id, request)
    emit('request_sent', details.id, request)
  }
  webRequest.onSendHeaders(sent)
  webRequest.onResponseStarted((details) => {
    const active = activity.get(details.id)
    if (active) active.headers = true
    const request = pending.get(details.id)
    if (!request) return
    request.responseAt = performance.now()
    request.responseTimestampMs = Date.now()
  })
  webRequest.onCompleted((details) => {
    activity.delete(details.id)
    const request = pending.get(details.id)
    if (!request) return
    pending.delete(details.id)
    emit('request_completed', details.id, request, details.statusCode)
  })
  webRequest.onErrorOccurred((details) => {
    activity.delete(details.id)
    const request = pending.get(details.id)
    if (!request) return
    pending.delete(details.id)
    emit('request_failed', details.id, request, null, details.error)
  })
  const dispose = (): void => {
    if (owners.get(webRequest) !== dispose) return
    owners.delete(webRequest)
    webRequest.onSendHeaders(null)
    webRequest.onResponseStarted(null)
    webRequest.onCompleted(null)
    webRequest.onErrorOccurred(null)
    for (const [requestId, request] of pending) emit('observation_disposed', requestId, request)
    pending.clear()
    activity.clear()
    loopDelay?.disable()
  }
  owners.set(webRequest, dispose)
  return dispose
}
