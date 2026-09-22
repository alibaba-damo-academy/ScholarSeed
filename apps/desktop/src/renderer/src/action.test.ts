import assert from 'node:assert/strict'
import test from 'node:test'

import { ActionRequestError, postActionStream, type ActionActivity } from './action.ts'

interface Result {
  invocation_id: string
  output: string
}

const parseResult = (value: unknown): Result | null => {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, unknown>
  return typeof result.invocation_id === 'string' && result.invocation_id
    && typeof result.output === 'string'
    ? result as unknown as Result
    : null
}

function response(chunks: Uint8Array[], contentType = 'text/event-stream; charset=utf-8'): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  }), { headers: { 'content-type': contentType } })
}

function frames(...events: unknown[]): Uint8Array {
  return new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
}

function installFetch(fetch: typeof globalThis.fetch): () => void {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  globalThis.window = {
    scholarseed: { getApiBase: () => 'http://service.test' }
  } as Window & typeof globalThis
  globalThis.fetch = fetch
  return () => {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
}

test('action stream posts JSON and decodes fragmented UTF-8 around heartbeats', async () => {
  const activity: ActionActivity = {
    type: 'output_delta', invocation_id: 'invocation-1', text: '中文预览', item_id: 'item-1'
  }
  const terminal = { type: 'result', result: { invocation_id: 'invocation-1', output: '最终结果' } }
  const encoded = new TextEncoder().encode(
    `: heartbeat\r\n\r\ndata: ${JSON.stringify(activity)}\r\n\r\n`
      + `data: ${JSON.stringify(terminal)}\r\n\r\n`
  )
  const split = encoded.indexOf(new TextEncoder().encode('中')[0]) + 1
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  const restore = installFetch(async (input, init) => {
    capturedUrl = String(input)
    capturedInit = init
    return response([encoded.slice(0, split), encoded.slice(split)])
  })
  try {
    const observed: ActionActivity[] = []
    const result = await postActionStream({
      path: '/api/resource/ai/explain',
      body: { prompt: '解释' },
      protocolError: 'action_stream_incomplete',
      parseResult,
      onActivity: event => observed.push(event)
    })
    assert.equal(capturedUrl, 'http://service.test/api/resource/ai/explain')
    assert.equal(capturedInit?.method, 'POST')
    assert.equal(capturedInit?.credentials, 'include')
    assert.deepEqual(capturedInit?.headers, {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json'
    })
    assert.equal(capturedInit?.body, JSON.stringify({ prompt: '解释' }))
    assert.deepEqual(observed, [activity])
    assert.deepEqual(result, terminal.result)
  } finally { restore() }
})

test('action stream accepts a validated domain event before invocation activity', async () => {
  const prepared = { type: 'prepared', crop: 'data:image/png;base64,crop' }
  const restore = installFetch(async () => response([frames(
    prepared,
    { type: 'output_delta', invocation_id: 'invocation-1', text: 'partial', item_id: 'item-1' },
    { type: 'result', result: { invocation_id: 'invocation-1', output: 'final' } }
  )]))
  try {
    const domain: unknown[] = []
    const result = await postActionStream({
      path: '/action', body: {}, protocolError: 'action_stream_incomplete', parseResult,
      onActivity() {},
      onEvent: event => {
        if (event.type !== 'prepared' || typeof event.crop !== 'string') return false
        domain.push(event)
        return true
      }
    })
    assert.deepEqual(domain, [prepared])
    assert.equal(result.output, 'final')
  } finally { restore() }
})

test('action stream enforces one invocation and exactly one terminal event', async () => {
  const cases = [
    {
      name: 'missing terminal',
      chunks: [frames({ type: 'accepted', invocation_id: 'invocation-1', text: '', item_id: '' })]
    },
    {
      name: 'mismatched invocation',
      chunks: [frames(
        { type: 'started', invocation_id: 'invocation-1', text: '', item_id: '' },
        { type: 'result', result: { invocation_id: 'invocation-2', output: 'wrong' } }
      )]
    },
    {
      name: 'malformed activity',
      chunks: [frames(
        { type: 'output_delta', invocation_id: 'invocation-1', text: 'partial' },
        { type: 'result', result: { invocation_id: 'invocation-1', output: 'done' } }
      )]
    },
    {
      name: 'duplicate terminal',
      chunks: [frames(
        { type: 'result', result: { invocation_id: 'invocation-1', output: 'done' } },
        { type: 'error', error: 'late_failure' }
      )]
    }
  ]
  for (const scenario of cases) {
    const restore = installFetch(async () => response(scenario.chunks))
    try {
      await assert.rejects(
        postActionStream({
          path: '/action', body: {}, protocolError: 'action_stream_incomplete', parseResult,
          onActivity() {}
        }),
        new Error('action_stream_incomplete'),
        scenario.name
      )
    } finally { restore() }
  }
})

test('action stream exposes application errors only from a valid terminal error', async () => {
  const restore = installFetch(async () => response([frames({ type: 'error', error: 'model_failed' })]))
  try {
    await assert.rejects(
      postActionStream({
        path: '/action', body: {}, protocolError: 'action_stream_incomplete', parseResult,
        onActivity() {}
      }),
      new Error('model_failed')
    )
  } finally { restore() }
})

test('action stream preserves structured HTTP error identity for localized presentation', async () => {
  const restore = installFetch(async () => Response.json({
    detail: { code: 'pdf_ai_region_missing', diagnostic: '' }
  }, { status: 422 }))
  try {
    await assert.rejects(
      postActionStream({
        path: '/action', body: {}, protocolError: 'action_stream_incomplete', parseResult,
        onActivity() {}
      }),
      error => error instanceof ActionRequestError
        && error.code === 'pdf_ai_region_missing'
        && error.diagnostic === ''
    )
  } finally { restore() }
})

test('action stream rejects a successful non-SSE response', async () => {
  const restore = installFetch(async () => response([frames({ type: 'error', error: 'hidden' })], 'application/json'))
  try {
    await assert.rejects(
      postActionStream({
        path: '/action', body: {}, protocolError: 'action_stream_incomplete', parseResult,
        onActivity() {}
      }),
      new Error('action_stream_incomplete')
    )
  } finally { restore() }
})
