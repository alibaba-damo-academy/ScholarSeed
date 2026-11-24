import type { ProjectRef } from '../../contracts/content'
import { apiFetch, getJson } from './client.ts'
import { reportApiFailure } from './diagnostics.ts'
import {
  API_DIAGNOSTIC_HEADER,
  CONTENT_OPERATIONS_PATH,
  CONTENT_PROJECTS_PATH,
  isRequestDiagnosticId,
} from '../../../../requests.ts'

const ACCEPTED = 202
const MAINTENANCE = 503
const INVALID_OPERATION = 502
const FAILED_OPERATION = 400
const POLL_INTERVAL_MS = 100
const OPERATION_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 5_000
export const CONTENT_TREE_READ_TIMEOUT_MS = 15_000
export const PROJECT_WRITE_RECEIPT_TIMEOUT_MS = 15_000
export const CONTENT_OPERATION_UNKNOWN = 'content_operation_unknown'

interface ProjectWriteReceipt {
  ok: boolean
  payload?: unknown
  error?: string
  httpFailure?: { code: string; diagnostic: string }
  malformedSuccessBody?: boolean
}

/** Consume the receipt once. A queued operation must reach its own terminal result. */
export async function requestProjectWrite(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  signal = AbortSignal.timeout(PROJECT_WRITE_RECEIPT_TIMEOUT_MS)
): Promise<ProjectWriteReceipt> {
  const startedAt = performance.now()
  let response: Response | undefined
  try {
    response = await apiFetch(path, {
      method,
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    response = await resolveContentResponse(response)
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      const detail = payload?.detail
      const message = typeof detail === 'string' ? detail : detail?.message
      if (typeof message === 'string' && message) return { ok: false, error: message }
      // Project panels consume a protocol code; the path-based adapter exposes an HTTP diagnostic.
      return {
        ok: false,
        httpFailure: { code: `http_${response.status}`, diagnostic: `HTTP ${response.status}` },
      }
    }
    if (response.status === 204 || response.status === 205) return { ok: true }
    return { ok: true, payload: await response.json() }
  } catch (cause) {
    // apiFetch already reports transport failures. Record only safe receipt diagnostics here.
    if (response) reportApiFailure(path, method, response.status, startedAt, 'decode', cause)
    return {
      ok: false,
      error: CONTENT_OPERATION_UNKNOWN,
      malformedSuccessBody:
        method === 'PATCH' &&
        response?.status === 200 &&
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ===
          'application/json' &&
        cause instanceof SyntaxError,
    }
  }
}

type ProjectMetadata = { description?: string; pinned?: boolean }

export function isProjectReceipt(value: unknown): value is ProjectRef & ProjectMetadata {
  if (!value || typeof value !== 'object') return false
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'name' in value &&
    typeof value.name === 'string' &&
    'root' in value &&
    typeof value.root === 'string' &&
    'layout' in value &&
    (value.layout === 'managed' || value.layout === 'legacy') &&
    'available' in value &&
    typeof value.available === 'boolean'
  )
}

export async function requestProjectRename(
  id: string,
  name: string,
  metadata: ProjectMetadata = {}
): Promise<ProjectWriteReceipt> {
  const signal = AbortSignal.timeout(PROJECT_WRITE_RECEIPT_TIMEOUT_MS)
  const receipt = await requestProjectWrite(
    'PATCH',
    CONTENT_PROJECTS_PATH,
    { id, name, ...metadata },
    signal
  )
  if (!receipt.malformedSuccessBody || signal.aborted) return receipt
  // A synchronous rename has a stable ID. Verify all requested fields within its original deadline.
  const current = await getJson<unknown>(
    `/api/content/project?project=${encodeURIComponent(id)}`,
    undefined,
    { signal, cache: 'no-store' }
  )
  if (
    !signal.aborted &&
    isProjectReceipt(current) &&
    current.id === id &&
    current.name === name &&
    (metadata.description === undefined || current.description === metadata.description) &&
    (metadata.pinned === undefined || current.pinned === metadata.pinned)
  ) {
    return { ok: true, payload: current }
  }
  return receipt
}

/** Resolve an accepted content command without ever resubmitting its mutation. */
export async function resolveContentResponse(response: Response): Promise<Response> {
  if (response.status !== ACCEPTED) return response
  const operation = await readContentReceipt(response)
  return operation ? (await queryContentOperation(operation)).response : unknownOutcome()
}

export async function readContentReceipt(response: Response): Promise<string | null> {
  const submitted: unknown = await response.json()
  if (
    !submitted ||
    typeof submitted !== 'object' ||
    !('operation' in submitted) ||
    !isRequestDiagnosticId(submitted.operation)
  ) {
    return null
  }
  return submitted.operation
}

function unknownOutcome(): Response {
  return Response.json({ detail: CONTENT_OPERATION_UNKNOWN }, { status: INVALID_OPERATION })
}

export async function queryContentOperation(
  operation: string,
  diagnosticId?: string
): Promise<{
  response: Response
  terminal?: 'succeeded' | 'failed'
  status?: number
}> {
  const path = `${CONTENT_OPERATIONS_PATH}/${operation}`
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  let lastStatus: number | undefined
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const startedAt = performance.now()
    let status: Response
    try {
      status = await apiFetch(path, {
        timeoutMs: STATUS_TIMEOUT_MS,
        ...(diagnosticId ? { headers: { [API_DIAGNOSTIC_HEADER]: diagnosticId } } : {}),
      })
    } catch {
      continue // Only the read is retried; a lost mutation response is never replayed.
    }
    lastStatus = status.status
    if (status.status === MAINTENANCE) continue
    if (!status.ok) return { response: status, status: lastStatus }
    const payload = await status.json().catch((cause: unknown) => {
      reportApiFailure(path, 'GET', status.status, startedAt, 'decode', cause)
      return null
    })
    if (payload?.operation !== operation) break
    if (payload.state === 'succeeded' && payload.result && typeof payload.result === 'object') {
      return { response: Response.json(payload.result), terminal: 'succeeded', status: lastStatus }
    }
    if (payload.state === 'failed') {
      return {
        response: Response.json(
          { detail: typeof payload.error === 'string' ? payload.error : CONTENT_OPERATION_UNKNOWN },
          { status: FAILED_OPERATION }
        ),
        terminal: 'failed',
        status: lastStatus,
      }
    }
    if (payload.state !== 'queued' && payload.state !== 'running') break
  }
  return { response: unknownOutcome(), status: lastStatus }
}
