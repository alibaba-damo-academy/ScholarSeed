import type { WebContents, WebRequest, OnSendHeadersListenerDetails } from 'electron'
import {
  API_DIAGNOSTIC_HEADER,
  HTTP_LATENCY_DIAGNOSTIC_PREFIX,
  SESSION_CATALOG_PATH,
  isRequestDiagnosticId,
} from '../requests.ts'

export const NETWORK_DIAGNOSTIC_LIMIT = 128
const owners = new WeakMap<WebRequest, () => void>()
type PendingRequest = {
  identifier: string
  startedAt: number
  previousEnqueueMs?: number
  previousEnqueueEvent?: string
  responseAt?: number
  responseTimestampMs?: number
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
    if (details.webContentsId !== contentsId || details.method !== 'GET') return
    try {
      const target = new URL(details.url)
      const base = new URL(backendBase())
      if (target.origin !== base.origin || target.pathname !== SESSION_CATALOG_PATH) return
    } catch {
      return
    }
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
    const request = { identifier, startedAt: performance.now() }
    pending.set(details.id, request)
    emit('request_sent', details.id, request)
  }
  webRequest.onSendHeaders(sent)
  webRequest.onResponseStarted((details) => {
    const request = pending.get(details.id)
    if (!request) return
    request.responseAt = performance.now()
    request.responseTimestampMs = Date.now()
  })
  webRequest.onCompleted((details) => {
    const request = pending.get(details.id)
    if (!request) return
    pending.delete(details.id)
    emit('request_completed', details.id, request, details.statusCode)
  })
  webRequest.onErrorOccurred((details) => {
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
  }
  owners.set(webRequest, dispose)
  return dispose
}
