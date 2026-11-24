import { apiFetch } from './client.ts'
import {
  API_DIAGNOSTIC_HEADER,
  CONTENT_OPERATIONS_PATH,
  isRequestDiagnosticId,
} from '../../../../requests.ts'

const ACCEPTED = 202
const MAINTENANCE = 503
const INVALID_OPERATION = 502
const FAILED_OPERATION = 400
const POLL_INTERVAL_MS = 100
const OPERATION_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 5_000
export const PROJECT_WRITE_RECEIPT_TIMEOUT_MS = 15_000
export const CONTENT_OPERATION_UNKNOWN = 'content_operation_unknown'

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
    const payload = await status.json()
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
