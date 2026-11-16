import assert from 'node:assert/strict'
import test from 'node:test'

import { generateLiteratureNote, NoteGenerationFailure } from './api.ts'

test('note preview arrives before completion across split SSE and UTF-8 chunks', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(stream))
  const previews: unknown[] = []
  let settled = false
  const request = {
    attachment_id: 'pdf',
    source_revision: 'source',
    record_revision: 'records',
    mark_ids: ['mark'],
    model_key: 'model',
    language: 'zh' as const,
  }
  const running = generateLiteratureNote('paper', request, (preview) => previews.push(preview))
  void running.then(() => {
    settled = true
  })
  const preview = {
    preview_id: 'writer',
    revision: 1,
    status: 'streaming',
    verified: false,
    blocks: [{ id: '/markdown', kind: 'paragraph', text: '逐步输出' }],
  }
  const frame = encoder.encode(
    ': heartbeat\r\n\r\ndata: ' +
      JSON.stringify({ type: 'generation_preview', data: preview }) +
      '\r\n\r\n'
  )
  for (const byte of frame) controller!.enqueue(new Uint8Array([byte]))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(previews, [preview])
  assert.equal(settled, false)
  controller!.enqueue(
    encoder.encode('data: {"type":"result","note":{"id":"saved","text":"Accepted"}}\n\n')
  )
  controller!.close()
  assert.equal((await running).id, 'saved')
})

test('a failed stream after a preview never resolves as a saved note', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        'data: {"type":"generation_preview","data":{"preview_id":"writer"}}\n\ndata: {"type":"error","code":"insight_result_invalid","invocation_id":"run"}\n\n'
      )
  )
  const previews: unknown[] = []
  await assert.rejects(
    generateLiteratureNote('paper', {} as never, (preview) => previews.push(preview)),
    NoteGenerationFailure
  )
  assert.equal(previews.length, 1)
})
