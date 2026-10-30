/** Runtime driver for the Resource feature's isolated web-search jobs. */

import {
  AGENT_INVOCATION_INTERRUPTED_EVENT,
  AGENT_INVOCATION_STARTED_EVENT,
  AGENT_INVOCATION_UNKNOWN_EVENT,
  type AgentInvocationEvent,
} from '../../contracts/invocation.ts'
import {
  INVOCATION_ABORTED_CODE,
  readAgentInvocationArtifactText,
  streamAgentInvocation,
  streamInvocationEvents,
} from '../../invocation.ts'
import type { RuntimeCapabilityRequirement } from '../../model.ts'
import { apiFetch } from '../../app/api/client.ts'
import {
  appendWebSearchProjectionEvent,
  AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH,
  AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH,
  isWebSearchProjectionEvent,
  projectAutomaticWebSearch,
  projectOfficialWebSearch,
  FALLBACK_SEARCH_PROFILE,
  WEB_SEARCH_FALLBACK_ROUTE,
  WEB_SEARCH_CANDIDATE_LIMIT,
  WEB_SEARCH_RESULT_READY_EVENT,
  WEB_SEARCH_RESULT_CONTRACT_SATISFIED,
  webSearchInvocationFailure,
  webSearchInvocationRequest,
  webSearchModeDefinition,
  webSearchArtifact,
  webSearchResultArtifact,
} from './search.ts'
import type { WebSearchAttempt, WebSearchMode } from './state.ts'

const FAILURE_CODES = {
  runtimeSkillsUnavailable: 'runtime_skills_unavailable',
} as const
import { BROWSER_SEARCH_MODE, OFFICIAL_SEARCH_MODE, WEB_SEARCH_CANDIDATES_MODE } from './state.ts'

const WEB_SEARCH_OUTPUT_MISSING_CODE = 'web_search_output_missing'
const OFFICIAL_SEARCH_ROUTE = '/api/resource/web-search'
const FALLBACK_SEARCH_ROUTE = '/api/resource/web-search/fallback'
const OFFICIAL_SEARCH_REQUEST_FAILED = 'official_search_request_failed'
const OFFICIAL_SEARCH_RESPONSE_INVALID = 'official_search_response_invalid'
const SEARCH_INTERRUPTED_STATUS = 'interrupted'

function automaticArtifactPath(mode: WebSearchMode): string | undefined {
  if (mode === OFFICIAL_SEARCH_MODE) return AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH
  if (mode === BROWSER_SEARCH_MODE) return AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH
  return undefined
}

function invocationFailureStatus(result: {
  code?: string
  terminal?: AgentInvocationEvent
}): 'failed' | 'interrupted' | 'unknown' {
  if (
    result.code === INVOCATION_ABORTED_CODE ||
    result.terminal?.type === AGENT_INVOCATION_INTERRUPTED_EVENT
  ) {
    return 'interrupted'
  }
  if (result.terminal?.type === AGENT_INVOCATION_UNKNOWN_EVENT) return 'unknown'
  return 'failed'
}

export type WebSearchCapabilityAvailability = Partial<
  Record<RuntimeCapabilityRequirement, boolean>
> & { ready?: boolean; skills?: boolean; runtimeError?: string }

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

export type WebSearchAttemptObserver = (attempt: WebSearchAttempt, index: number) => void

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
      status:
        result.code === INVOCATION_ABORTED_CODE
          ? 'interrupted'
          : result.terminal?.type === AGENT_INVOCATION_INTERRUPTED_EVENT
            ? 'interrupted'
            : result.terminal?.type === AGENT_INVOCATION_UNKNOWN_EVENT
              ? 'unknown'
              : 'failed',
      error: webSearchInvocationFailure(result.error, definition.executionError),
      errorCode: result.code || result.error,
      httpStatus: result.status,
    }
  }

  let resultText = typeof result.terminal.data.text === 'string' ? result.terminal.data.text : ''
  const artifact = webSearchResultArtifact(result.terminal, mode)
  if (definition.resultArtifactPath && !artifact) {
    return {
      ok: false,
      status: 'failed',
      error: definition.executionError,
      errorCode: WEB_SEARCH_OUTPUT_MISSING_CODE,
      httpStatus: result.status,
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
        httpStatus: downloaded.status,
      }
    }
    resultText = downloaded.text
  }
  return { ok: true, status: 'completed', resultText, httpStatus: result.status }
}

function automaticArtifactPaths(
  terminal: AgentInvocationEvent
): Array<{ path: string; artifactId: string }> {
  return [AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH]
    .map((path) => {
      const artifact = webSearchArtifact(terminal, path)
      return artifact ? { path, artifactId: artifact.artifact_id } : null
    })
    .filter((value): value is { path: string; artifactId: string } => value !== null)
}

/** Execute the automatic provider chain inside one Invocation and Runtime session. */
export async function runWebSearchRoute(
  query: string,
  capabilities: WebSearchCapabilityAvailability,
  onAttempt: WebSearchAttemptObserver,
  signal: AbortSignal
): Promise<WebSearchRouteResult> {
  const attempts: WebSearchAttempt[] = []
  const startedAt = Date.now()
  const officialAttempt: WebSearchAttempt = {
    mode: OFFICIAL_SEARCH_MODE,
    startedAt,
    invocationEvents: [],
    eventObservedAt: {},
    status: 'running',
  }
  onAttempt(officialAttempt, 0)
  try {
    const response = await apiFetch(OFFICIAL_SEARCH_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, limit: WEB_SEARCH_CANDIDATE_LIMIT }),
      signal,
    })
    if (signal.aborted) throw new DOMException(INVOCATION_ABORTED_CODE, 'AbortError')
    if (!response.ok) throw new Error(OFFICIAL_SEARCH_REQUEST_FAILED)
    const text = await response.text()
    const value = JSON.parse(text) as {
      status?: string
      search_id?: string
      error?: { code?: string }
    }
    if (value.status === SEARCH_INTERRUPTED_STATUS)
      throw new DOMException(INVOCATION_ABORTED_CODE, 'AbortError')
    const projection = projectOfficialWebSearch(text, query, value.search_id ?? '')
    if (!projection.executionEvidenceFound || !projection.structuredOutputFound) {
      throw new Error(OFFICIAL_SEARCH_RESPONSE_INVALID)
    }
    const failed = value.status === 'failed' || value.status === 'unavailable'
    if (!failed && value.status !== 'completed' && value.status !== 'empty')
      throw new Error(OFFICIAL_SEARCH_RESPONSE_INVALID)
    const attempt: WebSearchAttempt = {
      ...officialAttempt,
      completedAt: Date.now(),
      officialSearchId: value.search_id,
      resultText: text,
      httpStatus: response.status,
      status: failed ? 'failed' : 'completed',
      ...(failed ? { error: projection.error, errorCode: value.error?.code } : {}),
    }
    attempts.push(attempt)
    onAttempt(attempt, 0)
    if (!failed)
      return { ok: true, status: 'completed', attempts, resolvedMode: OFFICIAL_SEARCH_MODE }
  } catch (error) {
    const interrupted =
      signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
    const status = interrupted ? 'interrupted' : 'failed'
    const message = interrupted ? INVOCATION_ABORTED_CODE : OFFICIAL_SEARCH_REQUEST_FAILED
    const attempt: WebSearchAttempt = {
      ...officialAttempt,
      completedAt: Date.now(),
      status,
      error: message,
    }
    onAttempt(attempt, 0)
    return { ok: false, status, attempts: [attempt], error: message }
  }
  if (signal.aborted)
    return { ok: false, status: 'interrupted', attempts, error: INVOCATION_ABORTED_CODE }
  if (capabilities.ready === false || capabilities.skills === false) {
    return {
      ok: false,
      status: 'failed',
      attempts,
      error: capabilities.runtimeError || FAILURE_CODES.runtimeSkillsUnavailable,
    }
  }
  let attempt: WebSearchAttempt = {
    mode: WEB_SEARCH_CANDIDATES_MODE,
    invocationProfile: FALLBACK_SEARCH_PROFILE,
    startedAt: Date.now(),
    invocationEvents: [],
    eventObservedAt: {},
    status: 'opening',
  }
  const publish = (): void => {
    if (!signal.aborted) onAttempt(attempt, attempts.length)
  }
  let readyArtifactId: string | undefined
  publish()
  const result = await streamInvocationEvents(
    FALLBACK_SEARCH_ROUTE,
    {
      query,
      limit: WEB_SEARCH_CANDIDATE_LIMIT,
      native_available: capabilities.web_search === true,
    },
    async (event) => {
      if (signal.aborted) return
      if (!isWebSearchProjectionEvent(event)) return
      const observedAt = Date.now()
      const invocationEvents = appendWebSearchProjectionEvent(attempt.invocationEvents, event)
      attempt = {
        ...attempt,
        invocationId: event.invocation_id,
        invocationStartedAt:
          attempt.invocationStartedAt ??
          (event.type === AGENT_INVOCATION_STARTED_EVENT ? observedAt : undefined),
        status: 'running',
        invocationEvents,
        eventObservedAt: Object.fromEntries(
          invocationEvents.map((retained) => [
            retained.seq,
            retained.seq === event.seq
              ? observedAt
              : (attempt.eventObservedAt[retained.seq] ?? observedAt),
          ])
        ),
      }
      publish()
      if (
        event.type !== WEB_SEARCH_RESULT_READY_EVENT ||
        event.data.provider !== BROWSER_SEARCH_MODE ||
        event.data.completion_reason !== WEB_SEARCH_RESULT_CONTRACT_SATISFIED ||
        attempt.resultReadyAt !== undefined
      )
        return
      const started = invocationEvents.find(
        (retained) => retained.type === AGENT_INVOCATION_STARTED_EVENT
      )
      const skill = started?.data.skill as { profile?: unknown } | undefined
      if (skill?.profile !== FALLBACK_SEARCH_PROFILE || !event.turn_id) return
      const artifact = webSearchArtifact(event, AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH)
      if (
        !artifact ||
        !invocationEvents.some(
          (retained) =>
            retained.type === 'artifact.published' &&
            retained.turn_id === event.turn_id &&
            retained.data.artifact_id === artifact.artifact_id &&
            retained.data.relative_path === artifact.relative_path &&
            retained.data.role === artifact.role &&
            retained.data.sha256 === artifact.sha256 &&
            retained.data.size_bytes === artifact.size_bytes &&
            retained.data.mime_type === artifact.mime_type
        )
      )
        return
      let resultText = typeof event.data.text === 'string' ? event.data.text : ''
      if (!resultText) {
        const downloaded = await readAgentInvocationArtifactText(
          event.invocation_id,
          artifact.artifact_id,
          signal
        )
        if (!downloaded.ok || signal.aborted) return
        resultText = downloaded.text
      }
      let output: { query?: unknown }
      try {
        output = JSON.parse(resultText) as { query?: unknown }
      } catch {
        return
      }
      if (!output || output.query !== query || signal.aborted) return
      const automatic = projectAutomaticWebSearch(
        invocationEvents,
        query,
        { [AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH]: resultText },
        FALLBACK_SEARCH_PROFILE,
        WEB_SEARCH_FALLBACK_ROUTE
      )
      if (
        automatic.resolvedMode !== BROWSER_SEARCH_MODE ||
        !automatic.projection.executionEvidenceFound ||
        !automatic.projection.structuredOutputFound ||
        automatic.projection.error
      )
        return
      attempt = {
        ...attempt,
        mode: BROWSER_SEARCH_MODE,
        artifactPath: AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH,
        resultReadyAt: Date.now(),
        resultText,
      }
      readyArtifactId = artifact.artifact_id
      publish()
    },
    signal
  )
  const completedAt = Date.now()
  if (!result.ok) {
    const status = invocationFailureStatus(result)
    attempt = {
      ...attempt,
      completedAt,
      status,
      error: result.error,
      ...(result.code ? { errorCode: result.code } : {}),
      httpStatus: result.status,
    }
    publish()
    return { ok: false, status, attempts: [...attempts, attempt], error: result.error }
  }

  const resultTexts: Record<string, string> = {
    [WEB_SEARCH_CANDIDATES_MODE]:
      typeof result.terminal.data.text === 'string' ? result.terminal.data.text : '',
  }
  for (const artifact of automaticArtifactPaths(result.terminal)) {
    if (artifact.artifactId === readyArtifactId && attempt.resultText !== undefined) {
      resultTexts[artifact.path] = attempt.resultText
      continue
    }
    const downloaded = await readAgentInvocationArtifactText(
      result.terminal.invocation_id,
      artifact.artifactId,
      signal
    )
    if (downloaded.ok) resultTexts[artifact.path] = downloaded.text
  }
  const automatic = projectAutomaticWebSearch(
    attempt.invocationEvents,
    query,
    resultTexts,
    FALLBACK_SEARCH_PROFILE,
    WEB_SEARCH_FALLBACK_ROUTE
  )
  const resolvedMode = automatic.resolvedMode
  const executedModes: WebSearchMode[] = WEB_SEARCH_FALLBACK_ROUTE.filter((mode) =>
    mode === WEB_SEARCH_CANDIDATES_MODE
      ? attempt.invocationEvents.some((event) => event.type === 'web_search.completed')
      : attempt.invocationEvents.some(
          (event) =>
            event.type === 'artifact.published' &&
            event.data.role === 'final' &&
            event.data.relative_path === AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH
        )
  )
  const modes: WebSearchMode[] =
    executedModes.length > 0 ? executedModes : [WEB_SEARCH_CANDIDATES_MODE]
  const finalText =
    resolvedMode === WEB_SEARCH_CANDIDATES_MODE
      ? (resultTexts[WEB_SEARCH_CANDIDATES_MODE] ?? '')
      : resolvedMode === OFFICIAL_SEARCH_MODE
        ? (resultTexts[AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH] ?? '')
        : (resultTexts[AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH] ?? '')
  attempts.push(
    ...modes.map((mode): WebSearchAttempt => {
      const status: WebSearchAttempt['status'] = mode === resolvedMode ? 'completed' : 'failed'
      const artifactPath = automaticArtifactPath(mode)
      return {
        ...attempt,
        mode,
        completedAt,
        resultReadyAt: mode === resolvedMode ? attempt.resultReadyAt : undefined,
        ...(artifactPath ? { artifactPath } : {}),
        resultText: finalText,
        status,
        ...(mode === resolvedMode ? {} : { error: webSearchModeDefinition(mode).executionError }),
        httpStatus: result.status,
      }
    })
  )
  attempts.forEach((value, index) => onAttempt(value, index))
  if (!resolvedMode || automatic.projection.error) {
    return {
      ok: false,
      status: 'failed',
      attempts,
      error: automatic.projection.error || WEB_SEARCH_OUTPUT_MISSING_CODE,
    }
  }
  return { ok: true, status: 'completed', attempts, resolvedMode }
}
