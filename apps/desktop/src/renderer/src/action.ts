/** Strict POST-SSE consumer for request-scoped Assistant actions. */

import { apiFetch } from './api.ts'
import { sseData } from './sse.ts'

const SSE_MEDIA_TYPE = 'text/event-stream'
const ACTIVITY_TYPES = new Set(['accepted', 'started', 'output_delta', 'output_completed'])

export interface ActionActivity {
  type: 'accepted' | 'started' | 'output_delta' | 'output_completed'
  invocation_id: string
  text: string
  item_id: string
}

interface ActionResult {
  invocation_id: string
}

interface ActionStreamOptions<Result extends ActionResult> {
  path: string
  body: unknown
  signal?: AbortSignal
  protocolError: string
  parseResult: (value: unknown) => Result | null
  onActivity: (event: ActionActivity) => void
  onEvent?: (event: Record<string, unknown>) => boolean
}

type Terminal<Result> =
  | { type: 'result'; result: Result }
  | { type: 'error'; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function activity(value: unknown): ActionActivity | null {
  if (!isRecord(value) || !ACTIVITY_TYPES.has(String(value.type))) return null
  if (
    typeof value.invocation_id !== 'string' || !value.invocation_id
    || typeof value.text !== 'string'
    || typeof value.item_id !== 'string'
  ) return null
  return value as unknown as ActionActivity
}

async function responseError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => null) as { detail?: unknown } | null
  if (typeof payload?.detail === 'string') return new Error(payload.detail)
  if (isRecord(payload?.detail) && typeof payload.detail.code === 'string') {
    return new Error(payload.detail.code)
  }
  return new Error(`http_${response.status}`)
}

/** Consume one action invocation until its unique result or error terminal. */
export async function postActionStream<Result extends ActionResult>(
  options: ActionStreamOptions<Result>
): Promise<Result> {
  const response = await apiFetch(options.path, {
    method: 'POST',
    headers: { Accept: SSE_MEDIA_TYPE, 'Content-Type': 'application/json' },
    body: JSON.stringify(options.body),
    signal: options.signal
  })
  if (!response.ok) throw await responseError(response)
  if (!response.body || !response.headers.get('content-type')?.includes(SSE_MEDIA_TYPE)) {
    throw new Error(options.protocolError)
  }

  let invocationId = ''
  let terminal: Terminal<Result> | null = null
  for await (const frame of sseData(response.body)) {
    if (terminal !== null) throw new Error(options.protocolError)
    let decoded: unknown
    try {
      decoded = JSON.parse(frame)
    } catch {
      throw new Error(options.protocolError)
    }
    if (!isRecord(decoded)) throw new Error(options.protocolError)
    if (decoded.type === 'error') {
      if (typeof decoded.error !== 'string' || !decoded.error) {
        throw new Error(options.protocolError)
      }
      terminal = { type: 'error', error: decoded.error }
      continue
    }
    if (decoded.type === 'result') {
      let result: Result | null
      try {
        result = options.parseResult(decoded.result)
      } catch {
        throw new Error(options.protocolError)
      }
      if (!result || !result.invocation_id || (invocationId && result.invocation_id !== invocationId)) {
        throw new Error(options.protocolError)
      }
      terminal = { type: 'result', result }
      continue
    }
    if (options.onEvent?.(decoded)) continue
    const event = activity(decoded)
    if (!event || (invocationId && event.invocation_id !== invocationId)) {
      throw new Error(options.protocolError)
    }
    invocationId = event.invocation_id
    options.onActivity(event)
  }
  if (terminal?.type === 'result') return terminal.result
  if (terminal?.type === 'error') throw new Error(terminal.error)
  throw new Error(options.protocolError)
}
