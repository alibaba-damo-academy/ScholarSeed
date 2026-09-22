import assert from 'node:assert/strict'
import test from 'node:test'

import { invokeResource, type ResourceActivity, type ResourceRequest } from './ai.ts'

const request = {
  source: { project_id: 'project', source_id: 'paper.pdf', source_revision: 'sha256:revision' },
  scope: 'selection',
  selection: {
    locator: { kind: 'pdf', page: 1, quads: [] },
    selected_text: 'selection',
    selected_text_hash: 'sha256:selection'
  },
  model_key: 'model',
  instruction: 'explain',
  client_action_id: 'action',
  client_attempt_id: 'attempt'
} as ResourceRequest

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

function stream(...events: unknown[]): Response {
  const payload = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
}

test('resource invocation preserves activity and terminal result behavior through shared action stream', async () => {
  let url = ''
  const restore = installFetch(async (input) => {
    url = String(input)
    return stream(
      { type: 'output_delta', invocation_id: 'invocation', text: 'partial', item_id: 'item' },
      { type: 'result', result: {
        task_id: 'invocation', invocation_id: 'invocation', status: 'completed', output: 'final',
        model_key: 'model', error_code: '', error_detail: ''
      } }
    )
  })
  try {
    const observed: ResourceActivity[] = []
    const result = await invokeResource('explain', request, new AbortController().signal, event => observed.push(event))
    assert.equal(url, 'http://service.test/api/resource/ai/explain')
    assert.equal(result.output, 'final')
    assert.deepEqual(observed.map(event => event.text), ['partial'])
  } finally { restore() }
})

test('resource invocation preserves HTTP detail errors', async () => {
  const restore = installFetch(async () => Response.json({ detail: 'resource_model_unavailable' }, { status: 422 }))
  try {
    await assert.rejects(
      invokeResource('explain', request, new AbortController().signal, () => {}),
      new Error('resource_model_unavailable')
    )
  } finally { restore() }
})
