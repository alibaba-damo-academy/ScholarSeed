import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AgentInvocationArtifact,
  AgentInvocationEvent,
  AgentInvocationRequest
} from '../../contracts/invocation.ts'
import {
  BROWSER_SEARCH_ARTIFACT_PATH,
  BROWSER_SEARCH_OUTPUT_SCHEMA_ID,
  WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
  WEB_SEARCH_INTERRUPTED_CODE
} from './search.ts'
import {
  BROWSER_SEARCH_MODE,
  OFFICIAL_SEARCH_MODE,
  WEB_SEARCH_CANDIDATES_MODE
} from './state.ts'
import { runWebSearchRoute } from './driver.ts'

const API_BASE = 'http://service.test'
const TEST_QUERY = 'test query'
const CREATED_AT = 1_788_800_000

function invocationEvent(
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
    turn_id: type === 'invocation.started' ? '' : `${invocationId}-turn`,
    item_id: itemId,
    data,
    created_at: CREATED_AT + seq
  }
}

function sseResponse(events: AgentInvocationEvent[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' }
  })
}

function nativeResultText(): string {
  return [
    '<scholarseed_web_search_results>',
    nativePlainJsonResultText(),
    '</scholarseed_web_search_results>'
  ].join('\n')
}

function nativePlainJsonResultText(): string {
  return JSON.stringify({
    schema: WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
    status: 'empty',
    provider: WEB_SEARCH_CANDIDATES_MODE,
    query: TEST_QUERY,
    candidates: [],
    error: null
  })
}

function nativeCompleted(
  includeExecutionEvidence = true,
  resultText = nativeResultText()
): AgentInvocationEvent[] {
  const events = [
    invocationEvent('native-invocation', 1, 'invocation.started', {
      skill: { id: 'builtin:web-search', name: 'web-search', profile: 'native' }
    }),
    invocationEvent('native-invocation', 2, 'plan.updated', {
      todos: [{ content: '动态搜索测试候选', status: 'in_progress' }]
    })
  ]
  if (includeExecutionEvidence) {
    events.push(
      invocationEvent(
        'native-invocation',
        3,
        'web_search.completed',
        { query: TEST_QUERY, result_count: 0 },
        'native-search'
      )
    )
  }
  events.push(invocationEvent(
    'native-invocation',
    events.length + 1,
    'result.completed',
    { text: resultText, artifacts: [] }
  ))
  return events
}

const BROWSER_ARTIFACT: AgentInvocationArtifact = {
  artifact_id: 'browser-artifact',
  relative_path: BROWSER_SEARCH_ARTIFACT_PATH,
  role: 'final',
  mime_type: 'application/json',
  size_bytes: 128,
  sha256: 'a'.repeat(64)
}
const OFFICIAL_ARTIFACT: AgentInvocationArtifact = {
  ...BROWSER_ARTIFACT,
  artifact_id: 'official-artifact'
}

function officialCompleted(): AgentInvocationEvent[] {
  return [
    invocationEvent('official-invocation', 1, 'invocation.started', {
      skill: { id: 'builtin:web-search', name: 'web-search', profile: 'official' },
      execution: {
        permission_mode: 'safe_auto',
        network_access: true,
        web_search: false
      }
    }),
    invocationEvent(
      'official-invocation',
      2,
      'artifact.published',
      OFFICIAL_ARTIFACT as unknown as Record<string, unknown>,
      'official-search'
    ),
    invocationEvent('official-invocation', 3, 'result.completed', {
      text: 'Official search completed.',
      artifacts: [OFFICIAL_ARTIFACT]
    })
  ]
}

function browserCompleted(): AgentInvocationEvent[] {
  return [
    invocationEvent('browser-invocation', 1, 'invocation.started', {
      skill: { id: 'builtin:web-search', name: 'web-search', profile: 'browser' },
      execution: {
        permission_mode: 'bypassPermissions',
        network_access: true,
        web_search: false
      }
    }),
    invocationEvent(
      'browser-invocation',
      2,
      'artifact.published',
      BROWSER_ARTIFACT as unknown as Record<string, unknown>,
      'browser-search'
    ),
    invocationEvent('browser-invocation', 3, 'result.completed', {
      text: 'Browser search completed.',
      artifacts: [BROWSER_ARTIFACT]
    })
  ]
}

function browserResultText(
  status: 'empty' | 'failed' = 'empty',
  error: { code: string; message: string } | null = null
): string {
  return JSON.stringify({
    schema: BROWSER_SEARCH_OUTPUT_SCHEMA_ID,
    status,
    provider: BROWSER_SEARCH_MODE,
    query: TEST_QUERY,
    engine: 'bing',
    browser: 'chrome',
    started_at: '2026-09-08T06:30:00.000Z',
    completed_at: '2026-09-08T06:30:01.000Z',
    duration_ms: 1000,
    candidates: [],
    error
  })
}

function officialResultText(
  status: 'empty' | 'unavailable' | 'failed' = 'empty',
  error: { code: string; message: string } | null = null,
  diagnostics: Record<string, unknown> | null = null
): string {
  return JSON.stringify({
    schema: BROWSER_SEARCH_OUTPUT_SCHEMA_ID,
    status,
    provider: OFFICIAL_SEARCH_MODE,
    query: TEST_QUERY,
    started_at: '2026-09-08T06:30:00.000Z',
    completed_at: '2026-09-08T06:30:01.000Z',
    duration_ms: 1000,
    candidates: [],
    error,
    diagnostics
  })
}

async function withInvocationResponses(
  responses: Array<AgentInvocationEvent[] | { status: number; detail: string }>,
  run: (requests: AgentInvocationRequest[]) => Promise<void>,
  artifactTexts: Record<string, string> = {
    'browser-artifact': browserResultText(),
    'official-artifact': officialResultText()
  }
): Promise<void> {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests: AgentInvocationRequest[] = []
  let invocationIndex = 0
  globalThis.window = {
    scholarseed: { getApiBase: () => API_BASE },
    dispatchEvent: () => true
  } as unknown as Window & typeof globalThis
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)) as AgentInvocationRequest)
      const response = responses[invocationIndex]
      invocationIndex += 1
      assert.ok(response, `missing Invocation response for ${url}`)
      return Array.isArray(response)
        ? sseResponse(response)
        : Response.json({ detail: response.detail }, { status: response.status })
    }
    const artifactId = url.split('/').at(-1) ?? ''
    const artifactText = artifactTexts[artifactId]
    assert.ok(artifactText, `missing artifact response for ${url}`)
    return new Response(artifactText, { status: 200 })
  }
  try {
    await run(requests)
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
}

async function withConsoleWarnings(
  run: (warnings: string[]) => Promise<void>
): Promise<void> {
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...values: unknown[]) => {
    warnings.push(values.map(String).join(' '))
  }
  try {
    await run(warnings)
  } finally {
    console.warn = originalWarn
  }
}

function webSearchWarning(warning: string): Record<string, unknown> {
  const prefix = '[web-search] '
  assert.ok(warning.startsWith(prefix))
  return JSON.parse(warning.slice(prefix.length)) as Record<string, unknown>
}

function webSearchWarningFor(
  warnings: readonly string[],
  event: string
): Record<string, unknown> {
  const diagnostics = warnings.map(webSearchWarning)
  const diagnostic = diagnostics.find((candidate) => candidate.event === event)
  assert.ok(diagnostic, `missing ${event} diagnostic`)
  return diagnostic
}

test('automatic route accepts a verified empty official API result without fallback', async () => {
  await withInvocationResponses([officialCompleted()], async (requests) => {
    const updates: string[] = []
    const result = await runWebSearchRoute(
      TEST_QUERY,
      { web_search: true },
      (attempt) => updates.push(`${attempt.mode}:${attempt.status}`),
      new AbortController().signal
    )

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.resolvedMode, OFFICIAL_SEARCH_MODE)
    assert.deepEqual(result.attempts.map((attempt) => attempt.mode), [OFFICIAL_SEARCH_MODE])
    assert.equal(result.attempts[0]?.status, 'completed')
    assert.deepEqual(result.attempts[0]?.invocationEvents.map((event) => event.type), [
      'invocation.started',
      'artifact.published',
      'result.completed'
    ])
    assert.equal(
      Object.values(result.attempts[0]?.eventObservedAt ?? {}).every(Number.isFinite),
      true
    )
    assert.deepEqual(requests.map((request) => request.skill?.id), [
      'builtin:web-search'
    ])
    assert.ok(updates.includes(`${OFFICIAL_SEARCH_MODE}:completed`))
  })
})

test('automatic route accepts native plain JSON after the official API fails', async () => {
  await withInvocationResponses([
    { status: 503, detail: 'official_api_request_failed' },
    nativeCompleted(true, nativePlainJsonResultText())
  ], async (requests) => {
    const result = await runWebSearchRoute(
      TEST_QUERY,
      { web_search: true },
      () => undefined,
      new AbortController().signal
    )

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.resolvedMode, WEB_SEARCH_CANDIDATES_MODE)
    assert.deepEqual(result.attempts.map((attempt) => attempt.mode), [
      OFFICIAL_SEARCH_MODE,
      WEB_SEARCH_CANDIDATES_MODE
    ])
    assert.equal(result.attempts[1]?.status, 'completed')
    assert.deepEqual(requests.map((request) => request.skill?.profile), ['official', 'native'])
  })
})

test('automatic route stops on a successful official API result before native and browser fallback', async () => {
  await withInvocationResponses([
    officialCompleted()
  ], async (requests) => {
    const result = await runWebSearchRoute(
      TEST_QUERY,
      { web_search: true },
      () => undefined,
      new AbortController().signal
    )

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.resolvedMode, OFFICIAL_SEARCH_MODE)
    assert.deepEqual(requests.map((request) => request.skill?.profile), ['official'])
    assert.deepEqual(result.attempts.map((attempt) => attempt.mode), [
      OFFICIAL_SEARCH_MODE
    ])
  })
})

test('automatic route uses native Web Search when the official credential is unavailable', async () => {
  await withInvocationResponses(
    [officialCompleted(), nativeCompleted()],
    async (requests) => {
      const result = await runWebSearchRoute(
        TEST_QUERY,
        { web_search: true },
        () => undefined,
        new AbortController().signal
      )

      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.resolvedMode, WEB_SEARCH_CANDIDATES_MODE)
      assert.deepEqual(result.attempts.map((attempt) => [attempt.mode, attempt.status]), [
        [OFFICIAL_SEARCH_MODE, 'failed'],
        [WEB_SEARCH_CANDIDATES_MODE, 'completed']
      ])
      assert.equal(result.attempts[0]?.errorCode, 'credential_unavailable')
      assert.deepEqual(requests.map((request) => request.skill?.profile), ['official', 'native'])
    },
    {
      'browser-artifact': browserResultText(),
      'official-artifact': officialResultText('unavailable', {
        code: 'credential_unavailable',
        message: 'SCHOLARSEED_API_KEY is not available for official search.'
      })
    }
  )
})

test('automatic route logs safe upstream diagnostics from an official API failure', async () => {
  await withConsoleWarnings(async (warnings) => {
    await withInvocationResponses(
      [officialCompleted(), nativeCompleted()],
      async () => {
        const result = await runWebSearchRoute(
          TEST_QUERY,
          { web_search: true },
          () => undefined,
          new AbortController().signal
        )

        assert.equal(result.ok, true)
        if (result.ok) assert.equal(result.resolvedMode, WEB_SEARCH_CANDIDATES_MODE)
      },
      {
        'browser-artifact': browserResultText(),
        'official-artifact': officialResultText(
          'failed',
          {
            code: 'official_api_response_invalid',
            message: 'The official search API returned an invalid response.'
          },
          {
            phase: 'response',
            upstream_http_status: 503,
            error_type: 'HTTPException',
            response_bytes: 321,
            response_oversized: false,
            ignored_detail: TEST_QUERY
          }
        )
      }
    )

    assert.equal(warnings.length, 1)
    const diagnostic = webSearchWarningFor(warnings, 'official_web_search_attempt')
    assert.equal(diagnostic.failure_phase, 'response')
    assert.equal(diagnostic.upstream_http_status, 503)
    assert.equal(diagnostic.upstream_error_type, 'HTTPException')
    assert.equal(diagnostic.upstream_response_bytes, 321)
    assert.equal(diagnostic.upstream_response_oversized, false)
    assert.equal(diagnostic.will_fallback, true)
    assert.equal(diagnostic.next_mode, WEB_SEARCH_CANDIDATES_MODE)
    assert.equal(warnings.some((warning) => warning.includes(TEST_QUERY)), false)
  })
})

test('automatic route tries official, skips native capability, then runs browser Skill', async () => {
  await withInvocationResponses([
    { status: 422, detail: 'official_api_unavailable' },
    browserCompleted()
  ], async (requests) => {
    const result = await runWebSearchRoute(
      TEST_QUERY,
      { web_search: false },
      () => undefined,
      new AbortController().signal
    )

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.resolvedMode, BROWSER_SEARCH_MODE)
    assert.deepEqual(result.attempts.map((attempt) => [attempt.mode, attempt.status]), [
      [OFFICIAL_SEARCH_MODE, 'failed'],
      [WEB_SEARCH_CANDIDATES_MODE, 'unavailable'],
      [BROWSER_SEARCH_MODE, 'completed']
    ])
    assert.deepEqual(requests.map((request) => request.skill?.profile), ['official', 'browser'])
  })
})

test('automatic route falls back when native terminal output lacks execution evidence', async () => {
  await withConsoleWarnings(async (warnings) => {
    await withInvocationResponses(
      [
        { status: 422, detail: 'official_api_unavailable' },
        nativeCompleted(false),
        browserCompleted()
      ],
      async (requests) => {
        const result = await runWebSearchRoute(
          TEST_QUERY,
          { web_search: true },
          () => undefined,
          new AbortController().signal
        )

        assert.equal(result.ok, true)
        if (result.ok) assert.equal(result.resolvedMode, BROWSER_SEARCH_MODE)
        assert.deepEqual(result.attempts.map((attempt) => [attempt.mode, attempt.status]), [
          [OFFICIAL_SEARCH_MODE, 'failed'],
          [WEB_SEARCH_CANDIDATES_MODE, 'failed'],
          [BROWSER_SEARCH_MODE, 'completed']
        ])
        assert.equal(result.attempts[1]?.errorCode, 'web_search_output_missing')
        assert.deepEqual(
          [...new Set(result.attempts[1]?.invocationEvents.map((event) => event.invocation_id))],
          ['native-invocation']
        )
        assert.deepEqual(
          [...new Set(result.attempts[2]?.invocationEvents.map((event) => event.invocation_id))],
          ['browser-invocation']
        )
        assert.deepEqual(requests.map((request) => request.skill?.id), [
          'builtin:web-search',
          'builtin:web-search',
          'builtin:web-search'
        ])
      }
    )

    assert.equal(warnings.length, 2)
    const diagnostic = webSearchWarningFor(warnings, 'native_web_search_failed')
    assert.deepEqual(diagnostic, {
      event: 'native_web_search_failed',
      stage: 'evidence_contract',
      mode: WEB_SEARCH_CANDIDATES_MODE,
      invocation_id: 'native-invocation',
      status: 'failed',
      error_code: 'web_search_output_missing',
      error_code_redacted: false,
      http_status: 200,
      will_fallback: true,
      expected_output_schema: WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID,
      validation_issues: ['web_search_completed_missing'],
      execution_evidence_found: false,
      structured_output_found: true,
      candidate_count: 0,
      result_text_present: true,
      result_text_length: nativeResultText().length,
      event_types: ['invocation.started', 'plan.updated', 'result.completed']
    })
    assert.equal(warnings.some((warning) => warning.includes(TEST_QUERY)), false)
  })
})

test('automatic route logs the exact contract reason when native output markers are missing', async () => {
  const unmarkedText = [
    '```json',
    nativePlainJsonResultText(),
    '```'
  ].join('\n')
  await withConsoleWarnings(async (warnings) => {
    await withInvocationResponses(
      [
        { status: 422, detail: 'official_api_unavailable' },
        nativeCompleted(true, unmarkedText),
        browserCompleted()
      ],
      async () => {
        const result = await runWebSearchRoute(
          TEST_QUERY,
          { web_search: true },
          () => undefined,
          new AbortController().signal
        )

        assert.equal(result.ok, true)
        if (result.ok) assert.equal(result.resolvedMode, BROWSER_SEARCH_MODE)
      }
    )

    assert.equal(warnings.length, 2)
    const diagnostic = webSearchWarningFor(warnings, 'native_web_search_failed')
    assert.deepEqual(diagnostic.validation_issues, ['result_begin_marker_missing'])
    assert.equal(diagnostic.execution_evidence_found, true)
    assert.equal(diagnostic.structured_output_found, false)
    assert.equal(diagnostic.will_fallback, true)
    assert.equal(diagnostic.result_text_present, true)
    assert.equal(diagnostic.result_text_length, unmarkedText.length)
    assert.equal(warnings.some((warning) => warning.includes(unmarkedText)), false)
    assert.equal(warnings.some((warning) => warning.includes(TEST_QUERY)), false)
  })
})

test('automatic route falls back when native is unavailable after the official API fails', async () => {
  await withInvocationResponses(
    [
      { status: 422, detail: 'official_api_unavailable' },
      { status: 422, detail: 'invocation_skill_unavailable' },
      browserCompleted()
    ],
    async (requests) => {
      const result = await runWebSearchRoute(
        TEST_QUERY,
        { web_search: true },
        () => undefined,
        new AbortController().signal
      )

      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.resolvedMode, BROWSER_SEARCH_MODE)
      assert.deepEqual(requests.map((request) => request.skill?.id), [
        'builtin:web-search',
        'builtin:web-search',
        'builtin:web-search'
      ])
    }
  )
})

test('automatic route falls through all providers after an Invocation service outage', async () => {
  await withInvocationResponses(
    [
      { status: 503, detail: 'invocation_service_unavailable' },
      { status: 503, detail: 'invocation_service_unavailable' },
      { status: 503, detail: 'invocation_service_unavailable' }
    ],
    async (requests) => {
      const result = await runWebSearchRoute(
        TEST_QUERY,
        { web_search: true },
        () => undefined,
        new AbortController().signal
      )

      assert.equal(result.ok, false)
      assert.equal(requests.length, 3)
      assert.equal(result.attempts[0]?.errorCode, 'invocation_service_unavailable')
      assert.equal(result.attempts[0]?.httpStatus, 503)
      assert.deepEqual(requests.map((request) => request.skill?.profile), [
        'official',
        'native',
        'browser'
      ])
    }
  )
})

test('automatic route falls through all providers after an authentication failure', async () => {
  await withInvocationResponses(
    [
      { status: 401, detail: 'authentication_required' },
      { status: 401, detail: 'authentication_required' },
      { status: 401, detail: 'authentication_required' }
    ],
    async (requests) => {
      const result = await runWebSearchRoute(
        TEST_QUERY,
        { web_search: true },
        () => undefined,
        new AbortController().signal
      )

      assert.equal(result.ok, false)
      assert.equal(requests.length, 3)
      assert.deepEqual(requests.map((request) => request.skill?.profile), [
        'official',
        'native',
        'browser'
      ])
    }
  )
})

test('automatic route falls through after a confirmed provider failure', async () => {
  const providerError = 'The model provider allocation quota is exhausted.'
  const providerFailed = [
    invocationEvent('native-invocation', 1, 'invocation.started'),
    invocationEvent('native-invocation', 2, 'invocation.failed', {
      error: providerError
    })
  ]
  await withConsoleWarnings(async (warnings) => {
    await withInvocationResponses([
      { status: 503, detail: 'official_api_request_failed' },
      providerFailed,
      { status: 503, detail: 'browser_launch_failed' }
    ], async (requests) => {
      const result = await runWebSearchRoute(
        TEST_QUERY,
        { web_search: true },
        () => undefined,
        new AbortController().signal
      )

      assert.equal(result.ok, false)
      assert.equal(requests.length, 3)
    })

    assert.equal(warnings.length, 2)
    const officialDiagnostic = webSearchWarningFor(
      warnings,
      'official_web_search_attempt'
    )
    assert.deepEqual(officialDiagnostic, {
      event: 'official_web_search_attempt',
      stage: 'invocation',
      mode: OFFICIAL_SEARCH_MODE,
      invocation_id: null,
      status: 'failed',
      error_code: 'official_api_request_failed',
      error_code_redacted: false,
      invocation_http_status: 503,
      will_fallback: true,
      next_mode: WEB_SEARCH_CANDIDATES_MODE,
      query_length: TEST_QUERY.length,
      failure_phase: null,
      upstream_http_status: null,
      upstream_error_type: null,
      upstream_response_bytes: null,
      upstream_response_oversized: null,
      expected_output_schema: BROWSER_SEARCH_OUTPUT_SCHEMA_ID,
      validation_issues: [],
      execution_evidence_found: null,
      structured_output_found: null,
      candidate_count: 0,
      result_text_present: false,
      result_text_length: 0,
      event_types: []
    })
    const nativeDiagnostic = webSearchWarningFor(warnings, 'native_web_search_failed')
    assert.equal(nativeDiagnostic.error_code, 'unclassified_failure')
    assert.equal(nativeDiagnostic.error_code_redacted, true)
    assert.equal(warnings.some((warning) => warning.includes(providerError)), false)
    assert.equal(warnings.some((warning) => warning.includes(TEST_QUERY)), false)
  })
})

test('automatic route does not replay an interrupted native search after official failure', async () => {
  const interrupted = [
    invocationEvent('native-invocation', 1, 'invocation.started'),
    invocationEvent('native-invocation', 2, 'invocation.interrupted')
  ]
  await withInvocationResponses([
    { status: 503, detail: 'official_api_request_failed' },
    interrupted
  ], async (requests) => {
    const result = await runWebSearchRoute(
      TEST_QUERY,
      { web_search: true },
      () => undefined,
      new AbortController().signal
    )

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 'interrupted')
    assert.deepEqual(result.attempts.map((attempt) => [attempt.mode, attempt.status]), [
      [OFFICIAL_SEARCH_MODE, 'failed'],
      [WEB_SEARCH_CANDIDATES_MODE, 'interrupted']
    ])
    assert.equal(requests.length, 2)
  })
})

for (const scenario of [
  {
    name: 'unknown terminal',
    events: [
      invocationEvent('native-invocation', 1, 'invocation.started'),
      invocationEvent('native-invocation', 2, 'invocation.unknown')
    ]
  },
  {
    name: 'invalid event stream',
    events: [
      invocationEvent('native-invocation', 1, 'invocation.started'),
      invocationEvent('native-invocation', 3, 'result.completed')
    ]
  },
  {
    name: 'unsupported interaction',
    events: [
      invocationEvent('native-invocation', 1, 'invocation.started'),
      invocationEvent('native-invocation', 2, 'interaction.required', {
        request_id: 'approval-1'
      })
    ]
  }
]) {
  test(`automatic route does not replay after ${scenario.name}`, async () => {
    await withInvocationResponses([
      { status: 503, detail: 'official_api_request_failed' },
      scenario.events
    ], async (requests) => {
      const result = await runWebSearchRoute(
        TEST_QUERY,
        { web_search: true },
        () => undefined,
        new AbortController().signal
      )

      assert.equal(result.ok, false)
      assert.equal(requests.length, 2)
    })
  })
}

test('automatic route checks cancellation before starting native fallback', async () => {
  const controller = new AbortController()
  await withInvocationResponses([
    { status: 503, detail: 'official_api_request_failed' }
  ], async (requests) => {
    const result = await runWebSearchRoute(
      TEST_QUERY,
      { web_search: true },
      (attempt) => {
        if (attempt.status === 'failed') controller.abort()
      },
      controller.signal
    )

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.status, 'interrupted')
      assert.equal(result.error, WEB_SEARCH_INTERRUPTED_CODE)
    }
    assert.equal(requests.length, 1)
  })
})

test('automatic route preserves both failures when fallback also fails', async () => {
  const nativeFailed = [
    invocationEvent('native-invocation', 1, 'invocation.started'),
    invocationEvent('native-invocation', 2, 'invocation.failed', {
      error: 'runtime_web_search_capability_unavailable'
    })
  ]
  const browserFailed = [
    invocationEvent('browser-invocation', 1, 'invocation.started'),
    invocationEvent('browser-invocation', 2, 'invocation.failed', {
      error: 'browser_launch_failed'
    })
  ]
  await withInvocationResponses([
    { status: 503, detail: 'official_api_request_failed' },
    nativeFailed,
    browserFailed
  ], async () => {
    const result = await runWebSearchRoute(
      TEST_QUERY,
      { web_search: true },
      () => undefined,
      new AbortController().signal
    )

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 'failed')
    assert.deepEqual(result.attempts.map((attempt) => [attempt.mode, attempt.status]), [
      [OFFICIAL_SEARCH_MODE, 'failed'],
      [WEB_SEARCH_CANDIDATES_MODE, 'failed'],
      [BROWSER_SEARCH_MODE, 'failed']
    ])
    assert.equal(result.error, 'browser_launch_failed')
  })
})

test('automatic route preserves the browser artifact failure code', async () => {
  await withInvocationResponses(
    [{ status: 422, detail: 'official_api_unavailable' }, browserCompleted()],
    async () => {
      const result = await runWebSearchRoute(
        TEST_QUERY,
        { web_search: false },
        () => undefined,
        new AbortController().signal
      )

      assert.equal(result.ok, false)
      assert.equal(result.attempts[2]?.status, 'failed')
      assert.equal(result.attempts[2]?.errorCode, 'browser_launch_failed')
      assert.equal(result.error, 'browser_launch_failed')
    },
    {
      'browser-artifact': browserResultText('failed', {
        code: 'browser_launch_failed',
        message: 'raw browser error'
      }),
      'official-artifact': officialResultText()
    }
  )
})
