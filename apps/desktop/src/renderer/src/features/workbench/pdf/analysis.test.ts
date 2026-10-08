import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { ASSISTANT_TRANSLATION_TARGETS } from '../../../contracts/assistant.ts'
import { invokeFigure, pdfAiApi, PdfAiRequestError, pdfResponseLanguage, subscribePdfAiTask, type PdfAiTask, type PdfAiRequest, PDF_TRANSLATION_TARGETS } from './analysis.ts'

const request: PdfAiRequest = {
  literature_id: 'paper', project_id: '', revision: 'old', model_key: 'model',
  kind: 'figure_explanation', module: 'all', page: 2, text: '', rect: [0.1, 0.2, 0.3, 0.4],
  client_action_id: 'action', client_attempt_id: 'attempt', instruction: '解释趋势',
  response_language: 'zh'
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

function stream(...events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  })
}

test('task subscription renders fragmented UTF-8 previews before its authoritative result', async () => {
  const snapshots: PdfAiTask[] = [
    { task_id: 'task', status: 'running', preview: { text: '解释中' } },
    { task_id: 'task', status: 'running', preview: { summary: { text: '', paper_type: 'study', contribution: { text: '贡献正在生成' }, claims: [], method: { text: '' }, limitations: { text: '' } } } },
    { task_id: 'task', status: 'running', preview: { pages: [{ page: 1, blocks: [{ source_text: 'source', translated_text: '译文', located: true }] }] } },
    { task_id: 'task', status: 'completed' }
  ]
  const bytes = new TextEncoder().encode(snapshots.map(task => `data: ${JSON.stringify(task)}\r\n\r\n`).join(''))
  const restore = installFetch(async (url, init) => {
    assert.ok(String(url).endsWith('/tasks/task/events'))
    assert.ok(init?.signal)
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  })
  try {
    const observed: PdfAiTask[] = []
    await subscribePdfAiTask('task', new AbortController().signal, task => observed.push(task))
    assert.deepEqual(observed, snapshots)
  } finally { restore() }
})

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`task subscription accepts an initial ${status} snapshot and ignores later frames`, async () => {
    const terminal = { task_id: 'task', status }
    const restore = installFetch(async () => stream(terminal, { task_id: 'task', status: 'running' }))
    try {
      const observed: PdfAiTask[] = []
      await subscribePdfAiTask('task', new AbortController().signal, task => observed.push(task))
      assert.deepEqual(observed, [terminal])
    } finally { restore() }
  })
}

for (const response of [
  () => stream({ task_id: 'task', status: 'running', preview: { text: 'Incomplete' } }),
  () => stream({ task_id: 'other', status: 'completed' }),
  () => stream({ task_id: 'task', status: 'unknown' }),
  () => new Response('data: invalid\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  () => new Response('data: {"task_id":"task","status":"completed"}\n\n', { headers: { 'content-type': 'application/json' } }),
  () => new Response('Unavailable', { status: 503 })
]) {
  test('task subscription rejects invalid or incomplete streams without reporting success', async () => {
    const restore = installFetch(async () => response())
    try {
      await assert.rejects(subscribePdfAiTask('task', new AbortController().signal, () => {}), PdfAiRequestError)
    } finally { restore() }
  })
}

test('aborted subscription does not publish a stale task snapshot', async () => {
  const controller = new AbortController()
  const restore = installFetch(async () => {
    controller.abort()
    return stream({ task_id: 'task', status: 'completed' })
  })
  try {
    await subscribePdfAiTask('task', controller.signal, () => assert.fail('stale snapshot'))
  } finally { restore() }
})

test('PDF response language follows the supported interface locale', () => {
  assert.equal(pdfResponseLanguage('en'), 'en')
  assert.equal(pdfResponseLanguage('en-US'), 'en')
  assert.equal(pdfResponseLanguage('zh-CN'), 'zh')
  assert.equal(pdfResponseLanguage(undefined), 'zh')
})

test('PDF AI reports a stable failure when the service returns non-JSON', async () => {
  const restore = installFetch(async () => new Response('Internal Server Error', { status: 500 }))
  try {
    await assert.rejects(
      pdfAiApi('/api/literature/ai/tasks', {}),
      (error: unknown) => error instanceof PdfAiRequestError
        && error.code === 'pdf_ai_invalid_response'
        && error.diagnostic === 'HTTP 500'
    )
  } finally { restore() }
})

test('figure invocation streams crop and markdown before authoritative result', async () => {
  const restore = installFetch(async () => stream(
    {
      type: 'prepared', source_id: 'paper', source_revision: 'revision', title: 'Paper',
      page: 2, rect: request.rect, crop: 'data:image/png;base64,crop'
    },
    { type: 'accepted', invocation_id: 'invocation', text: '', item_id: '' },
    { type: 'output_delta', invocation_id: 'invocation', text: '趋势上升', item_id: 'answer' },
    {
      type: 'result', result: {
        task_id: 'invocation', invocation_id: 'invocation', status: 'completed',
        output: '趋势上升，后期趋稳。', model_key: 'model', error_code: '', error_detail: '',
        source_id: 'paper', source_revision: 'revision', title: 'Paper', page: 2,
        rect: request.rect, crop: 'data:image/png;base64,crop'
      }
    }
  ))
  try {
    const previews: { crop: string; text: string }[] = []
    const result = await invokeFigure(
      request,
      new AbortController().signal,
      preview => previews.push(preview)
    )
    assert.deepEqual(previews, [
      { crop: 'data:image/png;base64,crop', text: '' },
      { crop: 'data:image/png;base64,crop', text: '趋势上升' }
    ])
    assert.equal(result.text, '趋势上升，后期趋稳。')
    assert.equal(result.revision, 'revision')
    assert.equal(result.crop, 'data:image/png;base64,crop')
  } finally { restore() }
})

test('PDF translation exposes only the supported target languages', () => {
  assert.deepEqual(PDF_TRANSLATION_TARGETS, ASSISTANT_TRANSLATION_TARGETS)
})

test('PDF translation only exposes a searchable target-language control', () => {
  const control = readFileSync(new URL('./Translation.tsx', import.meta.url), 'utf8')
  const reading = readFileSync(new URL('./Reading.tsx', import.meta.url), 'utf8')

  assert.match(control, /TranslationTargetPicker/)
  assert.doesNotMatch(control, /translation\.auto|translation\.toEnglish|translation\.toChinese/)
  assert.doesNotMatch(reading, /\?\? 'auto'|selected !== 'auto'/)
})
