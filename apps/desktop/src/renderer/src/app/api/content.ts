import { apiFetch } from './client.ts'
import { CONTENT_OPERATIONS_PATH } from '../../../../requests.ts'

const ACCEPTED = 202
const MAINTENANCE = 503
const INVALID_OPERATION = 502
const FAILED_OPERATION = 400
const POLL_INTERVAL_MS = 100
const OPERATION_TIMEOUT_MS = 90_000
const STATUS_TIMEOUT_MS = 5_000
const UNKNOWN_OUTCOME = 'content_operation_unknown'

/** Resolve an accepted content command without ever resubmitting its mutation. */
export async function resolveContentResponse(response: Response): Promise<Response> {
  if (response.status !== ACCEPTED) return response
  const submitted: unknown = await response.json()
  if (
    !submitted ||
    typeof submitted !== 'object' ||
    !('operation' in submitted) ||
    typeof submitted.operation !== 'string' ||
    !/^[a-f0-9]{32}$/.test(submitted.operation)
  ) {
    return Response.json({ detail: UNKNOWN_OUTCOME }, { status: INVALID_OPERATION })
  }
  const path = `${CONTENT_OPERATIONS_PATH}/${submitted.operation}`
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    let status: Response
    try {
      status = await apiFetch(path, { timeoutMs: STATUS_TIMEOUT_MS })
    } catch {
      continue // Only the read is retried; a lost mutation response is never replayed.
    }
    if (status.status === MAINTENANCE) continue
    if (!status.ok) return status
    const payload = await status.json()
    if (payload.operation !== submitted.operation) break
    if (payload.state === 'succeeded' && payload.result && typeof payload.result === 'object') {
      return Response.json(payload.result)
    }
    if (payload.state === 'failed') {
      return Response.json(
        { detail: typeof payload.error === 'string' ? payload.error : UNKNOWN_OUTCOME },
        { status: FAILED_OPERATION }
      )
    }
    if (payload.state !== 'queued' && payload.state !== 'running') break
  }
  return Response.json({ detail: UNKNOWN_OUTCOME }, { status: INVALID_OPERATION })
}
