import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInvocationArtifact, AgentInvocationEvent } from '../../contracts/invocation.ts'
import {
  AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH,
  AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH,
  FALLBACK_SEARCH_PROFILE,
  WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
} from './search.ts'
import { projectWebSearch, verifiedWebSearchCandidates } from './search.ts'
import { BROWSER_SEARCH_MODE, OFFICIAL_SEARCH_MODE, WEB_SEARCH_CANDIDATES_MODE } from './state.ts'
import { runWebSearchRoute, type WebSearchAttemptObserver } from './driver.ts'

const API_BASE = 'http://service.test'
const QUERY = 'test query'
const FALLBACK_ROUTE = '/api/resource/web-search/fallback'

interface ResourceFallbackRequest {
  query: string
  limit: number
  native_available: boolean
}

function event(
  invocationId: string,
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
  itemId = ''
): AgentInvocationEvent {
  return {
    schema_version: 1,
    invocation_id: invocationId,
    seq,
    type,
    turn_id: `${invocationId}-turn`,
    item_id: itemId,
    data,
    created_at: 1_788_800_000 + seq,
  }
}

function artifact(path: string, id: string): AgentInvocationArtifact {
  return {
    artifact_id: id,
    relative_path: path,
    role: 'final',
    mime_type: 'application/json',
    size_bytes: 128,
    sha256: 'a'.repeat(64),
  }
}

const officialArtifact = artifact(AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH, 'official-artifact')
const browserArtifact = artifact(AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH, 'browser-artifact')

function automaticStarted(): AgentInvocationEvent {
  return event('automatic-invocation', 1, 'invocation.started', {
    skill: { id: 'builtin:web-search', profile: 'fallback' },
    execution: { permission_mode: 'bypassPermissions' },
  })
}

function officialResult(status: 'empty' | 'unavailable' = 'empty'): string {
  return JSON.stringify({
    schema: 'scholarseed.web_search.v1',
    status,
    provider: OFFICIAL_SEARCH_MODE,
    query: QUERY,
    candidates: [],
    started_at: '2026-09-08T06:30:00.000Z',
    completed_at: '2026-09-08T06:30:01.000Z',
    duration_ms: 1000,
    error: status === 'empty' ? null : { code: 'credential_unavailable', message: 'missing' },
  })
}

function browserResult(): string {
  return JSON.stringify({
    schema: 'scholarseed.web_search.v1',
    status: 'empty',
    provider: BROWSER_SEARCH_MODE,
    query: QUERY,
    engine: 'bing',
    browser: 'chrome',
    started_at: '2026-09-08T06:30:00.000Z',
    completed_at: '2026-09-08T06:30:01.000Z',
    duration_ms: 1000,
    candidates: [],
    error: null,
  })
}

function nativeResult(): string {
  return `<scholarseed_web_search_results>${JSON.stringify({
    schema: WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
    status: 'empty',
    provider: WEB_SEARCH_CANDIDATES_MODE,
    query: QUERY,
    candidates: [],
    error: null,
  })}</scholarseed_web_search_results>`
}

function response(events: AgentInvocationEvent[]): Response {
  return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function runWithEvents(
  events: AgentInvocationEvent[],
  artifacts: Record<string, string | (() => Promise<string>)> = {},
  directResult = officialResult('unavailable'),
  capabilities = { web_search: true, ready: true, skills: true },
  signal = new AbortController().signal,
  observer: WebSearchAttemptObserver = () => undefined,
  stream?: ReadableStream<Uint8Array>
): Promise<{
  requests: ResourceFallbackRequest[]
  result: Awaited<ReturnType<typeof runWebSearchRoute>>
}> {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests: ResourceFallbackRequest[] = []
  globalThis.window = {
    scholarseed: { getApiBase: () => API_BASE },
    dispatchEvent: () => true,
  } as unknown as Window & typeof globalThis
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/api/resource/web-search')) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
      assert.equal(init?.signal, signal)
      const value = JSON.parse(directResult)
      return new Response(JSON.stringify({ ...value, search_id: 'official-search' }), {
        status: 200,
      })
    }
    if (init?.method === 'POST') {
      assert.equal(url, API_BASE + FALLBACK_ROUTE)
      requests.push(JSON.parse(String(init.body)) as ResourceFallbackRequest)
      return stream
        ? new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        : response(events)
    }
    const artifactId = url.split('/').at(-1) ?? ''
    assert.ok(artifacts[artifactId], `missing artifact ${artifactId}`)
    const artifactText = artifacts[artifactId]
    return new Response(typeof artifactText === 'function' ? await artifactText() : artifactText, {
      status: 200,
    })
  }
  try {
    const result = await runWebSearchRoute(QUERY, capabilities, observer, signal)
    return { requests, result }
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
}

test('official empty result does not create an Invocation or require a model', async () => {
  const events = [
    automaticStarted(),
    event(
      'automatic-invocation',
      2,
      'artifact.published',
      officialArtifact as unknown as Record<string, unknown>
    ),
    event('automatic-invocation', 3, 'result.completed', {
      artifacts: [officialArtifact],
      text: 'done',
    }),
  ]
  const { requests, result } = await runWithEvents(events, {}, officialResult(), {
    web_search: false,
    ready: false,
    skills: false,
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.resolvedMode, OFFICIAL_SEARCH_MODE)
  assert.equal(requests.length, 0)
  assert.equal(result.attempts[0]?.invocationId, undefined)
  assert.equal(result.attempts[0]?.officialSearchId, 'official-search')
})

test('automatic route falls back to native in the same Invocation', async () => {
  const events = [
    automaticStarted(),
    event(
      'automatic-invocation',
      2,
      'web_search.completed',
      { query: QUERY, result_count: 0 },
      'native-search'
    ),
    event('automatic-invocation', 3, 'result.completed', { text: nativeResult(), artifacts: [] }),
  ]
  const { requests, result } = await runWithEvents(events)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.resolvedMode, WEB_SEARCH_CANDIDATES_MODE)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0], { query: QUERY, limit: 20, native_available: true })
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.invocationId),
    [undefined, 'automatic-invocation']
  )
  const attempt = result.attempts.at(-1)!
  assert.equal(
    projectWebSearch(
      attempt.invocationEvents,
      attempt.mode,
      attempt.resultText,
      QUERY,
      attempt.artifactPath,
      attempt.officialSearchId,
      attempt.invocationProfile
    ).executionEvidenceFound,
    true
  )
})

test('automatic route reads browser fallback from its immutable artifact path', async () => {
  const events = [
    automaticStarted(),
    event(
      'automatic-invocation',
      2,
      'web_search.completed',
      { query: QUERY, result_count: 0 },
      'native-search'
    ),
    event(
      'automatic-invocation',
      3,
      'artifact.published',
      browserArtifact as unknown as Record<string, unknown>
    ),
    event('automatic-invocation', 4, 'result.completed', {
      artifacts: [browserArtifact],
      text: 'done',
    }),
  ]
  const { requests, result } = await runWithEvents(events, {
    'browser-artifact': browserResult(),
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.resolvedMode, BROWSER_SEARCH_MODE)
  assert.equal(requests.length, 1)
  if (result.ok) {
    assert.equal(result.attempts.at(-1)?.artifactPath, AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH)
    const attempt = result.attempts.at(-1)!
    assert.equal(
      projectWebSearch(
        attempt.invocationEvents,
        attempt.mode,
        attempt.resultText,
        QUERY,
        attempt.artifactPath,
        attempt.officialSearchId,
        attempt.invocationProfile
      ).executionEvidenceFound,
      true
    )
  }
})

test('official success projects candidates with real HTTP identity and no Agent events', async () => {
  const value = {
    ...JSON.parse(officialResult()),
    status: 'completed',
    candidates: [
      { title: 'Page', url: 'https://example.com/page', description: 'Search candidate' },
    ],
  }
  const { requests, result } = await runWithEvents([], {}, JSON.stringify(value))
  assert.equal(requests.length, 0)
  assert.equal(result.ok, true)
  const attempt = result.attempts[0]!
  const projection = projectWebSearch(
    [],
    attempt.mode,
    attempt.resultText,
    QUERY,
    undefined,
    attempt.officialSearchId
  )
  assert.equal(verifiedWebSearchCandidates(projection).length, 1)
})

test('unavailable native capability starts browser in one fallback Invocation', async () => {
  const events = [
    automaticStarted(),
    event(
      'automatic-invocation',
      2,
      'artifact.published',
      browserArtifact as unknown as Record<string, unknown>
    ),
    event('automatic-invocation', 3, 'result.completed', {
      artifacts: [browserArtifact],
      text: 'done',
    }),
  ]
  const { requests, result } = await runWithEvents(
    events,
    { 'browser-artifact': browserResult() },
    officialResult('unavailable'),
    { web_search: false, ready: true, skills: true }
  )
  assert.equal(result.ok, true)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.native_available, false)
})

test('cancelled direct search never starts a fallback Invocation', async () => {
  const controller = new AbortController()
  controller.abort()
  const { requests, result } = await runWithEvents(
    [],
    {},
    officialResult(),
    { web_search: true, ready: true, skills: true },
    controller.signal
  )
  assert.equal(requests.length, 0)
  assert.equal(result.status, 'interrupted')
})

test('model unavailability only blocks fallback, not the official attempt', async () => {
  const { requests, result } = await runWithEvents([], {}, officialResult('unavailable'), {
    web_search: false,
    ready: false,
    skills: false,
  })
  assert.equal(requests.length, 0)
  assert.equal(result.ok, false)
})

function browserReady(sequence = 3, patch: Record<string, unknown> = {}): AgentInvocationEvent {
  return event('automatic-invocation', sequence, 'result.ready', {
    text: browserResult(),
    provider: BROWSER_SEARCH_MODE,
    artifacts: [browserArtifact],
    completion_reason: 'result_contract_satisfied',
    ...patch,
  })
}

test('browser result readiness accepts inherited executable modes without requesting elevation', async () => {
  const candidates = [
    {
      title: 'Public result',
      url: 'https://example.com/result',
      description: 'Real candidate shape',
    },
  ]
  const text = JSON.stringify({
    ...JSON.parse(browserResult()),
    status: 'completed',
    browser: 'embedded',
    candidates,
  })
  for (const permissionMode of ['ask', 'safe_auto', 'bypassPermissions']) {
    const started = automaticStarted()
    started.data.execution = { permission_mode: permissionMode }
    const events = [
      started,
      event(
        'automatic-invocation',
        2,
        'artifact.published',
        browserArtifact as unknown as Record<string, unknown>
      ),
      browserReady(3, { text }),
      event('automatic-invocation', 4, 'result.completed', {
        text,
        artifacts: [browserArtifact],
        runtime_outcome: 'interrupted',
        completion_reason: 'result_contract_satisfied',
      }),
    ]
    const { result, requests } = await runWithEvents(events, { 'browser-artifact': text })
    assert.equal(result.ok, true, permissionMode)
    const attempt = result.attempts.at(-1)!
    assert.ok(attempt.resultReadyAt, permissionMode)
    const projection = projectWebSearch(
      attempt.invocationEvents,
      attempt.mode,
      attempt.resultText,
      QUERY,
      attempt.artifactPath,
      attempt.officialSearchId,
      attempt.invocationProfile
    )
    assert.equal(verifiedWebSearchCandidates(projection).length, candidates.length, permissionMode)
    assert.deepEqual(requests, [{ query: QUERY, limit: 20, native_available: true }])
  }
})

test('browser result readiness still rejects read-only, missing and unknown execution modes', async () => {
  for (const permissionMode of ['read_only', 'read-only', 'unknown', undefined]) {
    const started = automaticStarted()
    started.data.execution = permissionMode === undefined ? {} : { permission_mode: permissionMode }
    const events = [
      started,
      event(
        'automatic-invocation',
        2,
        'artifact.published',
        browserArtifact as unknown as Record<string, unknown>
      ),
      browserReady(),
      event('automatic-invocation', 4, 'result.completed', {
        text: browserResult(),
        artifacts: [browserArtifact],
      }),
    ]
    const { result } = await runWithEvents(events, { 'browser-artifact': browserResult() })
    assert.equal(result.ok, false, String(permissionMode))
    assert.equal(result.attempts.at(-1)?.resultReadyAt, undefined)
  }
})

test('resource browser fallback retains real candidates without snippets through ready and terminal', async () => {
  const text = JSON.stringify({
    ...JSON.parse(browserResult()),
    status: 'completed',
    candidates: [
      { title: 'Paper without snippet', url: 'https://example.com/paper', description: '' },
    ],
  })
  const events = [
    automaticStarted(),
    event(
      'automatic-invocation',
      2,
      'artifact.published',
      browserArtifact as unknown as Record<string, unknown>
    ),
    browserReady(3, { text }),
    event('automatic-invocation', 4, 'result.completed', {
      text,
      artifacts: [browserArtifact],
      runtime_outcome: 'interrupted',
      completion_reason: 'result_contract_satisfied',
    }),
  ]
  let readyCandidates = 0
  const { result } = await runWithEvents(
    events,
    { 'browser-artifact': text },
    officialResult('unavailable'),
    { web_search: false, ready: true, skills: true },
    new AbortController().signal,
    (attempt) => {
      if (!attempt.resultReadyAt) return
      const projection = projectWebSearch(
        attempt.invocationEvents,
        attempt.mode,
        attempt.resultText,
        QUERY,
        attempt.artifactPath,
        attempt.officialSearchId,
        attempt.invocationProfile
      )
      const candidates = verifiedWebSearchCandidates(projection)
      assert.equal(candidates.length, 1)
      assert.equal(candidates[0]?.description, '')
      assert.equal(candidates[0]?.title, 'Paper without snippet')
      readyCandidates += 1
    }
  )
  assert.equal(result.ok, true)
  assert.ok(readyCandidates > 0)
})

test('optional snippets are restricted to resource browser fallback and retain title and URL checks', () => {
  const candidates = [
    { title: 'Paper without snippet', url: 'https://example.com/paper', description: '' },
    { title: '', url: 'https://example.com/empty-title', description: '' },
    { title: 'Invalid URL', url: 'javascript:void(0)', description: '' },
    { title: 'Invalid description', url: 'https://example.com/missing', description: null },
  ]
  for (const mode of [BROWSER_SEARCH_MODE, OFFICIAL_SEARCH_MODE] as const) {
    const text = JSON.stringify({
      ...JSON.parse(browserResult()),
      provider: mode,
      status: 'completed',
      candidates,
    })
    for (const profile of [undefined, 'automatic', FALLBACK_SEARCH_PROFILE]) {
      const projection = projectWebSearch([], mode, text, QUERY, undefined, undefined, profile)
      assert.equal(
        projection.candidates.length,
        mode === BROWSER_SEARCH_MODE && profile === FALLBACK_SEARCH_PROFILE ? 1 : 0
      )
    }
  }
})

test('validated browser results become ready before terminal cleanup and remain running', async () => {
  const channel = new TransformStream<Uint8Array, Uint8Array>()
  const writer = channel.writable.getWriter()
  let reportReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    reportReady = resolve
  })
  let settled = false
  const running = runWithEvents(
    [],
    { 'browser-artifact': browserResult() },
    officialResult('unavailable'),
    { web_search: false, ready: true, skills: true },
    new AbortController().signal,
    (attempt) => {
      if (attempt.resultReadyAt === undefined || attempt.status === 'completed') return
      assert.equal(attempt.status, 'running')
      assert.equal(attempt.mode, BROWSER_SEARCH_MODE)
      assert.equal(attempt.completedAt, undefined)
      assert.equal(attempt.resultText, browserResult())
      reportReady()
    },
    channel.readable
  ).then((result) => {
    settled = true
    return result
  })
  const send = async (value: AgentInvocationEvent): Promise<void> => {
    await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`))
  }
  await send(automaticStarted())
  await send(
    event(
      'automatic-invocation',
      2,
      'artifact.published',
      browserArtifact as unknown as Record<string, unknown>
    )
  )
  await send(browserReady())
  await ready
  assert.equal(settled, false)
  await send(
    event('automatic-invocation', 4, 'result.completed', {
      text: browserResult(),
      artifacts: [browserArtifact],
      runtime_outcome: 'interrupted',
      completion_reason: 'result_contract_satisfied',
    })
  )
  await writer.close()
  const { result } = await running
  assert.equal(result.ok, true)
  assert.ok(result.attempts.at(-1)?.resultReadyAt)
})

test('cleanup failure after ready remains a visible failure with verified results retained', async () => {
  const events = [
    automaticStarted(),
    event(
      'automatic-invocation',
      2,
      'artifact.published',
      browserArtifact as unknown as Record<string, unknown>
    ),
    browserReady(),
    event('automatic-invocation', 4, 'invocation.unknown', { error: 'cleanup_failed' }),
  ]
  const { result } = await runWithEvents(events)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'unknown')
  assert.equal(result.attempts.at(-1)?.resultText, browserResult())
  assert.ok(result.attempts.at(-1)?.resultReadyAt)
})

test('ready rejects mismatched query, publication digest and profile', async () => {
  for (const mismatch of ['query', 'digest', 'profile']) {
    const started = automaticStarted()
    if (mismatch === 'profile')
      started.data.skill = { id: 'builtin:web-search', profile: 'automatic' }
    const ready = browserReady(
      3,
      mismatch === 'query'
        ? { text: JSON.stringify({ ...JSON.parse(browserResult()), query: 'another query' }) }
        : mismatch === 'digest'
          ? { artifacts: [{ ...browserArtifact, sha256: 'b'.repeat(64) }] }
          : {}
    )
    let earlyResults = 0
    const { result } = await runWithEvents(
      [
        started,
        event(
          'automatic-invocation',
          2,
          'artifact.published',
          browserArtifact as unknown as Record<string, unknown>
        ),
        ready,
        event('automatic-invocation', 4, 'invocation.failed', { error: 'invalid_result' }),
      ],
      {},
      officialResult('unavailable'),
      { web_search: false, ready: true, skills: true },
      new AbortController().signal,
      (attempt) => {
        if (attempt.resultReadyAt !== undefined) earlyResults += 1
      }
    )
    assert.equal(earlyResults, 0, mismatch)
    assert.equal(result.ok, false)
  }
})

test('aborting after ready does not emit late execution updates', async () => {
  const controller = new AbortController()
  let lateUpdates = 0
  let sawReady = false
  const { result } = await runWithEvents(
    [
      automaticStarted(),
      event(
        'automatic-invocation',
        2,
        'artifact.published',
        browserArtifact as unknown as Record<string, unknown>
      ),
      browserReady(),
      event('automatic-invocation', 4, 'result.completed', {
        text: browserResult(),
        artifacts: [browserArtifact],
      }),
    ],
    {},
    officialResult('unavailable'),
    { web_search: false, ready: true, skills: true },
    controller.signal,
    (attempt) => {
      if (controller.signal.aborted) lateUpdates += 1
      if (attempt.resultReadyAt !== undefined) {
        sawReady = true
        controller.abort()
      }
    }
  )
  assert.equal(sawReady, true)
  assert.equal(lateUpdates, 0)
  assert.equal(result.status, 'interrupted')
})

test('ready downloads its published artifact when inline text is absent and reuses that immutable result', async () => {
  let downloads = 0
  let sawEarly = false
  const { result } = await runWithEvents(
    [
      automaticStarted(),
      event(
        'automatic-invocation',
        2,
        'artifact.published',
        browserArtifact as unknown as Record<string, unknown>
      ),
      browserReady(3, { text: undefined }),
      event('automatic-invocation', 4, 'result.completed', { artifacts: [browserArtifact] }),
    ],
    {
      'browser-artifact': async () => {
        downloads += 1
        return browserResult()
      },
    },
    officialResult('unavailable'),
    { web_search: false, ready: true, skills: true },
    new AbortController().signal,
    (attempt) => {
      if (attempt.status === 'running' && attempt.resultReadyAt !== undefined) sawEarly = true
    }
  )
  assert.equal(result.ok, true)
  assert.equal(sawEarly, true)
  assert.equal(downloads, 1)
})

test('aborting during a ready-artifact download cannot publish a stale result', async () => {
  const controller = new AbortController()
  let readyUpdates = 0
  const { result } = await runWithEvents(
    [
      automaticStarted(),
      event(
        'automatic-invocation',
        2,
        'artifact.published',
        browserArtifact as unknown as Record<string, unknown>
      ),
      browserReady(3, { text: undefined }),
      event('automatic-invocation', 4, 'result.completed', { artifacts: [browserArtifact] }),
    ],
    {
      'browser-artifact': async () => {
        controller.abort()
        return browserResult()
      },
    },
    officialResult('unavailable'),
    { web_search: false, ready: true, skills: true },
    controller.signal,
    (attempt) => {
      if (attempt.resultReadyAt !== undefined) readyUpdates += 1
    }
  )
  assert.equal(result.status, 'interrupted')
  assert.equal(readyUpdates, 0)
})
