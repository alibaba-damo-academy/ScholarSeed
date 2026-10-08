import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInvocationArtifact, AgentInvocationEvent, AgentInvocationRequest } from '../../contracts/invocation.ts'
import {
  AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH,
  AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH,
  WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID
} from './search.ts'
import { BROWSER_SEARCH_MODE, OFFICIAL_SEARCH_MODE, WEB_SEARCH_CANDIDATES_MODE } from './state.ts'
import { runWebSearchRoute } from './driver.ts'

const API_BASE = 'http://service.test'
const QUERY = 'test query'

function event(invocationId: string, seq: number, type: string, data: Record<string, unknown> = {}, itemId = ''): AgentInvocationEvent {
  return {
    schema_version: 1,
    invocation_id: invocationId,
    seq,
    type,
    turn_id: `${invocationId}-turn`,
    item_id: itemId,
    data,
    created_at: 1_788_800_000 + seq
  }
}

function artifact(path: string, id: string): AgentInvocationArtifact {
  return {
    artifact_id: id,
    relative_path: path,
    role: 'final',
    mime_type: 'application/json',
    size_bytes: 128,
    sha256: 'a'.repeat(64)
  }
}

const officialArtifact = artifact(AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH, 'official-artifact')
const browserArtifact = artifact(AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH, 'browser-artifact')

function automaticStarted(): AgentInvocationEvent {
  return event('automatic-invocation', 1, 'invocation.started', {
    skill: { id: 'builtin:web-search', profile: 'automatic' },
    execution: { permission_mode: 'bypassPermissions' }
  })
}

function officialResult(status: 'empty' | 'unavailable' = 'empty'): string {
  return JSON.stringify({
    schema: 'scholarseed.web_search.v1', status, provider: OFFICIAL_SEARCH_MODE,
    query: QUERY, candidates: [], started_at: '2026-09-08T06:30:00.000Z',
    completed_at: '2026-09-08T06:30:01.000Z', duration_ms: 1000,
    error: status === 'empty' ? null : { code: 'credential_unavailable', message: 'missing' }
  })
}

function browserResult(): string {
  return JSON.stringify({
    schema: 'scholarseed.web_search.v1', status: 'empty', provider: BROWSER_SEARCH_MODE,
    query: QUERY, engine: 'bing', browser: 'chrome', started_at: '2026-09-08T06:30:00.000Z',
    completed_at: '2026-09-08T06:30:01.000Z', duration_ms: 1000, candidates: [], error: null
  })
}

function nativeResult(): string {
  return `<scholarseed_web_search_results>${JSON.stringify({
    schema: WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA_ID, status: 'empty',
    provider: WEB_SEARCH_CANDIDATES_MODE, query: QUERY, candidates: [], error: null
  })}</scholarseed_web_search_results>`
}

function response(events: AgentInvocationEvent[]): Response {
  return new Response(events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' }
  })
}

async function runWithEvents(
  events: AgentInvocationEvent[], artifacts: Record<string, string> = {}
): Promise<{ requests: AgentInvocationRequest[]; result: Awaited<ReturnType<typeof runWebSearchRoute>> }> {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests: AgentInvocationRequest[] = []
  globalThis.window = {
    scholarseed: { getApiBase: () => API_BASE }, dispatchEvent: () => true
  } as unknown as Window & typeof globalThis
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') {
      requests.push(JSON.parse(String(init.body)) as AgentInvocationRequest)
      return response(events)
    }
    const artifactId = url.split('/').at(-1) ?? ''
    assert.ok(artifacts[artifactId], `missing artifact ${artifactId}`)
    return new Response(artifacts[artifactId], { status: 200 })
  }
  try {
    const result = await runWebSearchRoute(QUERY, { web_search: true }, () => undefined, new AbortController().signal)
    return { requests, result }
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
}

test('automatic route uses one Invocation for an official result', async () => {
  const events = [
    automaticStarted(),
    event('automatic-invocation', 2, 'artifact.published', officialArtifact as unknown as Record<string, unknown>),
    event('automatic-invocation', 3, 'result.completed', { artifacts: [officialArtifact], text: 'done' })
  ]
  const { requests, result } = await runWithEvents(events, { 'official-artifact': officialResult() })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.resolvedMode, OFFICIAL_SEARCH_MODE)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.skill?.profile, 'automatic')
  assert.equal(result.attempts[0]?.invocationId, 'automatic-invocation')
  assert.equal(result.attempts[0]?.artifactPath, AUTOMATIC_OFFICIAL_SEARCH_ARTIFACT_PATH)
})

test('automatic route falls back to native in the same Invocation', async () => {
  const events = [
    automaticStarted(),
    event('automatic-invocation', 2, 'artifact.published', officialArtifact as unknown as Record<string, unknown>),
    event('automatic-invocation', 3, 'web_search.completed', { query: QUERY, result_count: 0 }, 'native-search'),
    event('automatic-invocation', 4, 'result.completed', { text: nativeResult(), artifacts: [officialArtifact] })
  ]
  const { requests, result } = await runWithEvents(events, { 'official-artifact': officialResult('unavailable') })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.resolvedMode, WEB_SEARCH_CANDIDATES_MODE)
  assert.equal(requests.length, 1)
  assert.deepEqual(result.attempts.map((attempt) => attempt.invocationId), ['automatic-invocation', 'automatic-invocation'])
})

test('automatic route reads browser fallback from its immutable artifact path', async () => {
  const events = [
    automaticStarted(),
    event('automatic-invocation', 2, 'artifact.published', officialArtifact as unknown as Record<string, unknown>),
    event('automatic-invocation', 3, 'web_search.completed', { query: QUERY, result_count: 0 }, 'native-search'),
    event('automatic-invocation', 4, 'artifact.published', browserArtifact as unknown as Record<string, unknown>),
    event('automatic-invocation', 5, 'result.completed', { artifacts: [officialArtifact, browserArtifact], text: 'done' })
  ]
  const { requests, result } = await runWithEvents(events, {
    'official-artifact': officialResult('unavailable'), 'browser-artifact': browserResult()
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.resolvedMode, BROWSER_SEARCH_MODE)
  assert.equal(requests.length, 1)
  if (result.ok) {
    assert.equal(result.attempts.at(-1)?.artifactPath, AUTOMATIC_BROWSER_SEARCH_ARTIFACT_PATH)
  }
})
