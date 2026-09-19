/** Runtime driver for the Resource feature's isolated web-search jobs. */

import {
  AGENT_INVOCATION_INTERRUPTED_EVENT,
  AGENT_INVOCATION_STARTED_EVENT,
  AGENT_INVOCATION_UNKNOWN_EVENT,
  type AgentInvocationEvent
} from '../../contracts/invocation.ts'
import {
  INVOCATION_ABORTED_CODE,
  INVOCATION_INTERACTION_REQUIRED_CODE,
  INVOCATION_PROTOCOL_ERROR_CODE,
  readAgentInvocationArtifactText,
  streamAgentInvocation
} from '../../invocation.ts'
import type { RuntimeCapabilityRequirement } from '../../model.ts'
import {
  appendWebSearchProjectionEvent,
  isWebSearchProjectionEvent,
  projectWebSearch,
  WEB_SEARCH_AUTOMATIC_ROUTE,
  WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
  WEB_SEARCH_INTERRUPTED_CODE,
  WEB_SEARCH_OUTPUT_SCHEMA_ID,
  webSearchInvocationFailure,
  webSearchInvocationRequest,
  webSearchModeDefinition,
  webSearchResultArtifact
} from './search.ts'
import type { WebSearchProjection } from './search.ts'
import type {
  WebSearchAttempt,
  WebSearchMode
} from './state.ts'
import { OFFICIAL_SEARCH_MODE, WEB_SEARCH_CANDIDATES_MODE } from './state.ts'

const NON_FALLBACK_INVOCATION_CODES = new Set([
  INVOCATION_ABORTED_CODE,
  INVOCATION_INTERACTION_REQUIRED_CODE,
  INVOCATION_PROTOCOL_ERROR_CODE
])
const RUNTIME_CAPABILITY_UNAVAILABLE_CODE = 'runtime_capability_unavailable'
const WEB_SEARCH_OUTPUT_MISSING_CODE = 'web_search_output_missing'
const NATIVE_WEB_SEARCH_LOG_PREFIX = '[web-search] '
const NATIVE_WEB_SEARCH_FAILURE_EVENT = 'native_web_search_failed'
const NATIVE_WEB_SEARCH_UNCLASSIFIED_ERROR_CODE = 'unclassified_failure'
const NATIVE_WEB_SEARCH_ERROR_CODE_LIMIT = 128
const NATIVE_WEB_SEARCH_ERROR_CODE_PATTERN = /^[a-z0-9_.-]+$/i
const OFFICIAL_WEB_SEARCH_ATTEMPT_EVENT = 'official_web_search_attempt'
const NATIVE_WEB_SEARCH_FAILURE_STAGE = {
  AVAILABILITY: 'availability',
  INVOCATION: 'invocation',
  EVIDENCE_CONTRACT: 'evidence_contract'
} as const

type NativeWebSearchFailureStage = typeof NATIVE_WEB_SEARCH_FAILURE_STAGE[
  keyof typeof NATIVE_WEB_SEARCH_FAILURE_STAGE
]

interface NativeWebSearchFailureLogInput {
  attempt: WebSearchAttempt
  stage: NativeWebSearchFailureStage
  willFallback: boolean
  projection?: WebSearchProjection
  resultText?: string
}

interface OfficialWebSearchAttemptLogInput {
  attempt: WebSearchAttempt
  stage: NativeWebSearchFailureStage | 'completed'
  willFallback: boolean
  nextMode: WebSearchMode | null
  queryLength: number
  projection?: WebSearchProjection
  resultText?: string
}

export type WebSearchCapabilityAvailability = Partial<
  Record<RuntimeCapabilityRequirement, boolean>
>

export type WebSearchRunResult =
  | { ok: true; status: 'completed'; resultText: string; httpStatus: number }
  | {
      ok: false
      status: 'failed' | 'interrupted' | 'unknown'
      error: string
      errorCode?: string
      httpStatus: number
    }

export type WebSearchRouteResult =
  | {
      ok: true
      status: 'completed'
      attempts: WebSearchAttempt[]
      resolvedMode: WebSearchMode
    }
  | {
      ok: false
      status: 'failed' | 'interrupted' | 'unknown'
      attempts: WebSearchAttempt[]
      error: string
    }

export type WebSearchAttemptObserver = (
  attempt: WebSearchAttempt,
  index: number
) => void

/** Consume one complete Invocation and hydrate any mode-owned final artifact. */
export async function runWebSearch(
  query: string,
  mode: WebSearchMode,
  onEvent: (event: AgentInvocationEvent) => void,
  signal: AbortSignal
): Promise<WebSearchRunResult> {
  const definition = webSearchModeDefinition(mode)
  const result = await streamAgentInvocation(
    webSearchInvocationRequest(query, mode),
    onEvent,
    signal
  )
  if (!result.ok) {
    return {
      ok: false,
      status: result.code === INVOCATION_ABORTED_CODE
        ? 'interrupted'
        : result.terminal?.type === AGENT_INVOCATION_INTERRUPTED_EVENT
          ? 'interrupted'
          : result.terminal?.type === AGENT_INVOCATION_UNKNOWN_EVENT
            ? 'unknown'
            : 'failed',
      error: webSearchInvocationFailure(result.error, definition.executionError),
      errorCode: result.code || result.error,
      httpStatus: result.status
    }
  }

  let resultText = typeof result.terminal.data.text === 'string'
    ? result.terminal.data.text
    : ''
  const artifact = webSearchResultArtifact(result.terminal, mode)
  if (definition.resultArtifactPath && !artifact) {
    return {
      ok: false,
      status: 'failed',
      error: definition.executionError,
      errorCode: WEB_SEARCH_OUTPUT_MISSING_CODE,
      httpStatus: result.status
    }
  }
  if (artifact) {
    const downloaded = await readAgentInvocationArtifactText(
      result.terminal.invocation_id,
      artifact.artifact_id,
      signal
    )
    if (!downloaded.ok) {
      return {
        ok: false,
        status: 'failed',
        error: webSearchInvocationFailure(downloaded.error, definition.executionError),
        ...(downloaded.code ? { errorCode: downloaded.code } : {}),
        httpStatus: downloaded.status
      }
    }
    resultText = downloaded.text
  }
  return { ok: true, status: 'completed', resultText, httpStatus: result.status }
}

function canRunMode(
  mode: WebSearchMode,
  capabilities: WebSearchCapabilityAvailability
): boolean {
  return webSearchModeDefinition(mode).requiredCapabilities.every(
    (capability) => capabilities[capability] === true
  )
}

function canFallbackAfterFailure(result: WebSearchRunResult, signal: AbortSignal): boolean {
  return !result.ok
    && result.status === 'failed'
    && !signal.aborted
    && !NON_FALLBACK_INVOCATION_CODES.has(result.errorCode ?? '')
}

function nativeWebSearchInvocationId(attempt: WebSearchAttempt): string | null {
  return attempt.invocationId
    || attempt.invocationEvents.find((event) => Boolean(event.invocation_id))?.invocation_id
    || null
}

function nativeWebSearchErrorCode(attempt: WebSearchAttempt): {
  code: string | null
  redacted: boolean
} {
  const errorCode = attempt.errorCode?.trim() ?? ''
  if (!errorCode) return { code: null, redacted: false }
  if (
    errorCode.length <= NATIVE_WEB_SEARCH_ERROR_CODE_LIMIT
    && NATIVE_WEB_SEARCH_ERROR_CODE_PATTERN.test(errorCode)
  ) {
    return { code: errorCode, redacted: false }
  }
  return { code: NATIVE_WEB_SEARCH_UNCLASSIFIED_ERROR_CODE, redacted: true }
}

function logNativeWebSearchFailure(input: NativeWebSearchFailureLogInput): void {
  const resultText = input.resultText ?? ''
  const projection = input.projection
  const errorCode = nativeWebSearchErrorCode(input.attempt)
  console.warn(`${NATIVE_WEB_SEARCH_LOG_PREFIX}${JSON.stringify({
    event: NATIVE_WEB_SEARCH_FAILURE_EVENT,
    stage: input.stage,
    mode: input.attempt.mode,
    invocation_id: nativeWebSearchInvocationId(input.attempt),
    status: input.attempt.status,
    error_code: errorCode.code,
    error_code_redacted: errorCode.redacted,
    http_status: input.attempt.httpStatus ?? null,
    will_fallback: input.willFallback,
    expected_output_schema: WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
    validation_issues: projection?.validationIssues ?? [],
    execution_evidence_found: projection?.executionEvidenceFound ?? null,
    structured_output_found: projection?.structuredOutputFound ?? null,
    candidate_count: projection?.candidates.length ?? 0,
    result_text_present: Boolean(resultText.trim()),
    result_text_length: resultText.length,
    event_types: [...new Set(input.attempt.invocationEvents.map((event) => event.type))]
  })}`)
}

function logOfficialWebSearchAttempt(input: OfficialWebSearchAttemptLogInput): void {
  const resultText = input.resultText ?? ''
  const projection = input.projection
  const diagnostics = projection?.diagnostics
  const errorCode = nativeWebSearchErrorCode(input.attempt)
  const details = `${NATIVE_WEB_SEARCH_LOG_PREFIX}${JSON.stringify({
    event: OFFICIAL_WEB_SEARCH_ATTEMPT_EVENT,
    stage: input.stage,
    mode: input.attempt.mode,
    invocation_id: nativeWebSearchInvocationId(input.attempt),
    status: input.attempt.status,
    error_code: errorCode.code,
    error_code_redacted: errorCode.redacted,
    invocation_http_status: input.attempt.httpStatus ?? null,
    will_fallback: input.willFallback,
    next_mode: input.nextMode,
    query_length: input.queryLength,
    failure_phase: diagnostics?.phase ?? null,
    upstream_http_status: diagnostics?.upstreamHttpStatus ?? null,
    upstream_error_type: diagnostics?.errorType ?? null,
    upstream_response_bytes: diagnostics?.responseBytes ?? null,
    upstream_response_oversized: diagnostics?.responseOversized ?? null,
    expected_output_schema: WEB_SEARCH_OUTPUT_SCHEMA_ID,
    validation_issues: projection?.validationIssues ?? [],
    execution_evidence_found: projection?.executionEvidenceFound ?? null,
    structured_output_found: projection?.structuredOutputFound ?? null,
    candidate_count: projection?.candidates.length ?? 0,
    result_text_present: Boolean(resultText.trim()),
    result_text_length: resultText.length,
    event_types: [...new Set(input.attempt.invocationEvents.map((event) => event.type))]
  })}`
  if (input.attempt.status === 'completed') console.info(details)
  else console.warn(details)
}

/** Execute the registered automatic route while keeping each Skill's evidence isolated. */
export async function runWebSearchRoute(
  query: string,
  capabilities: WebSearchCapabilityAvailability,
  onAttempt: WebSearchAttemptObserver,
  signal: AbortSignal
): Promise<WebSearchRouteResult> {
  const attempts: WebSearchAttempt[] = []

  const publish = (attempt: WebSearchAttempt, index: number): void => {
    attempts[index] = attempt
    onAttempt(attempt, index)
  }

  for (const [index, mode] of WEB_SEARCH_AUTOMATIC_ROUTE.entries()) {
    if (signal.aborted) {
      return {
        ok: false,
        status: 'interrupted',
        attempts,
        error: WEB_SEARCH_INTERRUPTED_CODE
      }
    }
    const definition = webSearchModeDefinition(mode)
    const startedAt = Date.now()
    if (!canRunMode(mode, capabilities)) {
      const unavailable: WebSearchAttempt = {
        mode,
        startedAt,
        completedAt: startedAt,
        invocationEvents: [],
        eventObservedAt: {},
        status: 'unavailable',
        error: webSearchInvocationFailure(
          RUNTIME_CAPABILITY_UNAVAILABLE_CODE,
          definition.executionError
        ),
        errorCode: RUNTIME_CAPABILITY_UNAVAILABLE_CODE
      }
      publish(unavailable, index)
      if (mode === WEB_SEARCH_CANDIDATES_MODE) {
        logNativeWebSearchFailure({
          attempt: unavailable,
          stage: NATIVE_WEB_SEARCH_FAILURE_STAGE.AVAILABILITY,
          willFallback: index < WEB_SEARCH_AUTOMATIC_ROUTE.length - 1
        })
      }
      continue
    }

    let attempt: WebSearchAttempt = {
      mode,
      startedAt,
      invocationEvents: [],
      eventObservedAt: {},
      status: 'opening'
    }
    publish(attempt, index)
    const result = await runWebSearch(
      query,
      mode,
      (event) => {
        if (!isWebSearchProjectionEvent(event)) return
        const observedAt = Date.now()
        const invocationEvents = appendWebSearchProjectionEvent(attempt.invocationEvents, event)
        const eventObservedAt = Object.fromEntries(invocationEvents.map((retained) => [
          retained.seq,
          retained.seq === event.seq
            ? observedAt
            : attempt.eventObservedAt[retained.seq] ?? observedAt
        ]))
        attempt = {
          ...attempt,
          invocationId: event.invocation_id,
          invocationStartedAt: attempt.invocationStartedAt
            ?? (event.type === AGENT_INVOCATION_STARTED_EVENT ? observedAt : undefined),
          status: 'running',
          invocationEvents,
          eventObservedAt
        }
        publish(attempt, index)
      },
      signal
    )
    const completedAt = Date.now()
    if (!result.ok) {
      attempt = {
        ...attempt,
        completedAt,
        status: result.status,
        error: result.error,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        httpStatus: result.httpStatus
      }
      publish(attempt, index)
      const hasFallback = index < WEB_SEARCH_AUTOMATIC_ROUTE.length - 1
      const willFallback = hasFallback && canFallbackAfterFailure(result, signal)
      if (mode === WEB_SEARCH_CANDIDATES_MODE) {
        logNativeWebSearchFailure({
          attempt,
          stage: NATIVE_WEB_SEARCH_FAILURE_STAGE.INVOCATION,
          willFallback
        })
      } else if (mode === OFFICIAL_SEARCH_MODE) {
        logOfficialWebSearchAttempt({
          attempt,
          stage: NATIVE_WEB_SEARCH_FAILURE_STAGE.INVOCATION,
          willFallback,
          nextMode: willFallback ? WEB_SEARCH_AUTOMATIC_ROUTE[index + 1] ?? null : null,
          queryLength: query.trim().length
        })
      }
      if (willFallback) continue
      if (signal.aborted) {
        return {
          ok: false,
          status: 'interrupted',
          attempts,
          error: WEB_SEARCH_INTERRUPTED_CODE
        }
      }
      return {
        ok: false,
        status: result.status,
        attempts,
        error: result.error
      }
    }

    const projection = projectWebSearch(
      attempt.invocationEvents,
      mode,
      result.resultText,
      query
    )
    if (projection.error) {
      attempt = {
        ...attempt,
        completedAt,
        resultText: result.resultText,
        status: 'failed',
        error: projection.error,
        ...(projection.errorCode ? { errorCode: projection.errorCode } : {}),
        httpStatus: result.httpStatus
      }
      publish(attempt, index)
      const willFallback = index < WEB_SEARCH_AUTOMATIC_ROUTE.length - 1 && !signal.aborted
      if (mode === WEB_SEARCH_CANDIDATES_MODE) {
        logNativeWebSearchFailure({
          attempt,
          stage: NATIVE_WEB_SEARCH_FAILURE_STAGE.EVIDENCE_CONTRACT,
          willFallback,
          projection,
          resultText: result.resultText
        })
      } else if (mode === OFFICIAL_SEARCH_MODE) {
        logOfficialWebSearchAttempt({
          attempt,
          stage: NATIVE_WEB_SEARCH_FAILURE_STAGE.EVIDENCE_CONTRACT,
          willFallback,
          nextMode: willFallback ? WEB_SEARCH_AUTOMATIC_ROUTE[index + 1] ?? null : null,
          queryLength: query.trim().length,
          projection,
          resultText: result.resultText
        })
      }
      if (willFallback) continue
      return {
        ok: false,
        status: 'failed',
        attempts,
        error: projection.error
      }
    }

    const outputMissing = !projection.executionEvidenceFound
      || !projection.structuredOutputFound
    if (outputMissing) {
      attempt = {
        ...attempt,
        completedAt,
        resultText: result.resultText,
        status: 'failed',
        error: definition.executionError,
        errorCode: WEB_SEARCH_OUTPUT_MISSING_CODE,
        httpStatus: result.httpStatus
      }
      publish(attempt, index)
      const willFallback = index < WEB_SEARCH_AUTOMATIC_ROUTE.length - 1 && !signal.aborted
      if (mode === WEB_SEARCH_CANDIDATES_MODE) {
        logNativeWebSearchFailure({
          attempt,
          stage: NATIVE_WEB_SEARCH_FAILURE_STAGE.EVIDENCE_CONTRACT,
          willFallback,
          projection,
          resultText: result.resultText
        })
      } else if (mode === OFFICIAL_SEARCH_MODE) {
        logOfficialWebSearchAttempt({
          attempt,
          stage: NATIVE_WEB_SEARCH_FAILURE_STAGE.EVIDENCE_CONTRACT,
          willFallback,
          nextMode: willFallback ? WEB_SEARCH_AUTOMATIC_ROUTE[index + 1] ?? null : null,
          queryLength: query.trim().length,
          projection,
          resultText: result.resultText
        })
      }
      if (willFallback) continue
      if (signal.aborted) {
        return {
          ok: false,
          status: 'interrupted',
          attempts,
          error: WEB_SEARCH_INTERRUPTED_CODE
        }
      }
      return {
        ok: false,
        status: 'failed',
        attempts,
        error: definition.executionError
      }
    }

    attempt = {
      ...attempt,
      completedAt,
      resultText: result.resultText,
      status: 'completed',
      error: undefined,
      errorCode: undefined,
      httpStatus: result.httpStatus
    }
    publish(attempt, index)
    if (mode === OFFICIAL_SEARCH_MODE) {
      logOfficialWebSearchAttempt({
        attempt,
        stage: 'completed',
        willFallback: false,
        nextMode: null,
        queryLength: query.trim().length,
        projection,
        resultText: result.resultText
      })
    }
    return {
      ok: true,
      status: 'completed',
      attempts,
      resolvedMode: mode
    }
  }

  const lastAttempt = attempts.at(-1)
  return {
    ok: false,
    status: 'failed',
    attempts,
    error: lastAttempt?.error || webSearchModeDefinition(
      WEB_SEARCH_AUTOMATIC_ROUTE[WEB_SEARCH_AUTOMATIC_ROUTE.length - 1]
    ).executionError
  }
}
