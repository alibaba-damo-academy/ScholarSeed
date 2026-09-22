/** POST-SSE client for isolated Agent invocations. */

import { apiFetch, serviceErrorDetail } from './api.ts'
import { sseData } from './sse.ts'
import {
  AGENT_INVOCATION_COMPLETED_EVENT,
  AGENT_INVOCATION_EVENT_SCHEMA_VERSION,
  AGENT_INVOCATION_INTERACTION_REQUIRED_EVENT,
  AGENT_INVOCATION_STARTED_EVENT,
  AGENT_INVOCATION_TERMINAL_EVENTS,
  type AgentInvocationArtifactTextResult,
  type AgentInvocationEvent,
  type AgentInvocationInteractionHandler,
  type AgentInvocationInteractionResponse,
  type AgentInvocationInteractionResult,
  type AgentInvocationRequest,
  type AgentInvocationStreamResult
} from './contracts/invocation.ts'

const AGENT_INVOCATION_ROUTE = '/api/agent/invocations'
const SSE_MEDIA_TYPE = 'text/event-stream'
export const INVOCATION_ABORTED_CODE = 'invocation_aborted'
export const INVOCATION_PROTOCOL_ERROR_CODE = 'invocation_stream_invalid'
export const INVOCATION_INTERACTION_REQUIRED_CODE = 'invocation_interaction_required'
export const INVOCATION_REQUEST_FAILED_CODE = 'invocation_request_failed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one public event before any feature stores or projects it. */
export function parseAgentInvocationEvent(value: unknown): AgentInvocationEvent | null {
  if (!isRecord(value) || !isRecord(value.data)) return null
  if (
    value.schema_version !== AGENT_INVOCATION_EVENT_SCHEMA_VERSION
    || typeof value.invocation_id !== 'string'
    || !value.invocation_id
    || !Number.isInteger(value.seq)
    || Number(value.seq) < 1
    || typeof value.type !== 'string'
    || !value.type
    || typeof value.turn_id !== 'string'
    || typeof value.item_id !== 'string'
    || typeof value.created_at !== 'number'
    || !Number.isFinite(value.created_at)
  ) return null
  return value as unknown as AgentInvocationEvent
}


function protocolFailure(status: number): AgentInvocationStreamResult {
  return {
    ok: false,
    status,
    error: INVOCATION_PROTOCOL_ERROR_CODE,
    code: INVOCATION_PROTOCOL_ERROR_CODE
  }
}

function interactionFailure(status: number): AgentInvocationStreamResult {
  return {
    ok: false,
    status,
    error: INVOCATION_INTERACTION_REQUIRED_CODE,
    code: INVOCATION_INTERACTION_REQUIRED_CODE
  }
}

/** Reply to one blocking interaction while the original Invocation SSE remains open. */
export async function respondAgentInvocationInteraction(
  invocationId: string,
  requestId: string,
  decision: AgentInvocationInteractionResponse,
  signal?: AbortSignal
): Promise<AgentInvocationInteractionResult> {
  try {
    const response = await apiFetch(
      `${AGENT_INVOCATION_ROUTE}/${encodeURIComponent(invocationId)}`
        + `/interactions/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decision),
        signal
      }
    )
    if (!response.ok) {
      const failure = await serviceErrorDetail(response)
      return {
        ok: false,
        status: response.status,
        error: failure.message,
        ...(failure.code ? { code: failure.code } : {})
      }
    }
    return { ok: true, status: response.status }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: (error instanceof Error ? error.message : String(error)) || INVOCATION_REQUEST_FAILED_CODE
    }
  }
}

/**
 * Start one invocation and consume its single connection to a terminal event.
 * This stream is intentionally non-resumable; aborting it asks Serve to clean up the run.
 */
export async function streamAgentInvocation(
  request: AgentInvocationRequest,
  onEvent: (event: AgentInvocationEvent) => void,
  signal?: AbortSignal,
  onInteraction?: AgentInvocationInteractionHandler
): Promise<AgentInvocationStreamResult> {
  try {
    const response = await apiFetch(AGENT_INVOCATION_ROUTE, {
      method: 'POST',
      headers: {
        Accept: SSE_MEDIA_TYPE,
        'content-type': 'application/json'
      },
      body: JSON.stringify(request),
      signal
    })
    if (!response.ok) {
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent('scholarseed:auth-required'))
      }
      const failure = await serviceErrorDetail(response)
      return {
        ok: false,
        status: response.status,
        error: failure.message,
        ...(failure.code ? { code: failure.code } : {})
      }
    }
    if (!response.headers.get('content-type')?.includes(SSE_MEDIA_TYPE) || !response.body) {
      return protocolFailure(response.status)
    }

    let expectedSequence = 1
    let invocationId = ''
    let terminal: AgentInvocationEvent | undefined
    for await (const payload of sseData(response.body)) {
      let decoded: unknown
      try {
        decoded = JSON.parse(payload)
      } catch {
        return protocolFailure(response.status)
      }
      const event = parseAgentInvocationEvent(decoded)
      if (
        !event
        || event.seq !== expectedSequence
        || (expectedSequence === 1 && event.type !== AGENT_INVOCATION_STARTED_EVENT)
        || (expectedSequence > 1 && event.type === AGENT_INVOCATION_STARTED_EVENT)
        || (invocationId && event.invocation_id !== invocationId)
        || terminal !== undefined
      ) return protocolFailure(response.status)
      invocationId ||= event.invocation_id
      expectedSequence += 1
      onEvent(event)
      if (event.type === AGENT_INVOCATION_INTERACTION_REQUIRED_EVENT) {
        const requestId = typeof event.data.request_id === 'string'
          ? event.data.request_id
          : ''
        if (!requestId) return protocolFailure(response.status)
        if (!onInteraction) return interactionFailure(response.status)
        const decision = await onInteraction(event)
        if (!decision) return interactionFailure(response.status)
        const resolved = await respondAgentInvocationInteraction(
          invocationId,
          requestId,
          decision,
          signal
        )
        if (!resolved.ok) {
          return {
            ok: false,
            status: resolved.status,
            error: resolved.error,
            ...(resolved.code ? { code: resolved.code } : {})
          }
        }
      }
      if (AGENT_INVOCATION_TERMINAL_EVENTS.has(event.type)) terminal = event
    }
    if (!terminal) return protocolFailure(response.status)
    if (terminal.type === AGENT_INVOCATION_COMPLETED_EVENT) {
      return { ok: true, status: response.status, terminal }
    }
    const error = typeof terminal.data.error === 'string' && terminal.data.error
      ? terminal.data.error
      : terminal.type
    return { ok: false, status: response.status, error, code: error, terminal }
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      return {
        ok: false,
        status: 0,
        error: INVOCATION_ABORTED_CODE,
        code: INVOCATION_ABORTED_CODE
      }
    }
    return {
      ok: false,
      status: 0,
      error: (error instanceof Error ? error.message : String(error)) || INVOCATION_REQUEST_FAILED_CODE
    }
  }
}

/** Download one registered artifact through the invocation ownership boundary. */
export async function readAgentInvocationArtifactText(
  invocationId: string,
  artifactId: string,
  signal?: AbortSignal
): Promise<AgentInvocationArtifactTextResult> {
  try {
    const response = await apiFetch(
      `${AGENT_INVOCATION_ROUTE}/${encodeURIComponent(invocationId)}`
        + `/artifacts/${encodeURIComponent(artifactId)}`,
      { signal }
    )
    if (!response.ok) {
      const failure = await serviceErrorDetail(response)
      return {
        ok: false,
        status: response.status,
        error: failure.message,
        ...(failure.code ? { code: failure.code } : {})
      }
    }
    return { ok: true, status: response.status, text: await response.text() }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: (error instanceof Error ? error.message : String(error)) || INVOCATION_REQUEST_FAILED_CODE
    }
  }
}
