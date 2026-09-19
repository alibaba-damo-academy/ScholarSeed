import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseAgentInvocationEvent,
  INVOCATION_ABORTED_CODE,
  INVOCATION_PROTOCOL_ERROR_CODE,
  INVOCATION_INTERACTION_REQUIRED_CODE,
  INVOCATION_REQUEST_FAILED_CODE,
  readAgentInvocationArtifactText,
  streamAgentInvocation
} from './invocation.ts'
import type { AgentInvocationEvent, AgentInvocationRequest } from './contracts/invocation.ts'

const INVOCATION_REQUEST: AgentInvocationRequest = {
  prompt: 'search',
  skill: { id: 'builtin:web-search', profile: 'native' },
  execution: {
    web_search: true,
    sandbox: 'workspace-write',
    network_access: true,
    reasoning_effort: 'low',
    service_tier: 'fast'
  }
}

function invocationEvent(seq: number, type: string): AgentInvocationEvent {
  return {
    schema_version: 1,
    invocation_id: 'invocation-1',
    seq,
    type,
    turn_id: type === 'invocation.started' ? '' : 'turn-1',
    item_id: '',
    data: type === 'result.completed' ? { text: 'done', artifacts: [] } : {},
    created_at: 1_780_000_000
  }
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' }
  })
}

test('Invocation event validation rejects malformed public envelopes', () => {
  assert.deepEqual(parseAgentInvocationEvent(invocationEvent(1, 'invocation.started')), invocationEvent(1, 'invocation.started'))
  assert.equal(parseAgentInvocationEvent({ ...invocationEvent(1, 'invocation.started'), data: [] }), null)
  assert.equal(parseAgentInvocationEvent({ ...invocationEvent(1, 'invocation.started'), seq: 0 }), null)
})

test('POST-SSE client parses chunked CRLF frames and ignores heartbeats', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  const started = JSON.stringify(invocationEvent(1, 'invocation.started'))
  const completed = JSON.stringify(invocationEvent(2, 'result.completed'))
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return sseResponse([
      ': heartbeat\r\n\r\ndata: ',
      `${started}\r\n\r\ndata: ${completed.slice(0, 30)}`,
      `${completed.slice(30)}\r\n\r\n`
    ])
  }
  try {
    const received: AgentInvocationEvent[] = []
    const result = await streamAgentInvocation(INVOCATION_REQUEST, (event) => received.push(event))

    assert.equal(result.ok, true)
    assert.deepEqual(received.map((event) => event.type), [
      'invocation.started',
      'result.completed'
    ])
    assert.equal(capturedUrl, 'http://service.test/api/agent/invocations')
    assert.equal(capturedInit?.method, 'POST')
    assert.equal((capturedInit?.headers as Record<string, string>).Accept, 'text/event-stream')
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), INVOCATION_REQUEST)
    assert.equal(capturedInit?.credentials, 'include')
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('POST-SSE client rejects a sequence gap instead of projecting partial state', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  globalThis.fetch = async () => sseResponse([
    `data: ${JSON.stringify(invocationEvent(1, 'invocation.started'))}\n\n`,
    `data: ${JSON.stringify(invocationEvent(3, 'result.completed'))}\n\n`
  ])
  try {
    const result = await streamAgentInvocation(INVOCATION_REQUEST, () => undefined)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, INVOCATION_PROTOCOL_ERROR_CODE)
      assert.equal(result.error, INVOCATION_PROTOCOL_ERROR_CODE)
      assert.equal(result.status, 200)
    }
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('POST-SSE client rejects a duplicate invocation start', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  globalThis.fetch = async () => sseResponse([
    `data: ${JSON.stringify(invocationEvent(1, 'invocation.started'))}\n\n`,
    `data: ${JSON.stringify(invocationEvent(2, 'invocation.started'))}\n\n`
  ])
  try {
    const result = await streamAgentInvocation(INVOCATION_REQUEST, () => undefined)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, INVOCATION_PROTOCOL_ERROR_CODE)
      assert.equal(result.error, INVOCATION_PROTOCOL_ERROR_CODE)
      assert.equal(result.status, 200)
    }
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('POST-SSE client stops explicitly when an interaction has no handler', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let cancelled = false
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  const encoder = new TextEncoder()
  const started = invocationEvent(1, 'invocation.started')
  const interaction = {
    ...invocationEvent(2, 'interaction.required'),
    data: {
      request_id: 'request-1',
      kind: 'approval',
      prompt: 'allow?',
      allowed_decisions: ['approve', 'cancel'],
      response_contract: {}
    }
  }
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify(started)}\n\ndata: ${JSON.stringify(interaction)}\n\n`
      ))
    },
    cancel() {
      cancelled = true
    }
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
  try {
    const result = await streamAgentInvocation(INVOCATION_REQUEST, () => undefined)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, INVOCATION_INTERACTION_REQUIRED_CODE)
      assert.equal(result.error, INVOCATION_INTERACTION_REQUIRED_CODE)
      assert.equal(result.status, 200)
    }
    assert.equal(cancelled, true)
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('POST-SSE client replies to an interaction and keeps consuming the original stream', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  const interaction = {
    ...invocationEvent(2, 'interaction.required'),
    data: {
      request_id: 'request / one',
      kind: 'approval',
      prompt: 'allow?',
      allowed_decisions: ['approve', 'cancel'],
      response_contract: {}
    }
  }
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    if (requests.length === 1) {
      return sseResponse([
        `data: ${JSON.stringify(invocationEvent(1, 'invocation.started'))}\n\n`,
        `data: ${JSON.stringify(interaction)}\n\n`,
        `data: ${JSON.stringify(invocationEvent(3, 'result.completed'))}\n\n`
      ])
    }
    return Response.json({ accepted: true })
  }
  try {
    const handled: AgentInvocationEvent[] = []
    const result = await streamAgentInvocation(
      INVOCATION_REQUEST,
      () => undefined,
      undefined,
      async (event) => {
        handled.push(event)
        return { decision: 'approve', values: { scope: 'browser' } }
      }
    )

    assert.equal(result.ok, true)
    assert.equal(handled.length, 1)
    assert.equal(
      requests[1]?.url,
      'http://service.test/api/agent/invocations/invocation-1/interactions/request%20%2F%20one'
    )
    assert.equal(requests[1]?.init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      decision: 'approve',
      values: { scope: 'browser' }
    })
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('Invocation artifact download keeps ownership identifiers URL-safe', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  let capturedUrl = ''
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  globalThis.fetch = async (input) => {
    capturedUrl = String(input)
    return new Response('{"schema":"scholarseed.web_search.v1"}', { status: 200 })
  }
  try {
    const result = await readAgentInvocationArtifactText('invocation / one', 'artifact / one')
    assert.equal(result.ok, true)
    assert.equal(
      capturedUrl,
      'http://service.test/api/agent/invocations/invocation%20%2F%20one/artifacts/artifact%20%2F%20one'
    )
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})


test('Invocation local cancellation and empty failures use codes while diagnostics stay unchanged', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = { scholarseed: { getApiBase: () => 'http://service.test' } } as Window & typeof globalThis
  try {
    globalThis.fetch = async () => { throw new DOMException('cancelled', 'AbortError') }
    const cancelled = await streamAgentInvocation(INVOCATION_REQUEST, () => undefined)
    assert.deepEqual(cancelled, { ok: false, status: 0, error: INVOCATION_ABORTED_CODE, code: INVOCATION_ABORTED_CODE })
    globalThis.fetch = async () => { throw new Error('') }
    assert.deepEqual(await streamAgentInvocation(INVOCATION_REQUEST, () => undefined), { ok: false, status: 0, error: INVOCATION_REQUEST_FAILED_CODE })
    assert.deepEqual(await readAgentInvocationArtifactText('one', 'two'), { ok: false, status: 0, error: INVOCATION_REQUEST_FAILED_CODE })
    const diagnostic = 'TLS handshake failed: certificate abc'
    globalThis.fetch = async () => { throw new Error(diagnostic) }
    assert.deepEqual(await streamAgentInvocation(INVOCATION_REQUEST, () => undefined), { ok: false, status: 0, error: diagnostic })
    assert.deepEqual(await readAgentInvocationArtifactText('one', 'two'), { ok: false, status: 0, error: diagnostic })
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})
