/** Runtime driver for the Resource feature's isolated web-search jobs. */

import {
  AGENT_INVOCATION_INTERRUPTED_EVENT,
  AGENT_INVOCATION_STARTED_EVENT,
  AGENT_INVOCATION_UNKNOWN_EVENT,
  type AgentInvocationEvent
} from '../../contracts/invocation.ts'
import {
  INVOCATION_ABORTED_CODE,
  readAgentInvocationArtifactText,
  streamAgentInvocation
} from '../../invocation.ts'
import type { RuntimeCapabilityRequirement } from '../../model.ts'
import {
  appendWebSearchProjectionEvent,
  automaticWebSearchInvocationRequest,
  AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH,
  AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH,
  isWebSearchProjectionEvent,
  projectAutomaticWebSearch,
  WEB_SEARCH_AUTOMATIC_ROUTE,
  webSearchInvocationFailure,
  webSearchInvocationRequest,
  webSearchModeDefinition,
  webSearchArtifact,
  webSearchResultArtifact
} from './search.ts'
import type {
  WebSearchAttempt,
  WebSearchMode
} from './state.ts'
import {
  BROWSER_SEARCH_MODE,
  OFFICIAL_SEARCH_MODE,
  WEB_SEARCH_CANDIDATES_MODE
} from './state.ts'

const WEB_SEARCH_OUTPUT_MISSING_CODE = 'web_search_output_missing'

function automaticArtifactPath(mode: WebSearchMode): string | undefined {
  if (mode === OFFICIAL_SEARCH_MODE) return AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH
  if (mode === BROWSER_SEARCH_MODE) return AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH
  return undefined
}

function invocationFailureStatus(
  result: {
    code?: string
    terminal?: AgentInvocationEvent
  }
): 'failed' | 'interrupted' | 'unknown' {
  if (result.code === INVOCATION_ABORTED_CODE
    || result.terminal?.type === AGENT_INVOCATION_INTERRUPTED_EVENT) {
    return 'interrupted'
  }
  if (result.terminal?.type === AGENT_INVOCATION_UNKNOWN_EVENT) return 'unknown'
  return 'failed'
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

function automaticArtifactPaths(
  terminal: AgentInvocationEvent
): Array<{ path: string; artifactId: string }> {
  return [AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH, AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH]
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
  void capabilities
  const attempts: WebSearchAttempt[] = []
  const startedAt = Date.now()
  let attempt: WebSearchAttempt = {
    mode: OFFICIAL_SEARCH_MODE,
    startedAt,
    invocationEvents: [],
    eventObservedAt: {},
    status: 'opening'
  }
  const publish = (): void => onAttempt(attempt, 0)
  publish()
  const result = await streamAgentInvocation(
    automaticWebSearchInvocationRequest(query),
    (event) => {
      if (!isWebSearchProjectionEvent(event)) return
      const observedAt = Date.now()
      const invocationEvents = appendWebSearchProjectionEvent(attempt.invocationEvents, event)
      attempt = {
        ...attempt,
        invocationId: event.invocation_id,
        invocationStartedAt: attempt.invocationStartedAt
          ?? (event.type === AGENT_INVOCATION_STARTED_EVENT ? observedAt : undefined),
        status: 'running',
        invocationEvents,
        eventObservedAt: Object.fromEntries(invocationEvents.map((retained) => [
          retained.seq,
          retained.seq === event.seq
            ? observedAt
            : attempt.eventObservedAt[retained.seq] ?? observedAt
        ]))
      }
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
      httpStatus: result.status
    }
    publish()
    return { ok: false, status, attempts: [attempt], error: result.error }
  }

  const resultTexts: Record<string, string> = {
    [WEB_SEARCH_CANDIDATES_MODE]: typeof result.terminal.data.text === 'string'
      ? result.terminal.data.text
      : ''
  }
  for (const artifact of automaticArtifactPaths(result.terminal)) {
    const downloaded = await readAgentInvocationArtifactText(
      result.terminal.invocation_id,
      artifact.artifactId,
      signal
    )
    if (downloaded.ok) resultTexts[artifact.path] = downloaded.text
  }
  const automatic = projectAutomaticWebSearch(attempt.invocationEvents, query, resultTexts)
  const resolvedMode = automatic.resolvedMode
  const executedModes: WebSearchMode[] = WEB_SEARCH_AUTOMATIC_ROUTE.filter((mode) => (
    mode === WEB_SEARCH_CANDIDATES_MODE
      ? attempt.invocationEvents.some((event) => event.type === 'web_search.completed')
      : attempt.invocationEvents.some((event) => (
        event.type === 'artifact.published'
          && event.data.role === 'final'
          && event.data.relative_path === (
            mode === OFFICIAL_SEARCH_MODE
              ? AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH
              : AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH
          )
      ))
  ))
  const modes: WebSearchMode[] = executedModes.length > 0
    ? executedModes
    : [OFFICIAL_SEARCH_MODE]
  const finalText = resolvedMode === WEB_SEARCH_CANDIDATES_MODE
    ? resultTexts[WEB_SEARCH_CANDIDATES_MODE] ?? ''
    : resolvedMode === OFFICIAL_SEARCH_MODE
      ? resultTexts[AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH] ?? ''
      : resultTexts[AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH] ?? ''
  attempts.push(...modes.map((mode): WebSearchAttempt => {
    const status: WebSearchAttempt['status'] = mode === resolvedMode ? 'completed' : 'failed'
    const artifactPath = automaticArtifactPath(mode)
    return {
      ...attempt,
      mode,
      completedAt,
      ...(artifactPath ? { artifactPath } : {}),
      resultText: finalText,
      status,
      ...(mode === resolvedMode ? {} : { error: webSearchModeDefinition(mode).executionError }),
      httpStatus: result.status
    }
  }))
  attempts.forEach((value, index) => onAttempt(value, index))
  if (!resolvedMode || automatic.projection.error) {
    return {
      ok: false,
      status: 'failed',
      attempts,
      error: automatic.projection.error || WEB_SEARCH_OUTPUT_MISSING_CODE
    }
  }
  return { ok: true, status: 'completed', attempts, resolvedMode }
}
